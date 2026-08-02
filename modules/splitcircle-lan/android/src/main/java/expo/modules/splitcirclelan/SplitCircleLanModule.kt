package expo.modules.splitcirclelan

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.DataInputStream
import java.io.DataOutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import kotlin.concurrent.thread

/**
 * LAN transport, Android half (ai_layer/docs/33 Phase 5).
 *
 * NSD (Android's mDNS) for discovery plus a length-prefixed TCP stream.
 * Mirrors `SplitCircleLanModule.swift` on exactly one wire detail, and it is
 * the whole contract between them:
 *
 *     4-byte BIG-ENDIAN unsigned length, then that many UTF-8 bytes.
 *
 * TCP is a STREAM: a read can return half a message or three at once. Framing
 * therefore lives here, in the layer that owns the socket buffer, rather than
 * in shared TypeScript the way BLE's chunking does. `DataInputStream.readInt`
 * and `readFully` give exactly that framing for free, and are what make this
 * half far shorter than the BLE one.
 *
 * Every device both LISTENS and BROWSES, because a mesh has no clients or
 * servers. To avoid two devices opening two sockets to each other, the one
 * whose deviceId sorts LOWER dials; the higher one waits. Same rule as the BLE
 * half and the Swift half, for the same reason.
 */
class SplitCircleLanModule : Module() {

  private companion object {
    /**
     * MUST STAY BYTE-IDENTICAL TO THE SWIFT HALF (doc 35, critical #3).
     *
     * This previously carried a TRAILING DOT (`"_manasplit-mesh._tcp."`),
     * which is the form Android's own NSD documentation and samples use, while
     * the Swift half uses `"_manasplit-mesh._tcp"` — the form Apple's
     * Network.framework documentation requires and the exact string declared in
     * Info.plist's NSBonjourServices. Each platform was following its own
     * vendor's convention, which is what made the mismatch invisible: both
     * halves looked correct in isolation.
     *
     * AOSP's mDNS query construction splits the raw type string on literal '.'
     * with no trailing-dot normalization, so the extra dot can reach the wire
     * and make the two platforms advertise/browse different names — iOS and
     * Android would never discover each other, silently, with no error and no
     * way to tell it apart from "no peers nearby".
     *
     * Normalized to the no-dot form because that is what iOS REQUIRES and what
     * Info.plist already declares; Android accepts it. There is no version of
     * this worth risking on a documentation nuance, so the two strings are now
     * literally the same characters.
     */
    const val SERVICE_TYPE = "_manasplit-mesh._tcp"
    /** Refuse absurd frames rather than buffering into an OOM. */
    const val MAX_FRAME_BYTES = 8 * 1024 * 1024
    /** Bounded so a silent or stale peer cannot hold a thread and socket forever. */
    const val HANDSHAKE_TIMEOUT_MS = 10_000
    const val CONNECT_TIMEOUT_MS = 5_000
  }

  private val lock = Any()
  private val io = Executors.newCachedThreadPool()

  private var localDeviceId = ""
  private var trusted: Set<String> = emptySet()
  private var running = false

  private var serverSocket: ServerSocket? = null
  private var nsd: NsdManager? = null
  private var registrationListener: NsdManager.RegistrationListener? = null
  private var discoveryListener: NsdManager.DiscoveryListener? = null

  /** Sockets whose identity handshake completed, keyed by remote device id. */
  private val peers = ConcurrentHashMap<String, Socket>()
  private val outputs = ConcurrentHashMap<String, DataOutputStream>()

  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("No React context")

  override fun definition() = ModuleDefinition {
    Name("SplitCircleLan")

    Events("onFrame", "onPeersChanged")

    Function("isAvailable") {
      context.getSystemService(Context.NSD_SERVICE) != null
    }

    AsyncFunction("start") { deviceId: String, trustedIds: List<String> ->
      synchronized(lock) {
        if (running) {
          trusted = trustedIds.toSet()
          return@synchronized true
        }
        localDeviceId = deviceId
        trusted = trustedIds.toSet()
        try {
          startLocked()
          running = true
          true
        } catch (e: Throwable) {
          stopLocked()
          false
        }
      }
    }

    Function("stop") { synchronized(lock) { stopLocked() } }

    Function("updateTrust") { trustedIds: List<String> ->
      val dropped: List<String>
      synchronized(lock) {
        trusted = trustedIds.toSet()
        // Evict anyone who just lost trust. Sockets are independent, so
        // dropping one costs the others nothing.
        dropped = peers.keys.filter { it !in trusted }
        dropped.forEach { closePeer(it) }
      }
      if (dropped.isNotEmpty()) emitPeers()
    }

    Function("connectedPeers") {
      peers.keys.map { mapOf("deviceId" to it) }
    }

    AsyncFunction("sendFrame") { peerDeviceId: String, frame: String, promise: Promise ->
      // Captured together so the failure path below closes THIS socket, not
      // whatever happens to hold the id by the time the write fails — the same
      // instance-identity rule `closePeer` documents.
      val out: DataOutputStream?
      val socket: Socket?
      synchronized(peers) {
        out = outputs[peerDeviceId]
        socket = peers[peerDeviceId]
      }
      val bytes = frame.toByteArray(Charsets.UTF_8)
      if (out == null || bytes.size > MAX_FRAME_BYTES) {
        promise.resolve(false)
        return@AsyncFunction
      }
      io.execute {
        try {
          // Synchronized per stream: two concurrent writes would interleave a
          // length prefix with another frame's body and desynchronise the
          // stream permanently — there is no resync point in a length-prefixed
          // protocol.
          synchronized(out) {
            out.writeInt(bytes.size)
            out.write(bytes)
            out.flush()
          }
          promise.resolve(true)
        } catch (e: Throwable) {
          closePeer(peerDeviceId, socket)
          emitPeers()
          promise.resolve(false)
        }
      }
    }

    OnDestroy { synchronized(lock) { stopLocked() } }
  }

  // ------------------------------------------------------------- lifecycle

  private fun startLocked() {
    val server = ServerSocket(0)
    serverSocket = server
    val manager = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    nsd = manager

    // Port 0 lets the OS choose; the chosen port is what gets advertised, so
    // registration must happen AFTER binding.
    val info = NsdServiceInfo().apply {
      serviceName = localDeviceId
      serviceType = SERVICE_TYPE
      port = server.localPort
    }
    val registration = object : NsdManager.RegistrationListener {
      override fun onServiceRegistered(info: NsdServiceInfo) = Unit
      override fun onRegistrationFailed(info: NsdServiceInfo, code: Int) = Unit
      override fun onServiceUnregistered(info: NsdServiceInfo) = Unit
      override fun onUnregistrationFailed(info: NsdServiceInfo, code: Int) = Unit
    }
    registrationListener = registration
    manager.registerService(info, NsdManager.PROTOCOL_DNS_SD, registration)

    val discovery = object : NsdManager.DiscoveryListener {
      override fun onDiscoveryStarted(type: String) = Unit
      override fun onDiscoveryStopped(type: String) = Unit
      override fun onStartDiscoveryFailed(type: String, code: Int) = Unit
      override fun onStopDiscoveryFailed(type: String, code: Int) = Unit
      override fun onServiceLost(info: NsdServiceInfo) = Unit
      override fun onServiceFound(info: NsdServiceInfo) {
        val name = info.serviceName ?: return
        // ONE socket per pair, decided without negotiation: the lower id dials.
        if (name == localDeviceId || localDeviceId >= name) return
        if (peers.containsKey(name)) return
        if (name !in trusted) return
        @Suppress("DEPRECATION")
        manager.resolveService(info, object : NsdManager.ResolveListener {
          override fun onResolveFailed(info: NsdServiceInfo, code: Int) = Unit
          override fun onServiceResolved(resolved: NsdServiceInfo) {
            io.execute { dial(resolved.host, resolved.port) }
          }
        })
      }
    }
    discoveryListener = discovery
    manager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discovery)

    thread(isDaemon = true, name = "splitcircle-lan-accept") {
      while (true) {
        val socket = try { server.accept() } catch (e: Throwable) { return@thread }
        io.execute { handshake(socket) }
      }
    }
  }

  private fun stopLocked() {
    running = false
    val manager = nsd
    try { registrationListener?.let { manager?.unregisterService(it) } } catch (_: Throwable) {}
    try { discoveryListener?.let { manager?.stopServiceDiscovery(it) } } catch (_: Throwable) {}
    registrationListener = null
    discoveryListener = null
    nsd = null
    try { serverSocket?.close() } catch (_: Throwable) {}
    serverSocket = null
    peers.keys.toList().forEach { closePeer(it) }
  }

  private fun dial(host: InetAddress?, port: Int) {
    if (host == null || port <= 0) return
    try {
      // Bounded connect. `Socket(host, port)` uses the OS default, which on a
      // stale mDNS record for a device that has left the network can block this
      // pool thread for minutes.
      val socket = Socket()
      socket.connect(InetSocketAddress(host, port), CONNECT_TIMEOUT_MS)
      handshake(socket)
    } catch (_: Throwable) {
      // Ordinary on a mesh — the peer may have gone before we connected.
    }
  }

  // -------------------------------------------------------------- framing

  /**
   * Exchanges identity, then pumps frames.
   *
   * Both sides announce first and neither trusts the socket until the other
   * has: the network authenticates nothing, so anyone on the LAN can open a
   * connection and claim an id.
   */
  private fun handshake(socket: Socket) {
    var deviceId: String? = null
    try {
      socket.tcpNoDelay = true
      // A peer that opens a socket and never announces itself would otherwise
      // hold this thread parked in readInt() forever, and its socket with it —
      // an unbounded accumulation reachable by anyone on the LAN (doc 35).
      // Cleared once the handshake completes: an established peer may legitimately
      // stay silent for hours, and a read timeout after that point would drop
      // healthy idle links.
      socket.soTimeout = HANDSHAKE_TIMEOUT_MS
      val input = DataInputStream(socket.getInputStream().buffered())
      val output = DataOutputStream(socket.getOutputStream().buffered())

      val self = localDeviceId.toByteArray(Charsets.UTF_8)
      synchronized(output) {
        output.writeInt(self.size)
        output.write(self)
        output.flush()
      }

      val claimedLength = input.readInt()
      if (claimedLength <= 0 || claimedLength > MAX_FRAME_BYTES) { socket.close(); return }
      val claimedBytes = ByteArray(claimedLength)
      input.readFully(claimedBytes)
      val claimed = String(claimedBytes, Charsets.UTF_8).trim()

      if (claimed.isEmpty() || claimed !in trusted) { socket.close(); return }

      // Duplicate-socket dedup for the tie case; keep one deterministically so
      // both ends independently reach the same verdict.
      // Under the same monitor `closePeer` uses, so a dying thread's cleanup
      // cannot interleave between the eviction and the registration.
      synchronized(peers) {
        peers[claimed]?.let { existing ->
          if (localDeviceId > claimed) { socket.close(); return }
          try { existing.close() } catch (_: Throwable) {}
        }
        peers[claimed] = socket
        outputs[claimed] = output
      }

      deviceId = claimed
      socket.soTimeout = 0
      emitPeers()

      while (true) {
        val length = input.readInt()
        // Garbage or hostile: a length-prefixed stream has no resync point, so
        // the connection cannot be recovered — drop it rather than guess.
        if (length <= 0 || length > MAX_FRAME_BYTES) break
        val payload = ByteArray(length)
        input.readFully(payload)
        sendEvent(
          "onFrame",
          mapOf("peerDeviceId" to claimed, "frame" to String(payload, Charsets.UTF_8)),
        )
      }
    } catch (_: Throwable) {
      // Disconnects are the normal case here, not an exception worth logging.
    } finally {
      // BY INSTANCE: this thread may be unwinding long after the peer
      // reconnected on a different socket. See `closePeer`.
      deviceId?.let { closePeer(it, socket) }
      try { socket.close() } catch (_: Throwable) {}
      if (deviceId != null) emitPeers()
    }
  }

  /**
   * Drops a peer's socket — but only if [socket] is still the one registered
   * (doc 35).
   *
   * Closing by id alone could kill a brand-new HEALTHY connection. Peer X's app
   * dies without a clean FIN, so our handshake thread sits blocked in
   * `readInt()` on the dead socket while it is still the registered peer. X
   * reconnects; the dedup below closes the old socket (unblocking that thread)
   * and registers the new one. If the first thread's `finally` then runs — an
   * uncontrolled scheduling race — an id-only close removes the NEW socket, and
   * the live connection silently disappears until the next reconnect cycle.
   *
   * iOS's `drop()` already checked identity; this half did not. Passing null
   * means "whatever is there", for the deliberate teardown paths.
   */
  private fun closePeer(deviceId: String, socket: Socket? = null) {
    synchronized(peers) {
      val current = peers[deviceId]
      if (socket != null && current !== socket) {
        // Someone else's socket owns this id now. Close only what we were given.
        try { socket.close() } catch (_: Throwable) {}
        return
      }
      peers.remove(deviceId)
      outputs.remove(deviceId)
      current?.let { try { it.close() } catch (_: Throwable) {} }
    }
  }

  private fun emitPeers() {
    sendEvent("onPeersChanged", mapOf("peers" to peers.keys.map { mapOf("deviceId" to it) }))
  }
}
