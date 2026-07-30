import ExpoModulesCore
import MultipeerConnectivity
import CryptoKit

private let serviceType = "manasplit-mesh"
private let controlPrefix = "manasplit-control-v1"
private let pairingPrefix = "manasplit-pair-v1|"
private let attachmentResourcePrefix = "msb1"
private let attachmentProtocolLabel = "manasplit-attachment-v1"

private func safeTransferId(_ value: String) -> Bool {
  guard !value.isEmpty, value.utf8.count <= 80 else { return false }
  return value.unicodeScalars.allSatisfy {
    CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "_"
  }
}

private func fileURL(from value: String) -> URL {
  if let url = URL(string: value), url.isFileURL {
    return url
  }
  return URL(fileURLWithPath: value)
}

private func sha256Hex(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private func attachmentNonce(seed: Data, chunkIndex: Int) throws -> AES.GCM.Nonce {
  guard seed.count == 8, chunkIndex >= 0, chunkIndex <= Int(UInt32.max) else {
    throw NSError(
      domain: "SplitCircleMesh",
      code: 20,
      userInfo: [NSLocalizedDescriptionKey: "Invalid nearby attachment nonce"]
    )
  }
  var index = UInt32(chunkIndex).bigEndian
  var nonceData = seed
  withUnsafeBytes(of: &index) { nonceData.append(contentsOf: $0) }
  return try AES.GCM.Nonce(data: nonceData)
}

private func attachmentAAD(transferId: String, chunkIndex: Int, chunkCount: Int) -> Data {
  Data("\(attachmentProtocolLabel)|\(transferId)|\(chunkIndex)|\(chunkCount)".utf8)
}

/// Keeps MultipeerConnectivity delegates out of the Expo module object and
/// serializes lifecycle changes on one queue. MCSession's required encryption
/// protects the radio link; JS additionally signs every application envelope
/// with the existing Signal identity so a nearby app cannot impersonate a
/// group member merely by claiming their uid.
private final class MeshController: NSObject,
  MCSessionDelegate,
  MCNearbyServiceAdvertiserDelegate,
  MCNearbyServiceBrowserDelegate
{
  private let queue = DispatchQueue(label: "com.splitcircle.app.mesh")
  private var localPeer: MCPeerID?
  private var session: MCSession?
  private var advertiser: MCNearbyServiceAdvertiser?
  private var browser: MCNearbyServiceBrowser?
  private var running = false
  private var trustedDeviceIds = Set<String>()
  private var pairingEnabled = false
  private var pairingPeerNames = Set<String>()
  private var ignoredPeerNames = Set<String>()
  private var discoveredPeerNames = Set<String>()
  private var connectingPeerNames = Set<String>()
  private var knownPeers: [String: MCPeerID] = [:]
  private var invitationTokens: [String: UUID] = [:]
  private var invitationRetryCounts: [String: Int] = [:]
  private var pendingProbes: [String: (peerName: String, startedAt: Date)] = [:]
  private var peerLatencyMs: [String: Int] = [:]
  private var lastError: NSError?
  private var resourceProgressObservations: [String: NSKeyValueObservation] = [:]
  private var resourceProgressTasks: [String: Progress] = [:]
  private var activeAttachmentSends = Set<String>()
  private var cancelledTransfers = Set<String>()
  private var peerReceivedAttachmentChunks: [String: Set<Int>] = [:]

  var onEnvelope: ((String, String) -> Void)?
  var onPeersChanged: ((Int) -> Void)?
  var onStateChanged: (([String: Any]) -> Void)?
  var onAttachmentEvent: (([String: Any]) -> Void)?

  private func normalizedTrustedDeviceIds(_ values: [String]) -> Set<String> {
    Set(values.lazy.filter {
      !$0.isEmpty && $0.utf8.count <= 63
    }.prefix(256))
  }

  /// MCSession resource/data callbacks arrive on a framework-owned queue while
  /// trust updates are serialized on `queue`. Never read the mutable Set (or
  /// current session pointer) concurrently.
  private func isCurrentTrustedSession(
    _ candidate: MCSession,
    peerID: MCPeerID
  ) -> Bool {
    queue.sync {
      session === candidate && trustedDeviceIds.contains(peerID.displayName)
    }
  }

  private func isCurrentAdmittedSession(
    _ candidate: MCSession,
    peerID: MCPeerID
  ) -> Bool {
    queue.sync {
      session === candidate
        && (
          trustedDeviceIds.contains(peerID.displayName)
            || (pairingEnabled && pairingPeerNames.contains(peerID.displayName))
        )
    }
  }

  private func discoveryInfo() -> [String: String] {
    [
      "v": "2",
      "access": pairingEnabled ? "pairing" : "known-devices",
    ]
  }

  func start(userId: String, deviceId: String, trustedDeviceIds: [String]) {
    queue.sync {
      stopLocked()
      pruneAttachmentStorageLocked()
      self.trustedDeviceIds = normalizedTrustedDeviceIds(trustedDeviceIds)

      // MCPeerID display names are limited to 63 UTF-8 bytes. Installation ids
      // are UUID-shaped and stable, giving every device a deterministic,
      // collision-resistant discovery identity without exposing a profile name.
      let compactDeviceId = String(deviceId.prefix(48))
      let peer = MCPeerID(displayName: compactDeviceId)
      let createdSession = MCSession(
        peer: peer,
        securityIdentity: nil,
        encryptionPreference: .required
      )
      createdSession.delegate = self

      let createdAdvertiser = MCNearbyServiceAdvertiser(
        peer: peer,
        discoveryInfo: discoveryInfo(),
        serviceType: serviceType
      )
      createdAdvertiser.delegate = self

      let createdBrowser = MCNearbyServiceBrowser(peer: peer, serviceType: serviceType)
      createdBrowser.delegate = self

      localPeer = peer
      session = createdSession
      advertiser = createdAdvertiser
      browser = createdBrowser
      running = true
      ignoredPeerNames.removeAll()
      pairingEnabled = false
      pairingPeerNames.removeAll()
      discoveredPeerNames.removeAll()
      connectingPeerNames.removeAll()
      knownPeers.removeAll()
      invitationTokens.removeAll()
      invitationRetryCounts.removeAll()
      pendingProbes.removeAll()
      peerLatencyMs.removeAll()
      lastError = nil
      createdAdvertiser.startAdvertisingPeer()
      createdBrowser.startBrowsingForPeers()
      emitState()
    }
  }

  func stop() {
    queue.sync { stopLocked() }
  }

  private func stopLocked() {
    guard running || session != nil else { return }
    advertiser?.stopAdvertisingPeer()
    browser?.stopBrowsingForPeers()
    session?.disconnect()
    advertiser?.delegate = nil
    browser?.delegate = nil
    session?.delegate = nil
    advertiser = nil
    browser = nil
    session = nil
    localPeer = nil
    running = false
    trustedDeviceIds.removeAll()
    pairingEnabled = false
    pairingPeerNames.removeAll()
    ignoredPeerNames.removeAll()
    discoveredPeerNames.removeAll()
    connectingPeerNames.removeAll()
    knownPeers.removeAll()
    invitationTokens.removeAll()
    invitationRetryCounts.removeAll()
    pendingProbes.removeAll()
    peerLatencyMs.removeAll()
    resourceProgressObservations.values.forEach { $0.invalidate() }
    resourceProgressObservations.removeAll()
    resourceProgressTasks.values.forEach { $0.cancel() }
    resourceProgressTasks.removeAll()
    activeAttachmentSends.removeAll()
    cancelledTransfers.removeAll()
    peerReceivedAttachmentChunks.removeAll()
    lastError = nil
    emitPeerCount(0)
    emitState()
  }

  func updateTrustedPeers(_ deviceIds: [String]) {
    queue.sync {
      guard running else {
        trustedDeviceIds = normalizedTrustedDeviceIds(deviceIds)
        return
      }
      let next = normalizedTrustedDeviceIds(deviceIds)
      let addedTrust = !next.subtracting(trustedDeviceIds).isEmpty
      let promotedConnectedPair = session?.connectedPeers.contains(where: {
        next.contains($0.displayName) && pairingPeerNames.contains($0.displayName)
      }) == true
      let connectedUntrusted = session?.connectedPeers.contains(where: {
        !next.contains($0.displayName)
      }) == true
      trustedDeviceIds = next
      pairingPeerNames.subtract(next)
      ignoredPeerNames.subtract(next)
      discoveredPeerNames = discoveredPeerNames.intersection(next)
      connectingPeerNames = connectingPeerNames.intersection(next)
      knownPeers = knownPeers.filter { next.contains($0.key) }
      invitationTokens = invitationTokens.filter { next.contains($0.key) }
      invitationRetryCounts = invitationRetryCounts.filter { next.contains($0.key) }
      peerLatencyMs = peerLatencyMs.filter { next.contains($0.key) }
      pendingProbes = pendingProbes.filter { next.contains($0.value.peerName) }

      // MCSession cannot selectively evict an already-connected peer. A trust
      // revocation therefore replaces the carrier session immediately.
      //
      // Also restart discovery when trust expands. Multipeer may not emit a
      // second foundPeer callback for a radio that was ignored before its
      // cached identity became available.
      if connectedUntrusted || (addedTrust && !promotedConnectedPair) {
        rebuildTransportLocked()
      } else {
        for peer in knownPeers.values {
          beginInvitation(to: peer)
        }
      }
      emitState()
    }
  }

  func setPairingMode(_ enabled: Bool) {
    queue.sync {
      guard pairingEnabled != enabled else { return }
      pairingEnabled = enabled
      if !enabled {
        pairingPeerNames.removeAll()
      }
      // Discovery metadata is immutable for an advertiser. Rebuilding also
      // guarantees that a quarantined pairing session cannot survive after
      // the short user-authorized window closes.
      if running {
        rebuildTransportLocked()
      }
      emitState()
    }
  }

  func connectedPeerCount() -> Int {
    queue.sync { session?.connectedPeers.count ?? 0 }
  }

  /// Replaces a potentially poisoned MCSession while preserving the active
  /// browser's discovered MCPeerID objects. On iOS 26/27 an invitation may
  /// remain in `.connecting` indefinitely; cancelConnectPeer alone does not
  /// reliably make that session reusable.
  @discardableResult
  private func replaceSessionLocked() -> MCSession? {
    guard let localPeer else { return nil }

    session?.delegate = nil
    session?.disconnect()

    let replacement = MCSession(
      peer: localPeer,
      securityIdentity: nil,
      encryptionPreference: .required
    )
    replacement.delegate = self
    session = replacement
    connectingPeerNames.removeAll()
    invitationTokens.removeAll()
    pendingProbes.removeAll()
    peerLatencyMs.removeAll()
    emitPeerCount(0)
    return replacement
  }

  /// A user-initiated scan is a full transport reset, not only a Bonjour
  /// browse restart. Reusing a session that already stalled in `.connecting`
  /// was the reason repeated scans could loop for several minutes.
  private func rebuildTransportLocked() {
    guard let localPeer else { return }

    advertiser?.stopAdvertisingPeer()
    browser?.stopBrowsingForPeers()
    advertiser?.delegate = nil
    browser?.delegate = nil

    _ = replaceSessionLocked()

    let replacementAdvertiser = MCNearbyServiceAdvertiser(
      peer: localPeer,
      discoveryInfo: discoveryInfo(),
      serviceType: serviceType
    )
    replacementAdvertiser.delegate = self
    let replacementBrowser = MCNearbyServiceBrowser(
      peer: localPeer,
      serviceType: serviceType
    )
    replacementBrowser.delegate = self

    advertiser = replacementAdvertiser
    browser = replacementBrowser
    discoveredPeerNames.removeAll()
    pairingPeerNames.removeAll()
    knownPeers.removeAll()
    invitationRetryCounts.removeAll()
    lastError = nil
    replacementAdvertiser.startAdvertisingPeer()
    replacementBrowser.startBrowsingForPeers()
  }

  func restartDiscovery() {
    queue.sync {
      guard running else { return }
      rebuildTransportLocked()
      emitState()
    }
  }

  func send(_ envelope: String, recipientDeviceIds: [String]) throws -> Int {
    try queue.sync {
      guard let session else { return 0 }
      let recipients = Set(recipientDeviceIds)
      guard !recipients.isEmpty else { return 0 }
      let peers = session.connectedPeers.filter {
        trustedDeviceIds.contains($0.displayName)
          && recipients.contains($0.displayName)
      }
      guard !peers.isEmpty else { return 0 }
      guard let data = envelope.data(using: .utf8) else {
        throw NSError(
          domain: "SplitCircleMesh",
          code: 1,
          userInfo: [NSLocalizedDescriptionKey: "Envelope is not valid UTF-8"]
        )
      }
      try session.send(data, toPeers: peers, with: .reliable)
      return peers.count
    }
  }

  func sendPairing(_ envelope: String, recipientDeviceIds: [String]) throws -> Int {
    try queue.sync {
      guard pairingEnabled, let session else { return 0 }
      let recipients = Set(recipientDeviceIds)
      guard !recipients.isEmpty else { return 0 }
      let peers = session.connectedPeers.filter {
        pairingPeerNames.contains($0.displayName)
          && recipients.contains($0.displayName)
      }
      guard !peers.isEmpty else { return 0 }
      guard
        envelope.hasPrefix(pairingPrefix),
        let data = envelope.data(using: .utf8),
        data.count <= 32 * 1024
      else {
        throw NSError(
          domain: "SplitCircleMesh",
          code: 30,
          userInfo: [NSLocalizedDescriptionKey: "Invalid nearby pairing envelope"]
        )
      }
      try session.send(data, toPeers: peers, with: .reliable)
      return peers.count
    }
  }

  private func attachmentRoot(directory: String) throws -> URL {
    let fileManager = FileManager.default
    let applicationSupport = try fileManager.url(
      for: .applicationSupportDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    )
    let root = applicationSupport
      .appendingPathComponent("nearby_attachments", isDirectory: true)
      .appendingPathComponent(directory, isDirectory: true)
    try fileManager.createDirectory(
      at: root,
      withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
    )
    return root
  }

  private func transferDirectory(_ transferId: String, direction: String) throws -> URL {
    guard safeTransferId(transferId) else {
      throw NSError(
        domain: "SplitCircleMesh",
        code: 21,
        userInfo: [NSLocalizedDescriptionKey: "Invalid nearby attachment id"]
      )
    }
    let directory = try attachmentRoot(directory: direction)
      .appendingPathComponent(transferId, isDirectory: true)
    try FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
    )
    return directory
  }

  private func pruneAttachmentStorageLocked() {
    let cutoff = Date().addingTimeInterval(-7 * 24 * 60 * 60)
    for direction in ["incoming", "outgoing"] {
      guard
        let root = try? attachmentRoot(directory: direction),
        let directories = try? FileManager.default.contentsOfDirectory(
          at: root,
          includingPropertiesForKeys: [.contentModificationDateKey],
          options: [.skipsHiddenFiles]
        )
      else { continue }
      for directory in directories {
        let modified = try? directory.resourceValues(
          forKeys: [.contentModificationDateKey]
        ).contentModificationDate
        if modified == nil || modified! < cutoff {
          try? FileManager.default.removeItem(at: directory)
        }
      }
    }
  }

  private func discardAttachmentLocked(transferId: String) {
    guard safeTransferId(transferId) else { return }
    // A group attachment can finish its cloud relay while a nearby resource
    // stream is still open. Removing the source file underneath MCSession
    // turns a successful local delivery into a late failure. Defer cleanup
    // until every per-peer stream has released its source; the seven-day
    // startup prune remains the final safety net if the process exits first.
    if activeAttachmentSends.contains(where: {
      $0.hasPrefix("\(transferId)|")
    }) {
      queue.asyncAfter(deadline: .now() + 15) { [weak self] in
        self?.discardAttachmentLocked(transferId: transferId)
      }
      return
    }
    for direction in ["incoming", "outgoing"] {
      guard let directory = try? transferDirectory(
        transferId,
        direction: direction
      ) else { continue }
      try? FileManager.default.removeItem(at: directory)
    }
  }

  func discardAttachment(transferId: String) {
    queue.sync {
      discardAttachmentLocked(transferId: transferId)
    }
  }

  private func chunkURL(
    transferId: String,
    chunkIndex: Int,
    preferOutgoing: Bool
  ) throws -> URL {
    let directions = preferOutgoing ? ["outgoing", "incoming"] : ["incoming", "outgoing"]
    for direction in directions {
      let candidate = try transferDirectory(transferId, direction: direction)
        .appendingPathComponent("\(chunkIndex).chunk")
      if FileManager.default.fileExists(atPath: candidate.path) {
        return candidate
      }
    }
    throw NSError(
      domain: "SplitCircleMesh",
      code: 22,
      userInfo: [NSLocalizedDescriptionKey: "Nearby attachment chunk \(chunkIndex) is unavailable"]
    )
  }

  /// Encrypts a file in independently authenticated, disk-backed chunks.
  /// Neither plaintext bytes nor encrypted chunk bytes cross the React Native
  /// bridge. Only the small manifest and Signal-wrapped key material do.
  func prepareAttachment(
    sourceUri: String,
    transferId: String,
    requestedChunkSize: Int
  ) throws -> [String: Any] {
    guard safeTransferId(transferId) else {
      throw NSError(
        domain: "SplitCircleMesh",
        code: 23,
        userInfo: [NSLocalizedDescriptionKey: "Invalid nearby attachment id"]
      )
    }
    let chunkSize = min(max(requestedChunkSize, 64 * 1024), 4 * 1024 * 1024)
    let source = fileURL(from: sourceUri)
    let values = try source.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
    guard
      values.isRegularFile == true,
      let fileSize = values.fileSize,
      fileSize >= 0,
      fileSize <= 100 * 1024 * 1024
    else {
      throw NSError(
        domain: "SplitCircleMesh",
        code: 24,
        userInfo: [NSLocalizedDescriptionKey: "The selected attachment is not a readable file"]
      )
    }

    let chunkCount = max(1, Int(ceil(Double(fileSize) / Double(chunkSize))))
    let key = SymmetricKey(size: .bits256)
    let keyData = key.withUnsafeBytes { Data($0) }
    var nonceSeed = Data(count: 8)
    let randomStatus = nonceSeed.withUnsafeMutableBytes {
      SecRandomCopyBytes(kSecRandomDefault, 8, $0.baseAddress!)
    }
    guard randomStatus == errSecSuccess else {
      throw NSError(
        domain: "SplitCircleMesh",
        code: 25,
        userInfo: [NSLocalizedDescriptionKey: "Could not create attachment encryption material"]
      )
    }

    let outputDirectory = try transferDirectory(transferId, direction: "outgoing")
    let fileManager = FileManager.default
    try fileManager.contentsOfDirectory(at: outputDirectory, includingPropertiesForKeys: nil)
      .forEach { try fileManager.removeItem(at: $0) }

    let input = try FileHandle(forReadingFrom: source)
    defer { try? input.close() }
    var hashes: [String] = []
    var encryptedSizes: [Int] = []

    for index in 0..<chunkCount {
      let plaintext = try input.read(upToCount: chunkSize) ?? Data()
      let nonce = try attachmentNonce(seed: nonceSeed, chunkIndex: index)
      let sealed = try AES.GCM.seal(
        plaintext,
        using: key,
        nonce: nonce,
        authenticating: attachmentAAD(
          transferId: transferId,
          chunkIndex: index,
          chunkCount: chunkCount
        )
      )
      var encrypted = sealed.ciphertext
      encrypted.append(sealed.tag)
      let output = outputDirectory.appendingPathComponent("\(index).chunk")
      try encrypted.write(
        to: output,
        options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
      )
      hashes.append(sha256Hex(encrypted))
      encryptedSizes.append(encrypted.count)
    }

    return [
      "transferId": transferId,
      "fileSize": fileSize,
      "chunkSize": chunkSize,
      "chunkCount": chunkCount,
      "chunkHashes": hashes,
      "encryptedChunkSizes": encryptedSizes,
      "keyBase64": keyData.base64EncodedString(),
      "nonceSeedBase64": nonceSeed.base64EncodedString(),
    ]
  }

  private func attachmentSendKey(transferId: String, peerName: String) -> String {
    "\(transferId)|\(peerName)"
  }

  private func resourceObservationKey(
    transferId: String,
    peerName: String,
    chunkIndex: Int
  ) -> String {
    "\(transferId)|\(peerName)|\(chunkIndex)"
  }

  private func emitAttachment(_ payload: [String: Any]) {
    DispatchQueue.main.async { [weak self] in self?.onAttachmentEvent?(payload) }
  }

  private func sendAttachmentChunk(
    transferId: String,
    chunkIndex: Int,
    chunkCount: Int,
    peer: MCPeerID
  ) {
    let sendKey = attachmentSendKey(transferId: transferId, peerName: peer.displayName)
    guard
      running,
      cancelledTransfers.contains(transferId) == false,
      let session,
      session.connectedPeers.contains(peer)
    else {
      activeAttachmentSends.remove(sendKey)
      emitAttachment([
        "direction": "outgoing",
        "state": "failed",
        "transferId": transferId,
        "peerDeviceId": peer.displayName,
        "errorMessage": "The nearby phone disconnected.",
      ])
      return
    }

    var nextChunkIndex = chunkIndex
    let alreadyReceived = peerReceivedAttachmentChunks[sendKey] ?? []
    while nextChunkIndex < chunkCount && alreadyReceived.contains(nextChunkIndex) {
      nextChunkIndex += 1
    }

    if nextChunkIndex >= chunkCount {
      activeAttachmentSends.remove(sendKey)
      peerReceivedAttachmentChunks.removeValue(forKey: sendKey)
      emitAttachment([
        "direction": "outgoing",
        "state": "completed",
        "transferId": transferId,
        "peerDeviceId": peer.displayName,
        "fraction": 1.0,
      ])
      return
    }

    let chunk: URL
    do {
      chunk = try chunkURL(
        transferId: transferId,
        chunkIndex: nextChunkIndex,
        preferOutgoing: true
      )
    } catch {
      activeAttachmentSends.remove(sendKey)
      emitAttachment([
        "direction": "outgoing",
        "state": "failed",
        "transferId": transferId,
        "peerDeviceId": peer.displayName,
        "errorMessage": error.localizedDescription,
      ])
      return
    }

    let name = "\(attachmentResourcePrefix).\(transferId).\(nextChunkIndex).\(chunkCount)"
    let observationKey = resourceObservationKey(
      transferId: transferId,
      peerName: peer.displayName,
      chunkIndex: nextChunkIndex
    )
    let progress = session.sendResource(
      at: chunk,
      withName: name,
      toPeer: peer
    ) { [weak self] error in
      guard let self else { return }
      self.queue.async {
        self.resourceProgressObservations.removeValue(forKey: observationKey)?.invalidate()
        self.resourceProgressTasks.removeValue(forKey: observationKey)
        guard self.cancelledTransfers.contains(transferId) == false else {
          self.activeAttachmentSends.remove(sendKey)
          return
        }
        if let error {
          self.activeAttachmentSends.remove(sendKey)
          self.emitAttachment([
            "direction": "outgoing",
            "state": "failed",
            "transferId": transferId,
            "peerDeviceId": peer.displayName,
            "errorMessage": error.localizedDescription,
          ])
          return
        }
        self.sendAttachmentChunk(
          transferId: transferId,
          chunkIndex: nextChunkIndex + 1,
          chunkCount: chunkCount,
          peer: peer
        )
      }
    }
    guard let progress else {
      activeAttachmentSends.remove(sendKey)
      emitAttachment([
        "direction": "outgoing",
        "state": "failed",
        "transferId": transferId,
        "peerDeviceId": peer.displayName,
        "errorMessage": "The nearby resource stream could not be started.",
      ])
      return
    }
    resourceProgressObservations[observationKey] = progress.observe(
      \.fractionCompleted,
      options: [.new]
    ) { [weak self] progress, _ in
      let overall = (Double(nextChunkIndex) + progress.fractionCompleted) / Double(chunkCount)
      self?.emitAttachment([
        "direction": "outgoing",
        "state": "progress",
        "transferId": transferId,
        "peerDeviceId": peer.displayName,
        "chunkIndex": nextChunkIndex,
        "chunkCount": chunkCount,
        "fraction": max(0, min(1, overall)),
      ])
    }
    resourceProgressTasks[observationKey] = progress
  }

  /// Starts one sequential resource stream per currently connected peer.
  /// A per-peer guard prevents topology replay from starting duplicate sends.
  func sendPreparedAttachment(
    transferId: String,
    chunkCount: Int,
    recipientDeviceIds: [String]
  ) -> Int {
    queue.sync {
      let recipients = Set(recipientDeviceIds)
      guard
        safeTransferId(transferId),
        chunkCount > 0,
        !recipients.isEmpty,
        let connectedPeers = session?.connectedPeers,
        !connectedPeers.isEmpty
      else { return 0 }
      let peers = connectedPeers.filter {
        trustedDeviceIds.contains($0.displayName)
          && recipients.contains($0.displayName)
      }
      guard
        !peers.isEmpty
      else { return 0 }

      cancelledTransfers.remove(transferId)
      var started = 0
      for peer in peers {
        let key = attachmentSendKey(transferId: transferId, peerName: peer.displayName)
        guard activeAttachmentSends.insert(key).inserted else { continue }
        started += 1
        emitAttachment([
          "direction": "outgoing",
          "state": "progress",
          "transferId": transferId,
          "peerDeviceId": peer.displayName,
          "fraction": 0.0,
        ])
        sendAttachmentChunk(
          transferId: transferId,
          chunkIndex: 0,
          chunkCount: chunkCount,
          peer: peer
        )
      }
      return started
    }
  }

  func cancelAttachment(transferId: String) {
    queue.sync {
      cancelledTransfers.insert(transferId)
      let prefixes = resourceProgressObservations.keys.filter {
        $0.hasPrefix("\(transferId)|")
      }
      prefixes.forEach {
        resourceProgressObservations.removeValue(forKey: $0)?.invalidate()
        resourceProgressTasks.removeValue(forKey: $0)?.cancel()
      }
      activeAttachmentSends = activeAttachmentSends.filter {
        !$0.hasPrefix("\(transferId)|")
      }
      if let outgoing = try? transferDirectory(transferId, direction: "outgoing") {
        try? FileManager.default.removeItem(at: outgoing)
      }
      emitAttachment([
        "direction": "outgoing",
        "state": "cancelled",
        "transferId": transferId,
      ])
    }
  }

  func receivedChunkIndexes(transferId: String) throws -> [Int] {
    let directory = try transferDirectory(transferId, direction: "incoming")
    return try FileManager.default.contentsOfDirectory(
      at: directory,
      includingPropertiesForKeys: nil
    ).compactMap { Int($0.deletingPathExtension().lastPathComponent) }.sorted()
  }

  /// Tells the origin which authenticated encrypted chunks survived an
  /// interruption. This is only an optimization: a peer can falsely claim it
  /// has a chunk only to deprive itself, while the final signed manifest hashes
  /// and AES-GCM authentication still decide whether a file can commit.
  func announceReceivedChunks(
    transferId: String,
    chunkIndexes: [Int],
    originDeviceId: String
  ) -> Bool {
    queue.sync {
      guard
        safeTransferId(transferId),
        let session,
        let peer = session.connectedPeers.first(where: {
          $0.displayName == originDeviceId
        })
      else { return false }
      let normalized = Array(Set(chunkIndexes.filter {
        $0 >= 0 && $0 <= 1_600
      })).sorted()
      let csv = normalized.map(String.init).joined(separator: ",")
      let frame = "\(controlPrefix)|have|\(transferId)|\(csv)"
      guard let data = frame.data(using: .utf8), data.count <= 16 * 1024 else {
        return false
      }
      do {
        try session.send(data, toPeers: [peer], with: .reliable)
        return true
      } catch {
        return false
      }
    }
  }

  /// Verifies every encrypted chunk, authenticates/decrypts it, then atomically
  /// publishes the plaintext file into the app's permanent local-media path.
  func decryptReceivedAttachment(
    transferId: String,
    destinationUri: String,
    keyBase64: String,
    nonceSeedBase64: String,
    chunkHashes: [String],
    chunkCount: Int
  ) throws -> String {
    guard
      safeTransferId(transferId),
      chunkCount > 0,
      chunkHashes.count == chunkCount,
      let keyData = Data(base64Encoded: keyBase64),
      keyData.count == 32,
      let nonceSeed = Data(base64Encoded: nonceSeedBase64),
      nonceSeed.count == 8
    else {
      throw NSError(
        domain: "SplitCircleMesh",
        code: 26,
        userInfo: [NSLocalizedDescriptionKey: "Invalid nearby attachment manifest"]
      )
    }

    let destination = fileURL(from: destinationUri)
    let parent = destination.deletingLastPathComponent()
    try FileManager.default.createDirectory(
      at: parent,
      withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
    )
    let temporary = parent.appendingPathComponent(".\(UUID().uuidString).nearby-part")
    FileManager.default.createFile(
      atPath: temporary.path,
      contents: nil,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
    )
    let output = try FileHandle(forWritingTo: temporary)
    var succeeded = false
    defer {
      try? output.close()
      if !succeeded { try? FileManager.default.removeItem(at: temporary) }
    }

    let key = SymmetricKey(data: keyData)
    for index in 0..<chunkCount {
      let encrypted = try Data(contentsOf: chunkURL(
        transferId: transferId,
        chunkIndex: index,
        preferOutgoing: false
      ))
      guard
        encrypted.count >= 16,
        sha256Hex(encrypted).lowercased() == chunkHashes[index].lowercased()
      else {
        throw NSError(
          domain: "SplitCircleMesh",
          code: 27,
          userInfo: [NSLocalizedDescriptionKey: "Nearby attachment integrity check failed"]
        )
      }
      let tagStart = encrypted.count - 16
      let sealed = try AES.GCM.SealedBox(
        nonce: attachmentNonce(seed: nonceSeed, chunkIndex: index),
        ciphertext: encrypted.prefix(tagStart),
        tag: encrypted.suffix(16)
      )
      let plaintext = try AES.GCM.open(
        sealed,
        using: key,
        authenticating: attachmentAAD(
          transferId: transferId,
          chunkIndex: index,
          chunkCount: chunkCount
        )
      )
      try output.write(contentsOf: plaintext)
    }
    try output.synchronize()
    try output.close()
    if FileManager.default.fileExists(atPath: destination.path) {
      try FileManager.default.removeItem(at: destination)
    }
    try FileManager.default.moveItem(at: temporary, to: destination)
    succeeded = true
    return destination.absoluteString
  }

  /// Sends a native control-frame round trip to prove that a selected peer is
  /// still reachable. Control frames never enter the JS message protocol.
  func probePeer(deviceId: String) -> Bool {
    queue.sync {
      guard
        running,
        let session,
        let peer = session.connectedPeers.first(where: { $0.displayName == deviceId })
      else { return false }

      let probeId = UUID().uuidString
      pendingProbes[probeId] = (peer.displayName, Date())
      let frame = "\(controlPrefix)|ping|\(probeId)"
      guard let data = frame.data(using: .utf8) else {
        pendingProbes.removeValue(forKey: probeId)
        return false
      }

      do {
        try session.send(data, toPeers: [peer], with: .reliable)
        emitState()
      } catch {
        pendingProbes.removeValue(forKey: probeId)
        emitState()
        return false
      }

      queue.asyncAfter(deadline: .now() + 5) { [weak self] in
        guard let self, self.pendingProbes.removeValue(forKey: probeId) != nil else {
          return
        }
        self.emitState()
      }
      return true
    }
  }

  private func emitPeerCount(_ count: Int? = nil) {
    let resolved = count ?? session?.connectedPeers.filter {
      trustedDeviceIds.contains($0.displayName)
    }.count ?? 0
    DispatchQueue.main.async { [weak self] in self?.onPeersChanged?(resolved) }
  }

  private func emitState() {
    let allConnectedNames = Set(session?.connectedPeers.map(\.displayName) ?? [])
    let connectedNames = allConnectedNames.intersection(trustedDeviceIds)
    let connectedPairingNames = allConnectedNames
      .intersection(pairingPeerNames)
      .subtracting(trustedDeviceIds)
    connectingPeerNames.subtract(connectedNames)
    let trustedConnectingNames = connectingPeerNames.intersection(trustedDeviceIds)

    let status: String
    if lastError != nil {
      status = "error"
    } else if !connectedNames.isEmpty {
      status = "connected"
    } else if !connectingPeerNames.isEmpty || !connectedPairingNames.isEmpty {
      status = "connecting"
    } else if running {
      status = "searching"
    } else {
      status = "idle"
    }

    var payload: [String: Any] = [
      "status": status,
      "connectedPeerCount": connectedNames.count,
      "discoveredPeerCount": discoveredPeerNames.count,
      "connectingPeerCount": trustedConnectingNames.count,
      "discoveredDeviceIds": Array(discoveredPeerNames).sorted(),
      "connectingDeviceIds": Array(trustedConnectingNames).sorted(),
      "connectedDeviceIds": Array(connectedNames).sorted(),
      "pairingDeviceIds": Array(connectedPairingNames).sorted(),
      "pairingEnabled": pairingEnabled,
      "probingDeviceIds": Array(Set(pendingProbes.values.map(\.peerName))).sorted(),
      "peerLatencyMs": peerLatencyMs,
      "ignoredPeerCount": ignoredPeerNames.count,
    ]
    if let lastError {
      payload["errorCode"] = lastError.code
      payload["errorMessage"] = lastError.localizedDescription
    }
    DispatchQueue.main.async { [weak self] in self?.onStateChanged?(payload) }
  }

  /// MultipeerConnectivity already enables Apple peer-to-peer Wi-Fi, so an
  /// access point or Personal Hotspot is not required. On recent iOS releases
  /// an invitation can occasionally remain in `.connecting` forever, though.
  /// Bound every attempt and re-invite with exponential backoff so a direct
  /// radio link can recover without burning the radios in a tight loop.
  private func beginInvitation(to peerID: MCPeerID) {
    let peerName = peerID.displayName
    guard
      running,
      invitationTokens[peerName] == nil,
      let localPeer,
      localPeer.displayName < peerName,
      let browser,
      let session,
      !session.connectedPeers.contains(peerID)
    else { return }

    connectingPeerNames.insert(peerName)
    let token = UUID()
    invitationTokens[peerName] = token
    let invitationContext = pairingPeerNames.contains(peerName)
      ? Data("manasplit-pairing-v1".utf8)
      : nil
    browser.invitePeer(
      peerID,
      to: session,
      withContext: invitationContext,
      timeout: 12
    )
    emitState()

    queue.asyncAfter(deadline: .now() + 15) { [weak self] in
      guard let self, self.running, self.invitationTokens[peerName] == token else {
        return
      }
      self.invitationTokens.removeValue(forKey: peerName)
      if self.session?.connectedPeers.contains(peerID) == true {
        self.connectingPeerNames.remove(peerName)
        self.invitationRetryCounts.removeValue(forKey: peerName)
        self.emitState()
        return
      }

      self.session?.cancelConnectPeer(peerID)
      // A timed-out MCSession can remain internally wedged even after
      // cancelConnectPeer. Retry the discovered peer on a new encrypted
      // session rather than carrying that hidden state into every backoff.
      _ = self.replaceSessionLocked()
      self.connectingPeerNames.remove(peerName)
      let retryCount = (self.invitationRetryCounts[peerName] ?? 0) + 1
      self.invitationRetryCounts[peerName] = retryCount
      self.emitState()

      let backoff: TimeInterval = [2, 4, 8, 16, 32, 60][min(retryCount - 1, 5)]
      self.queue.asyncAfter(deadline: .now() + backoff) { [weak self] in
        guard
          let self,
          self.running,
          self.knownPeers[peerName] != nil,
          self.session?.connectedPeers.contains(peerID) != true
        else { return }
        self.beginInvitation(to: peerID)
      }
    }
  }

  // Only the lexicographically smaller peer invites. This prevents both sides
  // racing invitations for the same session while preserving deterministic
  // connection establishment.
  func browser(
    _ browser: MCNearbyServiceBrowser,
    foundPeer peerID: MCPeerID,
    withDiscoveryInfo info: [String : String]?
  ) {
    queue.async {
      guard info?["v"] == "2" else {
        self.ignoredPeerNames.insert(peerID.displayName)
        self.emitState()
        return
      }
      let trusted = self.trustedDeviceIds.contains(peerID.displayName)
      let pairable = self.pairingEnabled && info?["access"] == "pairing"
      guard trusted || pairable else {
        self.ignoredPeerNames.insert(peerID.displayName)
        self.emitState()
        return
      }
      self.ignoredPeerNames.remove(peerID.displayName)
      if trusted {
        self.discoveredPeerNames.insert(peerID.displayName)
      } else {
        self.pairingPeerNames.insert(peerID.displayName)
      }
      self.knownPeers[peerID.displayName] = peerID
      self.beginInvitation(to: peerID)
      self.emitState()
    }
  }

  func browser(_ browser: MCNearbyServiceBrowser, lostPeer peerID: MCPeerID) {
    queue.async {
      self.ignoredPeerNames.remove(peerID.displayName)
      self.discoveredPeerNames.remove(peerID.displayName)
      self.pairingPeerNames.remove(peerID.displayName)
      self.connectingPeerNames.remove(peerID.displayName)
      self.knownPeers.removeValue(forKey: peerID.displayName)
      self.invitationTokens.removeValue(forKey: peerID.displayName)
      self.invitationRetryCounts.removeValue(forKey: peerID.displayName)
      self.peerLatencyMs.removeValue(forKey: peerID.displayName)
      self.pendingProbes = self.pendingProbes.filter { $0.value.peerName != peerID.displayName }
      self.emitState()
    }
  }

  func advertiser(
    _ advertiser: MCNearbyServiceAdvertiser,
    didReceiveInvitationFromPeer peerID: MCPeerID,
    withContext context: Data?,
    invitationHandler: @escaping (Bool, MCSession?) -> Void
  ) {
    queue.async {
      let pairingInvitation = context == Data("manasplit-pairing-v1".utf8)
      if self.pairingEnabled && pairingInvitation {
        self.pairingPeerNames.insert(peerID.displayName)
        self.knownPeers[peerID.displayName] = peerID
        self.ignoredPeerNames.remove(peerID.displayName)
      }
      let admitted = self.trustedDeviceIds.contains(peerID.displayName)
        || (self.pairingEnabled && self.pairingPeerNames.contains(peerID.displayName))
      guard self.running, admitted else {
        self.ignoredPeerNames.insert(peerID.displayName)
        self.emitState()
        invitationHandler(false, nil)
        return
      }

      // If there is no established mesh yet, always accept an invitation on a
      // clean session. This clears a receiver-side handshake that never
      // emitted `.notConnected`, matching the asymmetric Found/Securing state
      // seen on the two test phones.
      let acceptingSession: MCSession?
      if self.session?.connectedPeers.isEmpty != false {
        acceptingSession = self.replaceSessionLocked()
      } else {
        acceptingSession = self.session
      }
      self.connectingPeerNames.insert(peerID.displayName)
      self.emitState()
      invitationHandler(acceptingSession != nil, acceptingSession)
    }
  }

  func session(
    _ session: MCSession,
    peer peerID: MCPeerID,
    didChange state: MCSessionState
  ) {
    queue.async {
      guard self.session === session else { return }
      let admitted = self.trustedDeviceIds.contains(peerID.displayName)
        || (self.pairingEnabled && self.pairingPeerNames.contains(peerID.displayName))
      guard admitted else {
        self.ignoredPeerNames.insert(peerID.displayName)
        if state != .notConnected {
          session.cancelConnectPeer(peerID)
        }
        self.emitPeerCount()
        self.emitState()
        return
      }
      switch state {
      case .connecting:
        self.connectingPeerNames.insert(peerID.displayName)
      case .connected:
        if self.trustedDeviceIds.contains(peerID.displayName) {
          self.discoveredPeerNames.insert(peerID.displayName)
        }
        self.connectingPeerNames.remove(peerID.displayName)
        self.invitationTokens.removeValue(forKey: peerID.displayName)
        self.invitationRetryCounts.removeValue(forKey: peerID.displayName)
        self.lastError = nil
      case .notConnected:
        self.connectingPeerNames.remove(peerID.displayName)
        self.peerLatencyMs.removeValue(forKey: peerID.displayName)
        self.pendingProbes = self.pendingProbes.filter { $0.value.peerName != peerID.displayName }
      @unknown default:
        self.connectingPeerNames.remove(peerID.displayName)
      }
      self.emitPeerCount()
      self.emitState()
    }
  }

  func session(
    _ session: MCSession,
    didReceive data: Data,
    fromPeer peerID: MCPeerID
  ) {
    guard isCurrentAdmittedSession(session, peerID: peerID) else { return }
    guard let envelope = String(data: data, encoding: .utf8) else { return }

    let trusted = isCurrentTrustedSession(session, peerID: peerID)
    if !trusted {
      // Quarantined peers get one tiny control lane and nothing else. They
      // cannot inject chat envelopes, request attachment chunks, or probe the
      // normal carrier until the signed code ceremony promotes their exact
      // device identity into the durable trust set.
      guard
        envelope.hasPrefix(pairingPrefix),
        data.count <= 32 * 1024
      else { return }
      DispatchQueue.main.async { [weak self] in
        self?.onEnvelope?(envelope, peerID.displayName)
      }
      return
    }

    let components = envelope.split(separator: "|", omittingEmptySubsequences: false)
    if components.count == 4,
       components[0] == Substring(controlPrefix),
       components[1] == "have" {
      let transferId = String(components[2])
      guard safeTransferId(transferId) else { return }
      let indexes = Set(components[3].split(separator: ",").compactMap {
        Int($0)
      }.filter { $0 >= 0 && $0 <= 1_600 })
      queue.async {
        let key = self.attachmentSendKey(
          transferId: transferId,
          peerName: peerID.displayName
        )
        self.peerReceivedAttachmentChunks[key] = indexes
      }
      return
    }

    if components.count == 3, components[0] == Substring(controlPrefix) {
      let kind = String(components[1])
      let probeId = String(components[2])
      if kind == "ping" {
        guard let response = "\(controlPrefix)|pong|\(probeId)".data(using: .utf8) else {
          return
        }
        try? session.send(response, toPeers: [peerID], with: .reliable)
        return
      }
      if kind == "pong" {
        queue.async {
          guard
            let pending = self.pendingProbes.removeValue(forKey: probeId),
            pending.peerName == peerID.displayName
          else { return }
          let elapsed = max(1, Int(Date().timeIntervalSince(pending.startedAt) * 1_000))
          self.peerLatencyMs[peerID.displayName] = elapsed
          self.emitState()
        }
        return
      }
    }

    DispatchQueue.main.async { [weak self] in
      self?.onEnvelope?(envelope, peerID.displayName)
    }
  }

  func session(
    _ session: MCSession,
    didReceive stream: InputStream,
    withName streamName: String,
    fromPeer peerID: MCPeerID
  ) {
    // Streams are not part of the ManaSplit protocol. Close immediately so a
    // connected peer cannot hold resources open through an unused API.
    stream.close()
  }

  func session(
    _ session: MCSession,
    didStartReceivingResourceWithName resourceName: String,
    fromPeer peerID: MCPeerID,
    with progress: Progress
  ) {
    guard
      isCurrentTrustedSession(session, peerID: peerID)
    else {
      progress.cancel()
      return
    }
    let components = resourceName.split(separator: ".", omittingEmptySubsequences: false)
    guard
      components.count == 4,
      components[0] == Substring(attachmentResourcePrefix),
      let chunkIndex = Int(components[2]),
      let chunkCount = Int(components[3]),
      chunkIndex >= 0,
      chunkIndex < chunkCount,
      chunkCount <= 1_600,
      progress.totalUnitCount >= 0,
      progress.totalUnitCount <= Int64(4 * 1024 * 1024 + 16)
    else { return }
    let transferId = String(components[1])
    guard safeTransferId(transferId) else { return }
    let observationKey = "receive|\(transferId)|\(peerID.displayName)|\(chunkIndex)"
    queue.async {
      self.resourceProgressObservations[observationKey] = progress.observe(
        \.fractionCompleted,
        options: [.new]
      ) { [weak self] progress, _ in
        let overall = (Double(chunkIndex) + progress.fractionCompleted) / Double(chunkCount)
        self?.emitAttachment([
          "direction": "incoming",
          "state": "progress",
          "transferId": transferId,
          "peerDeviceId": peerID.displayName,
          "chunkIndex": chunkIndex,
          "chunkCount": chunkCount,
          "fraction": max(0, min(1, overall)),
        ])
      }
    }
  }

  func session(
    _ session: MCSession,
    didFinishReceivingResourceWithName resourceName: String,
    fromPeer peerID: MCPeerID,
    at localURL: URL?,
    withError error: Error?
  ) {
    guard
      isCurrentTrustedSession(session, peerID: peerID)
    else { return }
    let components = resourceName.split(separator: ".", omittingEmptySubsequences: false)
    guard
      components.count == 4,
      components[0] == Substring(attachmentResourcePrefix),
      let chunkIndex = Int(components[2]),
      let chunkCount = Int(components[3]),
      chunkIndex >= 0,
      chunkIndex < chunkCount,
      chunkCount <= 1_600
    else { return }
    let transferId = String(components[1])
    let observationKey = "receive|\(transferId)|\(peerID.displayName)|\(chunkIndex)"
    queue.async {
      self.resourceProgressObservations.removeValue(forKey: observationKey)?.invalidate()
      if let error {
        self.emitAttachment([
          "direction": "incoming",
          "state": "failed",
          "transferId": transferId,
          "peerDeviceId": peerID.displayName,
          "errorMessage": error.localizedDescription,
        ])
        return
      }
      guard let localURL, safeTransferId(transferId) else { return }
      do {
        let resourceValues = try localURL.resourceValues(forKeys: [.fileSizeKey])
        guard
          let resourceSize = resourceValues.fileSize,
          resourceSize >= 16,
          resourceSize <= 4 * 1024 * 1024 + 16
        else {
          throw NSError(
            domain: "SplitCircleMesh",
            code: 29,
            userInfo: [NSLocalizedDescriptionKey: "Nearby attachment chunk exceeds the allowed size"]
          )
        }
        let destination = try self.transferDirectory(
          transferId,
          direction: "incoming"
        ).appendingPathComponent("\(chunkIndex).chunk")
        if FileManager.default.fileExists(atPath: destination.path) {
          try FileManager.default.removeItem(at: destination)
        }
        try FileManager.default.moveItem(at: localURL, to: destination)
        self.emitAttachment([
          "direction": "incoming",
          "state": "chunk-received",
          "transferId": transferId,
          "peerDeviceId": peerID.displayName,
          "chunkIndex": chunkIndex,
          "chunkCount": chunkCount,
          "fraction": Double(chunkIndex + 1) / Double(chunkCount),
        ])
      } catch {
        self.emitAttachment([
          "direction": "incoming",
          "state": "failed",
          "transferId": transferId,
          "peerDeviceId": peerID.displayName,
          "errorMessage": error.localizedDescription,
        ])
      }
    }
  }

  func advertiser(
    _ advertiser: MCNearbyServiceAdvertiser,
    didNotStartAdvertisingPeer error: Error
  ) {
    queue.async {
      self.lastError = error as NSError
      self.emitState()
    }
  }

  func browser(
    _ browser: MCNearbyServiceBrowser,
    didNotStartBrowsingForPeers error: Error
  ) {
    queue.async {
      self.lastError = error as NSError
      self.emitState()
    }
  }
}

public final class SplitCircleMeshModule: Module {
  private let controller = MeshController()

  public func definition() -> ModuleDefinition {
    Name("SplitCircleMesh")
    Events("onEnvelope", "onPeersChanged", "onStateChanged", "onAttachmentEvent")

    OnCreate {
      self.controller.onEnvelope = { [weak self] envelope, peerDeviceId in
        self?.sendEvent("onEnvelope", [
          "envelope": envelope,
          "peerDeviceId": peerDeviceId,
        ])
      }
      self.controller.onPeersChanged = { [weak self] count in
        self?.sendEvent("onPeersChanged", ["connectedPeerCount": count])
      }
      self.controller.onStateChanged = { [weak self] payload in
        self?.sendEvent("onStateChanged", payload)
      }
      self.controller.onAttachmentEvent = { [weak self] payload in
        self?.sendEvent("onAttachmentEvent", payload)
      }
    }

    OnDestroy {
      self.controller.stop()
    }

    AsyncFunction("start") {
      (userId: String, deviceId: String, trustedDeviceIds: [String]) -> Bool in
      self.controller.start(
        userId: userId,
        deviceId: deviceId,
        trustedDeviceIds: trustedDeviceIds
      )
      return true
    }

    Function("updateTrustedPeers") { (trustedDeviceIds: [String]) in
      self.controller.updateTrustedPeers(trustedDeviceIds)
    }

    Function("setPairingMode") { (enabled: Bool) in
      self.controller.setPairingMode(enabled)
    }

    Function("stop") {
      self.controller.stop()
    }

    AsyncFunction("send") {
      (envelope: String, recipientDeviceIds: [String]) -> Int in
      try self.controller.send(
        envelope,
        recipientDeviceIds: recipientDeviceIds
      )
    }

    AsyncFunction("sendPairing") {
      (envelope: String, recipientDeviceIds: [String]) -> Int in
      try self.controller.sendPairing(
        envelope,
        recipientDeviceIds: recipientDeviceIds
      )
    }

    AsyncFunction("prepareAttachment") {
      (
        sourceUri: String,
        transferId: String,
        chunkSize: Int
      ) -> [String: Any] in
      try self.controller.prepareAttachment(
        sourceUri: sourceUri,
        transferId: transferId,
        requestedChunkSize: chunkSize
      )
    }

    AsyncFunction("sendPreparedAttachment") {
      (
        transferId: String,
        chunkCount: Int,
        recipientDeviceIds: [String]
      ) -> Int in
      self.controller.sendPreparedAttachment(
        transferId: transferId,
        chunkCount: chunkCount,
        recipientDeviceIds: recipientDeviceIds
      )
    }

    Function("cancelAttachment") { (transferId: String) in
      self.controller.cancelAttachment(transferId: transferId)
    }

    Function("discardAttachment") { (transferId: String) in
      self.controller.discardAttachment(transferId: transferId)
    }

    AsyncFunction("receivedChunkIndexes") { (transferId: String) -> [Int] in
      try self.controller.receivedChunkIndexes(transferId: transferId)
    }

    AsyncFunction("announceReceivedChunks") {
      (
        transferId: String,
        chunkIndexes: [Int],
        originDeviceId: String
      ) -> Bool in
      self.controller.announceReceivedChunks(
        transferId: transferId,
        chunkIndexes: chunkIndexes,
        originDeviceId: originDeviceId
      )
    }

    AsyncFunction("decryptReceivedAttachment") {
      (
        transferId: String,
        destinationUri: String,
        keyBase64: String,
        nonceSeedBase64: String,
        chunkHashes: [String],
        chunkCount: Int
      ) -> String in
      try self.controller.decryptReceivedAttachment(
        transferId: transferId,
        destinationUri: destinationUri,
        keyBase64: keyBase64,
        nonceSeedBase64: nonceSeedBase64,
        chunkHashes: chunkHashes,
        chunkCount: chunkCount
      )
    }

    Function("connectedPeerCount") {
      self.controller.connectedPeerCount()
    }

    Function("restartDiscovery") {
      self.controller.restartDiscovery()
    }

    Function("probePeer") { (deviceId: String) -> Bool in
      self.controller.probePeer(deviceId: deviceId)
    }
  }
}
