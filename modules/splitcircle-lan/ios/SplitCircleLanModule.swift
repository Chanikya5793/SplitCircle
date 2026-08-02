import ExpoModulesCore
// For kDNSServiceErr_PolicyDenied — the Local Network denial code.
import dnssd
import Network

/**
 LAN transport, iOS half (ai_layer/docs/33 Phase 5).

 Bonjour discovery over Network.framework plus a length-prefixed TCP stream.
 Mirrors `SplitCircleLanModule.kt` on exactly one wire detail, and it is worth
 stating precisely because it is the whole contract:

     4-byte BIG-ENDIAN unsigned length, then that many UTF-8 bytes.

 TCP is a STREAM, not a datagram channel: a read can return half a message or
 three at once. Framing therefore lives here, in the layer that owns the socket
 buffer, rather than in shared TypeScript the way BLE's chunking does — JS only
 ever sees whole frames.

 Every device both LISTENS and BROWSES, because a mesh has no clients or
 servers. To avoid two devices opening two sockets to each other, the one whose
 deviceId sorts LOWER dials; the higher one waits. Same rule as the BLE half,
 for the same reason.

 The service type is `_manasplit-mesh._tcp`, which is already declared in the
 app's Info.plist under NSBonjourServices — without that entry iOS silently
 returns no results, which looks exactly like an empty network.
 */
public class SplitCircleLanModule: Module {

  private let controller = LanController()

  public func definition() -> ModuleDefinition {
    Name("SplitCircleLan")

    Events("onFrame", "onPeersChanged")

    OnCreate {
      controller.onFrame = { [weak self] deviceId, frame in
        self?.sendEvent("onFrame", ["peerDeviceId": deviceId, "frame": frame])
      }
      controller.onPeersChanged = { [weak self] peers in
        self?.sendEvent("onPeersChanged", ["peers": peers])
      }
    }

    // HONEST, not hardcoded true. This drives the diagnostics screen and the
    // switch's decision about what may travel here — reporting "available" on
    // a cellular-only phone would claim a Wi-Fi link that cannot exist, and
    // make "no network" indistinguishable from "no peers yet".
    Function("isAvailable") { () -> Bool in controller.hasLocalNetworkPath() }

    AsyncFunction("start") { (deviceId: String, trusted: [String], promise: Promise) in
      controller.start(deviceId: deviceId, trusted: trusted) { ok in promise.resolve(ok) }
    }

    Function("stop") { controller.stop() }

    Function("updateTrust") { (trusted: [String]) in controller.updateTrust(trusted) }

    Function("connectedPeers") { () -> [[String: Any]] in controller.connectedPeers() }

    AsyncFunction("sendFrame") { (peerDeviceId: String, frame: String, promise: Promise) in
      controller.send(peerDeviceId: peerDeviceId, frame: frame) { ok in promise.resolve(ok) }
    }

    OnDestroy { controller.stop() }
  }
}

// MARK: - Controller

private let serviceType = "_manasplit-mesh._tcp"
/// Refuse absurd frames rather than buffering into an OOM.
private let maxFrameBytes = 8 * 1024 * 1024

final class LanController: NSObject {

  var onFrame: ((String, String) -> Void)?
  var onPeersChanged: (([[String: Any]]) -> Void)?

  /// All state is confined to this queue, which is also the queue every
  /// NWListener/NWBrowser/NWConnection is started on — so callbacks already
  /// arrive here. That is the entire locking strategy.
  private let queue = DispatchQueue(label: "com.splitcircle.lan")

  /**
   * Watches for a usable local-network path. Started once and left running:
   * NWPathMonitor is cheap, and a phone moving between Wi-Fi and cellular is
   * exactly the case this transport must react to rather than assume.
   */
  private let pathMonitor = NWPathMonitor()
  private var hasPath = false

  private var listener: NWListener?
  private var browser: NWBrowser?
  private var localDeviceId = ""
  private var trusted = Set<String>()
  private var running = false

  /// Connections whose identity handshake has completed, keyed by remote id.
  private var peers: [String: NWConnection] = [:]
  /// Connections still anonymous. Retained explicitly or they are deallocated.
  private var pending: Set<ObjectIdentifier> = []
  private var pendingConnections: [ObjectIdentifier: NWConnection] = [:]
  private var identityByConnection: [ObjectIdentifier: String] = [:]
  private var buffers: [ObjectIdentifier: Data] = [:]

  /**
   Set when the OS tells us Local Network access was refused (doc 35).

   Neither `NWListener` nor `NWBrowser` had a `stateUpdateHandler`, and a
   `.waiting(PolicyDenied)` state is exactly how Local Network permission denial
   surfaces — so it was discarded entirely. `isAvailable()` is driven by
   `NWPathMonitor`, which reports interface state and stays `true`; `start()`'s
   `do/catch` never throws for this. The module therefore reported fully healthy
   while discovering nobody and being discovered by nobody, forever, and
   indistinguishable from "no peers nearby". The JS bridge's own comment claimed
   the denial "arrives here" in a catch that could never fire for it — the same
   doc-comment-asserts-an-unwired-mechanism pattern CLAUDE.md already records
   three times.
   */
  private var localNetworkDenied = false

  override init() {
    super.init()
    pathMonitor.pathUpdateHandler = { [weak self] path in
      guard let self else { return }
      // `satisfied` alone is not enough: a cellular-only path satisfies, and
      // Bonjour over cellular reaches nobody. Require a local-network
      // interface, which is what this transport actually needs.
      let local = path.usesInterfaceType(.wifi)
        || path.usesInterfaceType(.wiredEthernet)
        || path.usesInterfaceType(.other)
      self.queue.async { self.hasPath = path.status == .satisfied && local }
    }
    pathMonitor.start(queue: queue)
  }

  func hasLocalNetworkPath() -> Bool {
    // A denial is a hard unavailability: the interface is up and useless.
    queue.sync { hasPath && !localNetworkDenied }
  }

  // MARK: lifecycle

  func start(deviceId: String, trusted trustedIds: [String], completion: @escaping (Bool) -> Void) {
    queue.async {
      if self.running {
        self.trusted = Set(trustedIds)
        completion(true)
        return
      }
      self.localDeviceId = deviceId
      self.trusted = Set(trustedIds)

      do {
        let params = NWParameters.tcp
        // Peer-to-peer so it works over AWDL/hotspot as well as infrastructure
        // Wi-Fi. Without it this only ever finds devices on the same router.
        params.includePeerToPeer = true

        let listener = try NWListener(using: params)
        listener.service = NWListener.Service(name: deviceId, type: serviceType)
        listener.newConnectionHandler = { [weak self] connection in
          self?.adopt(connection, dialled: false)
        }
        listener.stateUpdateHandler = { [weak self] state in
          switch state {
          case .waiting(let error), .failed(let error):
            self?.handleEndpointFailure(error, role: "listener")
          default: break
          }
        }
        listener.start(queue: self.queue)
        self.listener = listener

        let browser = NWBrowser(
          for: .bonjour(type: serviceType, domain: nil),
          using: params
        )
        browser.browseResultsChangedHandler = { [weak self] results, _ in
          self?.handleBrowse(results)
        }
        browser.stateUpdateHandler = { [weak self] state in
          switch state {
          case .waiting(let error), .failed(let error):
            self?.handleEndpointFailure(error, role: "browser")
          default: break
          }
        }
        browser.start(queue: self.queue)
        self.browser = browser

        self.running = true
        completion(true)
      } catch {
        self.stopLocked()
        completion(false)
      }
    }
  }

  /**
   Turns a listener/browser `.waiting`/`.failed` state into a diagnosable signal.

   `.waiting` matters as much as `.failed`: Network.framework reports a Local
   Network denial as `.waiting(.dns(PolicyDenied))` and keeps retrying forever
   rather than failing, so treating only `.failed` as an error would miss the
   one case this exists for.

   NSLog, not a Swift `print`: this has to be readable from a Release build on a
   real device via `log stream`, which is the only way anyone would ever find
   out this happened.
   */
  private func handleEndpointFailure(_ error: NWError, role: String) {
    if case .dns(let code) = error, code == DNSServiceErrorType(kDNSServiceErr_PolicyDenied) {
      localNetworkDenied = true
      NSLog("⚠️ SplitCircleLan: Local Network permission denied (%@); LAN transport is inert", role)
      emitPeers()
      return
    }
    NSLog("⚠️ SplitCircleLan: %@ failed: %@", role, String(describing: error))
  }

  func stop() { queue.async { self.stopLocked() } }

  private func stopLocked() {
    running = false
    // Cleared on stop, not held forever: the user can grant permission in
    // Settings, and a stale denial would keep the transport dead across the
    // restart that is supposed to pick that up.
    localNetworkDenied = false
    listener?.cancel()
    listener = nil
    browser?.cancel()
    browser = nil
    peers.values.forEach { $0.cancel() }
    peers.removeAll()
    pendingConnections.values.forEach { $0.cancel() }
    pendingConnections.removeAll()
    pending.removeAll()
    identityByConnection.removeAll()
    buffers.removeAll()
  }

  func updateTrust(_ ids: [String]) {
    queue.async {
      self.trusted = Set(ids)
      // Evict anyone who just lost trust. Sockets are independent, so dropping
      // one costs the others nothing.
      for (deviceId, connection) in self.peers where !self.trusted.contains(deviceId) {
        connection.cancel()
        self.peers.removeValue(forKey: deviceId)
      }
      self.emitPeers()
    }
  }

  func connectedPeers() -> [[String: Any]] {
    queue.sync { peers.keys.map { ["deviceId": $0] } }
  }

  // MARK: discovery

  private func handleBrowse(_ results: Set<NWBrowser.Result>) {
    guard running else { return }
    for result in results {
      guard case let .service(name, _, _, _) = result.endpoint else { continue }
      // ONE socket per pair, decided without negotiation: the lower id dials.
      // Both sides compute it from data they already have.
      guard name != localDeviceId, localDeviceId < name else { continue }
      guard peers[name] == nil else { continue }
      guard trusted.contains(name) else { continue }

      let params = NWParameters.tcp
      params.includePeerToPeer = true
      let connection = NWConnection(to: result.endpoint, using: params)
      adopt(connection, dialled: true)
    }
  }

  private func adopt(_ connection: NWConnection, dialled: Bool) {
    let token = ObjectIdentifier(connection)
    pending.insert(token)
    pendingConnections[token] = connection
    buffers[token] = Data()

    connection.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      switch state {
      case .ready:
        // Announce ourselves immediately. The listener side cannot ask who
        // connected — there is no reverse channel until identity is known —
        // so both sides send their id first and neither trusts the socket
        // until the other has.
        self.write(connection, frame: self.localDeviceId)
        self.receive(connection)
      case .failed, .cancelled:
        self.drop(connection)
      default:
        break
      }
    }
    connection.start(queue: queue)
  }

  // MARK: framing

  private func write(_ connection: NWConnection, frame: String) {
    guard let payload = frame.data(using: .utf8) else { return }
    var header = withUnsafeBytes(of: UInt32(payload.count).bigEndian) { Data($0) }
    header.append(payload)
    connection.send(content: header, completion: .contentProcessed { _ in })
  }

  private func receive(_ connection: NWConnection) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) {
      [weak self] data, _, isComplete, error in
      guard let self else { return }
      if let data, !data.isEmpty {
        self.queue.async { self.ingest(connection, data) }
      }
      if isComplete || error != nil {
        self.queue.async { self.drop(connection) }
        return
      }
      self.receive(connection)
    }
  }

  /// Accumulates and splits the stream. A read can carry half a frame or
  /// several — the length prefix is the only thing that says where one ends.
  private func ingest(_ connection: NWConnection, _ chunk: Data) {
    let token = ObjectIdentifier(connection)
    var buffer = (buffers[token] ?? Data())
    buffer.append(chunk)

    while buffer.count >= 4 {
      let length = buffer.prefix(4).reduce(0) { ($0 << 8) | Int($1) }
      if length <= 0 || length > maxFrameBytes {
        // Garbage or hostile: the stream can never be resynchronised, so drop
        // the whole connection rather than guessing at a boundary.
        buffers[token] = Data()
        drop(connection)
        return
      }
      guard buffer.count >= 4 + length else { break }
      let payload = buffer.subdata(in: 4..<(4 + length))
      buffer.removeSubrange(0..<(4 + length))
      if let text = String(data: payload, encoding: .utf8) {
        handleFrame(connection, text)
      }
    }
    buffers[token] = buffer
  }

  private func handleFrame(_ connection: NWConnection, _ text: String) {
    let token = ObjectIdentifier(connection)

    // First frame on a socket is always the peer's identity.
    guard let deviceId = identityByConnection[token] else {
      let claimed = text.trimmingCharacters(in: .whitespacesAndNewlines)
      // Trust is enforced on BOTH sides. The network authenticates nothing —
      // anyone on the LAN can open a socket and claim an id.
      guard !claimed.isEmpty, trusted.contains(claimed) else {
        drop(connection)
        return
      }
      // Duplicate-socket dedup for the tie case; keep one deterministically.
      if let existing = peers[claimed], existing !== connection {
        if localDeviceId > claimed { drop(connection); return }
        existing.cancel()
      }
      identityByConnection[token] = claimed
      peers[claimed] = connection
      pending.remove(token)
      pendingConnections.removeValue(forKey: token)
      emitPeers()
      return
    }

    onFrame?(deviceId, text)
  }

  func send(peerDeviceId: String, frame: String, completion: @escaping (Bool) -> Void) {
    queue.async {
      guard self.running, let connection = self.peers[peerDeviceId] else {
        completion(false)
        return
      }
      guard let payload = frame.data(using: .utf8), payload.count <= maxFrameBytes else {
        completion(false)
        return
      }
      var header = withUnsafeBytes(of: UInt32(payload.count).bigEndian) { Data($0) }
      header.append(payload)
      connection.send(content: header, completion: .contentProcessed { error in
        completion(error == nil)
      })
    }
  }

  private func drop(_ connection: NWConnection) {
    let token = ObjectIdentifier(connection)
    connection.cancel()
    buffers.removeValue(forKey: token)
    pending.remove(token)
    pendingConnections.removeValue(forKey: token)
    if let deviceId = identityByConnection.removeValue(forKey: token) {
      if peers[deviceId] === connection { peers.removeValue(forKey: deviceId) }
      emitPeers()
    }
  }

  private func emitPeers() {
    onPeersChanged?(peers.keys.map { ["deviceId": $0] })
  }
}
