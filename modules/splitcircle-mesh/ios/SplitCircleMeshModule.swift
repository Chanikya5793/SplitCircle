import ExpoModulesCore
import MultipeerConnectivity

private let serviceType = "manasplit-mesh"
private let controlPrefix = "manasplit-control-v1"

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
  private var discoveredPeerNames = Set<String>()
  private var connectingPeerNames = Set<String>()
  private var knownPeers: [String: MCPeerID] = [:]
  private var invitationTokens: [String: UUID] = [:]
  private var invitationRetryCounts: [String: Int] = [:]
  private var pendingProbes: [String: (peerName: String, startedAt: Date)] = [:]
  private var peerLatencyMs: [String: Int] = [:]
  private var lastError: NSError?

  var onEnvelope: ((String) -> Void)?
  var onPeersChanged: ((Int) -> Void)?
  var onStateChanged: (([String: Any]) -> Void)?

  func start(userId: String, deviceId: String) {
    queue.sync {
      stopLocked()

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
        discoveryInfo: ["v": "1"],
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
    discoveredPeerNames.removeAll()
    connectingPeerNames.removeAll()
    knownPeers.removeAll()
    invitationTokens.removeAll()
    invitationRetryCounts.removeAll()
    pendingProbes.removeAll()
    peerLatencyMs.removeAll()
    lastError = nil
    emitPeerCount(0)
    emitState()
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
      discoveryInfo: ["v": "1"],
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

  func send(_ envelope: String) throws -> Int {
    try queue.sync {
      guard let session else { return 0 }
      let peers = session.connectedPeers
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
    let resolved = count ?? session?.connectedPeers.count ?? 0
    DispatchQueue.main.async { [weak self] in self?.onPeersChanged?(resolved) }
  }

  private func emitState() {
    let connectedNames = Set(session?.connectedPeers.map(\.displayName) ?? [])
    connectingPeerNames.subtract(connectedNames)

    let status: String
    if lastError != nil {
      status = "error"
    } else if !connectedNames.isEmpty {
      status = "connected"
    } else if !connectingPeerNames.isEmpty {
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
      "connectingPeerCount": connectingPeerNames.count,
      "discoveredDeviceIds": Array(discoveredPeerNames).sorted(),
      "connectingDeviceIds": Array(connectingPeerNames).sorted(),
      "connectedDeviceIds": Array(connectedNames).sorted(),
      "probingDeviceIds": Array(Set(pendingProbes.values.map(\.peerName))).sorted(),
      "peerLatencyMs": peerLatencyMs,
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
    browser.invitePeer(peerID, to: session, withContext: nil, timeout: 12)
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
    guard info?["v"] == "1" else { return }
    queue.async {
      self.discoveredPeerNames.insert(peerID.displayName)
      self.knownPeers[peerID.displayName] = peerID
      self.beginInvitation(to: peerID)
      self.emitState()
    }
  }

  func browser(_ browser: MCNearbyServiceBrowser, lostPeer peerID: MCPeerID) {
    queue.async {
      self.discoveredPeerNames.remove(peerID.displayName)
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
      guard self.running else {
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
      switch state {
      case .connecting:
        self.connectingPeerNames.insert(peerID.displayName)
      case .connected:
        self.discoveredPeerNames.insert(peerID.displayName)
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
    guard self.session === session else { return }
    guard let envelope = String(data: data, encoding: .utf8) else { return }

    let components = envelope.split(separator: "|", omittingEmptySubsequences: false)
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

    DispatchQueue.main.async { [weak self] in self?.onEnvelope?(envelope) }
  }

  func session(
    _ session: MCSession,
    didReceive stream: InputStream,
    withName streamName: String,
    fromPeer peerID: MCPeerID
  ) {}

  func session(
    _ session: MCSession,
    didStartReceivingResourceWithName resourceName: String,
    fromPeer peerID: MCPeerID,
    with progress: Progress
  ) {}

  func session(
    _ session: MCSession,
    didFinishReceivingResourceWithName resourceName: String,
    fromPeer peerID: MCPeerID,
    at localURL: URL?,
    withError error: Error?
  ) {}

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
    Events("onEnvelope", "onPeersChanged", "onStateChanged")

    OnCreate {
      self.controller.onEnvelope = { [weak self] envelope in
        self?.sendEvent("onEnvelope", ["envelope": envelope])
      }
      self.controller.onPeersChanged = { [weak self] count in
        self?.sendEvent("onPeersChanged", ["connectedPeerCount": count])
      }
      self.controller.onStateChanged = { [weak self] payload in
        self?.sendEvent("onStateChanged", payload)
      }
    }

    OnDestroy {
      self.controller.stop()
    }

    AsyncFunction("start") { (userId: String, deviceId: String) -> Bool in
      self.controller.start(userId: userId, deviceId: deviceId)
      return true
    }

    Function("stop") {
      self.controller.stop()
    }

    AsyncFunction("send") { (envelope: String) -> Int in
      try self.controller.send(envelope)
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
