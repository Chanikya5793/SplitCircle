import ExpoModulesCore
import CoreBluetooth

/**
 BLE transport, iOS half (ai_layer/docs/33 Phase 3).

 Mirrors `SplitCircleBleModule.kt` exactly at the wire level. The two halves
 must agree byte for byte on service/characteristic UUIDs, on the identity
 handshake, and on what `mtu` means — anything else shows up only between an
 iPhone and a Pixel, on real radios, as corruption rather than a mismatch.

 Deliberately thin: connect to trusted peers, move opaque chunk strings, report
 reachability. Fragmentation, reassembly, ordering and bounds live in
 `src/services/mesh/bleFraming.ts`, in one tested TypeScript implementation, so
 this file and the Kotlin one cannot drift on header layout.

 Every device runs BOTH GATT roles at once, because a mesh has no clients or
 servers. A chunk therefore travels a different API depending on which side
 opened the link, which is most of the complexity here.

 TWO PLATFORM ASYMMETRIES that are easy to get wrong and impossible to see
 without the other platform in hand:

 1. **Advertisement payload.** `CBPeripheralManager` supports only
    `CBAdvertisementDataLocalNameKey` and `CBAdvertisementDataServiceUUIDsKey` —
    it CANNOT advertise service data, which is where the Android half puts its
    id prefix. So iOS advertises the prefix as the local name, and both halves
    read BOTH fields when scanning. Reading only its own format means each
    platform discovers only its own kind.

 2. **Backgrounding.** Once this app is backgrounded, iOS moves the advertised
    service UUID into the "overflow" area, which is only discoverable by another
    iOS device explicitly scanning for that UUID — an Android scanner cannot see
    it at all. Cross-platform discovery therefore needs the iOS side foregrounded.
    Documented rather than worked around: there is no API to opt out.
 */
public class SplitCircleBleModule: Module {

  private let controller = BleController()

  public func definition() -> ModuleDefinition {
    Name("SplitCircleBle")

    Events("onChunk", "onPeersChanged")

    OnCreate {
      controller.onChunk = { [weak self] deviceId, chunk in
        self?.sendEvent("onChunk", ["peerDeviceId": deviceId, "chunk": chunk])
      }
      controller.onPeersChanged = { [weak self] peers in
        self?.sendEvent("onPeersChanged", ["peers": peers])
      }
    }

    Function("isAvailable") { () -> Bool in
      controller.isAvailable()
    }

    AsyncFunction("start") { (deviceId: String, trusted: [String], promise: Promise) in
      controller.start(deviceId: deviceId, trusted: trusted) { started in
        promise.resolve(started)
      }
    }

    Function("stop") {
      controller.stop()
    }

    Function("updateTrust") { (trusted: [String]) in
      controller.updateTrust(trusted)
    }

    Function("connectedPeers") { () -> [[String: Any]] in
      controller.connectedPeers()
    }

    AsyncFunction("sendChunk") { (peerDeviceId: String, chunk: String, promise: Promise) in
      controller.sendChunk(peerDeviceId: peerDeviceId, chunk: chunk) { ok in
        promise.resolve(ok)
      }
    }

    OnDestroy {
      controller.stop()
    }
  }
}

// MARK: - Controller

private let serviceUUID = CBUUID(string: "5C1E0001-5B1E-4A7F-9C3D-6F9B8E2A1C3D")
private let chunkUUID = CBUUID(string: "5C1E0002-5B1E-4A7F-9C3D-6F9B8E2A1C3D")
private let identityUUID = CBUUID(string: "5C1E0003-5B1E-4A7F-9C3D-6F9B8E2A1C3D")

/// Matches the Kotlin half. Discovery hint and connect-direction tiebreak only.
private let advertisedPrefixLength = 8
/// ATT protocol overhead. CoreBluetooth reports usable payload; Android reports
/// the full ATT MTU, so this is added to keep one meaning on the JS side.
private let attOverhead = 3
private let defaultAttMtu = 23

final class BleController: NSObject {

  var onChunk: ((String, String) -> Void)?
  var onPeersChanged: (([[String: Any]]) -> Void)?

  /// All state is touched only on this queue, including from CB delegate
  /// callbacks, which CoreBluetooth delivers here because we hand it to both
  /// managers. That is the whole locking strategy — no mutex, one queue.
  private let queue = DispatchQueue(label: "com.splitcircle.ble")

  private var central: CBCentralManager?
  private var peripheralManager: CBPeripheralManager?

  private var localDeviceId = ""
  private var trustedDeviceIds = Set<String>()
  private var running = false
  private var startCompletion: ((Bool) -> Void)?

  private var chunkCharacteristic: CBMutableCharacteristic?

  /// Links where WE dialled out, keyed by resolved remote device id.
  private var centralLinks: [String: CBPeripheral] = [:]
  /// Links where the peer dialled US, keyed by resolved remote device id.
  private var peripheralLinks: [String: CBCentral] = [:]

  /// Strong references: CoreBluetooth deallocates a CBPeripheral we do not
  /// retain, silently dropping the connection mid-handshake.
  private var retainedPeripherals: [UUID: CBPeripheral] = [:]
  private var identityByPeripheral: [UUID: String] = [:]
  private var identityByCentral: [UUID: String] = [:]
  private var mtuByDeviceId: [String: Int] = [:]

  private var pendingWrites: [String: (Bool) -> Void] = [:]
  /// Notifications CoreBluetooth refused because its queue was full; retried
  /// from `peripheralManagerIsReady`.
  private var deferredNotifies: [(central: CBCentral, data: Data, done: (Bool) -> Void)] = []

  // MARK: lifecycle

  func isAvailable() -> Bool {
    queue.sync { central?.state == .poweredOn && peripheralManager?.state == .poweredOn }
  }

  func start(deviceId: String, trusted: [String], completion: @escaping (Bool) -> Void) {
    queue.async {
      if self.running {
        // Idempotent: a trust refresh must never tear the radio down.
        self.trustedDeviceIds = Set(trusted)
        completion(true)
        return
      }
      self.localDeviceId = deviceId
      self.trustedDeviceIds = Set(trusted)
      self.startCompletion = completion
      // Both managers are created here; each reports readiness through its own
      // state callback, and only then can we scan or advertise.
      self.central = CBCentralManager(delegate: self, queue: self.queue)
      self.peripheralManager = CBPeripheralManager(delegate: self, queue: self.queue)
      self.running = true
    }
  }

  func stop() {
    queue.async {
      self.running = false
      self.central?.stopScan()
      self.peripheralManager?.stopAdvertising()
      self.peripheralManager?.removeAllServices()

      for peripheral in self.retainedPeripherals.values {
        self.central?.cancelPeripheralConnection(peripheral)
      }
      self.retainedPeripherals.removeAll()
      self.centralLinks.removeAll()
      self.peripheralLinks.removeAll()
      self.identityByPeripheral.removeAll()
      self.identityByCentral.removeAll()
      self.mtuByDeviceId.removeAll()

      // Settle every in-flight promise. bleTransport awaits these, and one that
      // never resolves wedges the send queue for that peer permanently.
      self.pendingWrites.values.forEach { $0(false) }
      self.pendingWrites.removeAll()
      self.deferredNotifies.forEach { $0.done(false) }
      self.deferredNotifies.removeAll()

      self.startCompletion?(false)
      self.startCompletion = nil
      self.central = nil
      self.peripheralManager = nil
      self.chunkCharacteristic = nil
    }
  }

  func updateTrust(_ trusted: [String]) {
    queue.async {
      self.trustedDeviceIds = Set(trusted)
      let dropped = Set(self.centralLinks.keys).union(self.peripheralLinks.keys)
        .filter { !self.trustedDeviceIds.contains($0) }
      guard !dropped.isEmpty else { return }
      // Unlike MultipeerConnectivity's single shared MCSession (doc 32 §10.2),
      // BLE links are independent — evicting one peer costs the others nothing.
      dropped.forEach { self.disconnect(deviceId: $0) }
      self.emitPeers()
    }
  }

  func connectedPeers() -> [[String: Any]] {
    queue.sync { peersSnapshot() }
  }

  private func disconnect(deviceId: String) {
    if let peripheral = centralLinks.removeValue(forKey: deviceId) {
      identityByPeripheral.removeValue(forKey: peripheral.identifier)
      retainedPeripherals.removeValue(forKey: peripheral.identifier)
      central?.cancelPeripheralConnection(peripheral)
    }
    if let remote = peripheralLinks.removeValue(forKey: deviceId) {
      identityByCentral.removeValue(forKey: remote.identifier)
    }
    mtuByDeviceId.removeValue(forKey: deviceId)
    pendingWrites.removeValue(forKey: deviceId)?(false)
  }

  private func advertisedPrefix() -> String {
    String(localDeviceId.replacingOccurrences(of: "-", with: "").prefix(advertisedPrefixLength))
      .lowercased()
  }

  private func beginIfReady() {
    guard running,
          central?.state == .poweredOn,
          peripheralManager?.state == .poweredOn else { return }

    let chunk = CBMutableCharacteristic(
      type: chunkUUID,
      properties: [.write, .writeWithoutResponse, .notify],
      value: nil,
      permissions: [.writeable]
    )
    // READ **and** WRITE, matching Kotlin. GATT is asymmetric — only a central
    // can initiate — so a peripheral cannot ask "who are you?". Without a
    // writable identity characteristic the peripheral never learns the
    // central's id and drops every chunk it receives, while the link looks
    // established from both ends.
    let identity = CBMutableCharacteristic(
      type: identityUUID,
      properties: [.read, .write],
      value: nil,
      permissions: [.readable, .writeable]
    )
    let service = CBMutableService(type: serviceUUID, primary: true)
    service.characteristics = [chunk, identity]
    chunkCharacteristic = chunk

    peripheralManager?.removeAllServices()
    peripheralManager?.add(service)

    peripheralManager?.startAdvertising([
      CBAdvertisementDataServiceUUIDsKey: [serviceUUID],
      // iOS cannot advertise service data (see the class comment), so the
      // prefix rides in the local name and both halves read both fields.
      CBAdvertisementDataLocalNameKey: advertisedPrefix(),
    ])

    central?.scanForPeripherals(
      withServices: [serviceUUID],
      // Duplicates off: we only need to see each peer once to decide to dial,
      // and leaving them on wakes the app for every advertising interval.
      options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
    )

    startCompletion?(true)
    startCompletion = nil
  }

  // MARK: send

  func sendChunk(peerDeviceId: String, chunk: String, completion: @escaping (Bool) -> Void) {
    queue.async {
      guard self.running, let data = chunk.data(using: .utf8) else {
        completion(false); return
      }
      // One in-flight write per peer, matching Kotlin. Issuing a second write
      // before the first completes loses one of the two callbacks.
      guard self.pendingWrites[peerDeviceId] == nil else { completion(false); return }

      if let peripheral = self.centralLinks[peerDeviceId] {
        guard let characteristic = peripheral.services?
          .first(where: { $0.uuid == serviceUUID })?
          .characteristics?.first(where: { $0.uuid == chunkUUID }) else {
          completion(false); return
        }
        self.pendingWrites[peerDeviceId] = completion
        // withResponse: the delegate callback is what resolves the promise, and
        // a partial frame is unrecoverable, so the round trip is worth it.
        peripheral.writeValue(data, for: characteristic, type: .withResponse)
        return
      }

      if let remote = self.peripheralLinks[peerDeviceId],
         let characteristic = self.chunkCharacteristic {
        let sent = self.peripheralManager?.updateValue(
          data, for: characteristic, onSubscribedCentrals: [remote]
        ) ?? false
        if sent {
          completion(true)
        } else {
          // The transmit queue is full. CoreBluetooth calls
          // peripheralManagerIsReady when it drains; dropping here instead
          // would fail sends purely because we were fast.
          self.deferredNotifies.append((central: remote, data: data, done: completion))
        }
        return
      }

      completion(false)
    }
  }

  // MARK: events

  private func peersSnapshot() -> [[String: Any]] {
    Set(centralLinks.keys).union(peripheralLinks.keys).map { id in
      [
        "deviceId": id,
        // Report the full ATT MTU, as Android does, so bleTransport owns the
        // header subtraction in exactly one place.
        "mtu": mtuByDeviceId[id] ?? defaultAttMtu,
      ]
    }
  }

  private func emitPeers() {
    let peers = peersSnapshot()
    onPeersChanged?(peers)
  }
}

// MARK: - Central role

extension BleController: CBCentralManagerDelegate {

  func centralManagerDidUpdateState(_ manager: CBCentralManager) {
    if manager.state == .poweredOn {
      beginIfReady()
    } else {
      startCompletion?(false)
      startCompletion = nil
    }
  }

  func centralManager(
    _ manager: CBCentralManager,
    didDiscover peripheral: CBPeripheral,
    advertisementData: [String: Any],
    rssi RSSI: NSNumber
  ) {
    guard running, retainedPeripherals[peripheral.identifier] == nil else { return }

    // BOTH formats. Android advertises the prefix as service data; iOS cannot,
    // and uses the local name. Reading only one means discovering only one
    // kind of device — the exact failure this transport exists to avoid.
    var remotePrefix: String?
    if let serviceData = advertisementData[CBAdvertisementDataServiceDataKey] as? [CBUUID: Data],
       let raw = serviceData[serviceUUID] {
      remotePrefix = String(data: raw, encoding: .utf8)
    }
    if remotePrefix == nil {
      remotePrefix = advertisementData[CBAdvertisementDataLocalNameKey] as? String
    }
    guard let prefix = remotePrefix?.lowercased(), !prefix.isEmpty else { return }

    // ONE link per pair, decided without negotiation: the lower id dials. On an
    // exact tie both dial and the duplicate is deduped after the identity read
    // — a redundant link is recoverable, both sides declining is permanent.
    guard advertisedPrefix() <= prefix else { return }

    retainedPeripherals[peripheral.identifier] = peripheral
    peripheral.delegate = self
    manager.connect(peripheral, options: nil)
  }

  func centralManager(_ manager: CBCentralManager, didConnect peripheral: CBPeripheral) {
    peripheral.discoverServices([serviceUUID])
  }

  func centralManager(
    _ manager: CBCentralManager,
    didFailToConnect peripheral: CBPeripheral,
    error: Error?
  ) {
    retainedPeripherals.removeValue(forKey: peripheral.identifier)
  }

  func centralManager(
    _ manager: CBCentralManager,
    didDisconnectPeripheral peripheral: CBPeripheral,
    error: Error?
  ) {
    retainedPeripherals.removeValue(forKey: peripheral.identifier)
    guard let deviceId = identityByPeripheral.removeValue(forKey: peripheral.identifier) else {
      return
    }
    centralLinks.removeValue(forKey: deviceId)
    if peripheralLinks[deviceId] == nil { mtuByDeviceId.removeValue(forKey: deviceId) }
    pendingWrites.removeValue(forKey: deviceId)?(false)
    emitPeers()
  }
}

extension BleController: CBPeripheralDelegate {

  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    guard let service = peripheral.services?.first(where: { $0.uuid == serviceUUID }) else {
      central?.cancelPeripheralConnection(peripheral); return
    }
    peripheral.discoverCharacteristics([chunkUUID, identityUUID], for: service)
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didDiscoverCharacteristicsFor service: CBService,
    error: Error?
  ) {
    guard let identity = service.characteristics?.first(where: { $0.uuid == identityUUID }) else {
      central?.cancelPeripheralConnection(peripheral); return
    }
    // Identity first: trust is checked against the full id, never the
    // advertised prefix, which any device can claim.
    peripheral.readValue(for: identity)
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didUpdateValueFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    guard let value = characteristic.value else { return }

    if characteristic.uuid == identityUUID {
      let remoteId = String(data: value, encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      guard !remoteId.isEmpty, trustedDeviceIds.contains(remoteId) else {
        central?.cancelPeripheralConnection(peripheral); return
      }
      // Duplicate-link dedup for the prefix-tie case. Both sides run the same
      // comparison and independently reach the same verdict.
      if centralLinks[remoteId] != nil || peripheralLinks[remoteId] != nil,
         localDeviceId > remoteId {
        central?.cancelPeripheralConnection(peripheral); return
      }
      identityByPeripheral[peripheral.identifier] = remoteId
      centralLinks[remoteId] = peripheral
      mtuByDeviceId[remoteId] =
        peripheral.maximumWriteValueLength(for: .withResponse) + attOverhead

      guard let chunk = peripheral.services?
        .first(where: { $0.uuid == serviceUUID })?
        .characteristics?.first(where: { $0.uuid == chunkUUID }) else {
        central?.cancelPeripheralConnection(peripheral); return
      }
      peripheral.setNotifyValue(true, for: chunk)
      return
    }

    if characteristic.uuid == chunkUUID {
      guard let deviceId = identityByPeripheral[peripheral.identifier],
            let text = String(data: value, encoding: .utf8) else { return }
      onChunk?(deviceId, text)
    }
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didUpdateNotificationStateFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    guard characteristic.uuid == chunkUUID, error == nil else { return }
    // Announce ourselves. The peripheral cannot ask, so this write is the ONLY
    // way it learns our id — and therefore the only way it can attribute the
    // chunks we send, or send any back.
    guard let identity = peripheral.services?
      .first(where: { $0.uuid == serviceUUID })?
      .characteristics?.first(where: { $0.uuid == identityUUID }),
      let data = localDeviceId.data(using: .utf8) else { return }
    peripheral.writeValue(data, for: identity, type: .withResponse)
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didWriteValueFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    if characteristic.uuid == identityUUID {
      // Only NOW is the link genuinely bidirectional. Reporting the peer any
      // earlier advertises a route it cannot yet honour.
      if error == nil { emitPeers() } else { central?.cancelPeripheralConnection(peripheral) }
      return
    }
    if characteristic.uuid == chunkUUID {
      guard let deviceId = identityByPeripheral[peripheral.identifier] else { return }
      pendingWrites.removeValue(forKey: deviceId)?(error == nil)
    }
  }
}

// MARK: - Peripheral role

extension BleController: CBPeripheralManagerDelegate {

  func peripheralManagerDidUpdateState(_ manager: CBPeripheralManager) {
    if manager.state == .poweredOn {
      beginIfReady()
    } else {
      startCompletion?(false)
      startCompletion = nil
    }
  }

  func peripheralManager(
    _ manager: CBPeripheralManager,
    didReceiveRead request: CBATTRequest
  ) {
    guard request.characteristic.uuid == identityUUID,
          let data = localDeviceId.data(using: .utf8) else {
      manager.respond(to: request, withResult: .attributeNotFound); return
    }
    // Honour `offset`: a device id is 36 bytes and does not fit the 23-byte
    // default MTU, so iOS issues a second read for the remainder. Ignoring it
    // truncates every identity before MTU negotiation lands.
    guard request.offset <= data.count else {
      manager.respond(to: request, withResult: .invalidOffset); return
    }
    request.value = data.subdata(in: request.offset..<data.count)
    manager.respond(to: request, withResult: .success)
  }

  func peripheralManager(
    _ manager: CBPeripheralManager,
    didReceiveWrite requests: [CBATTRequest]
  ) {
    for request in requests {
      guard let value = request.value else { continue }

      if request.characteristic.uuid == identityUUID {
        let claimedId = String(data: value, encoding: .utf8)?
          .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        // Trust is enforced on BOTH roles. The central checks the peripheral by
        // reading its identity; this is the mirror. Without it, any device that
        // can see the advertisement could write chunks into our server — BLE
        // itself authenticates nothing.
        guard !claimedId.isEmpty, trustedDeviceIds.contains(claimedId) else {
          manager.respond(to: request, withResult: .insufficientAuthentication)
          continue
        }
        identityByCentral[request.central.identifier] = claimedId
        peripheralLinks[claimedId] = request.central
        mtuByDeviceId[claimedId] = request.central.maximumUpdateValueLength + attOverhead
        manager.respond(to: request, withResult: .success)
        emitPeers()
        continue
      }

      if request.characteristic.uuid == chunkUUID {
        manager.respond(to: request, withResult: .success)
        // No identity yet means chunks arrived before the announcement. Dropping
        // is correct: an unattributed chunk cannot be routed, and accepting it
        // would let an untrusted device inject into the mesh.
        guard let deviceId = identityByCentral[request.central.identifier],
              let text = String(data: value, encoding: .utf8) else { continue }
        onChunk?(deviceId, text)
        continue
      }

      manager.respond(to: request, withResult: .attributeNotFound)
    }
  }

  func peripheralManager(
    _ manager: CBPeripheralManager,
    central: CBCentral,
    didSubscribeTo characteristic: CBCharacteristic
  ) {
    // Subscription alone does not identify anyone; the identity write does.
    // Refresh the MTU here because it is only meaningful once subscribed.
    guard let deviceId = identityByCentral[central.identifier] else { return }
    mtuByDeviceId[deviceId] = central.maximumUpdateValueLength + attOverhead
  }

  func peripheralManager(
    _ manager: CBPeripheralManager,
    central: CBCentral,
    didUnsubscribeFrom characteristic: CBCharacteristic
  ) {
    guard let deviceId = identityByCentral.removeValue(forKey: central.identifier) else { return }
    peripheralLinks.removeValue(forKey: deviceId)
    if centralLinks[deviceId] == nil { mtuByDeviceId.removeValue(forKey: deviceId) }
    emitPeers()
  }

  func peripheralManagerIsReady(toUpdateSubscribers manager: CBPeripheralManager) {
    guard let characteristic = chunkCharacteristic else { return }
    // Drain in order. Anything the queue refuses again goes back at the front,
    // because reordering here would corrupt a frame the receiver reassembles
    // by index only after every chunk has arrived.
    var remaining: [(central: CBCentral, data: Data, done: (Bool) -> Void)] = []
    for item in deferredNotifies {
      if remaining.isEmpty,
         manager.updateValue(item.data, for: characteristic, onSubscribedCentrals: [item.central]) {
        item.done(true)
      } else {
        remaining.append(item)
      }
    }
    deferredNotifies = remaining
  }
}
