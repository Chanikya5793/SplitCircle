package expo.modules.splitcircleble

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.ParcelUuid
import androidx.core.content.ContextCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID

/**
 * BLE transport, Android half (ai_layer/docs/33 Phase 3).
 *
 * Deliberately thin: connect to trusted peers, move opaque chunk strings,
 * report reachability. Fragmentation, reassembly, ordering and bounds live in
 * `src/services/mesh/bleFraming.ts` so the Swift and Kotlin halves cannot drift
 * on header layout — a bug that would only appear between an iPhone and a
 * Pixel, on real radios, and would look like corruption rather than a protocol
 * mismatch.
 *
 * Every device runs BOTH GATT roles at once, because a mesh has no clients or
 * servers. That is the source of most of the complexity here:
 *
 *  - As PERIPHERAL we advertise, and peers write chunks into our characteristic
 *    (`onCharacteristicWriteRequest`). We push chunks back with a notification.
 *  - As CENTRAL we scan and connect, write chunks to the peer's characteristic,
 *    and receive theirs via `onCharacteristicChanged`.
 *
 * So a chunk travels a different API depending on which side opened the link,
 * and `sendChunk` has to pick. `centralLinks`/`peripheralLinks` is that record.
 */
class SplitCircleBleModule : Module() {

  private companion object {
    val SERVICE_UUID: UUID = UUID.fromString("5C1E0001-5B1E-4A7F-9C3D-6F9B8E2A1C3D")
    val CHUNK_UUID: UUID = UUID.fromString("5C1E0002-5B1E-4A7F-9C3D-6F9B8E2A1C3D")
    val IDENTITY_UUID: UUID = UUID.fromString("5C1E0003-5B1E-4A7F-9C3D-6F9B8E2A1C3D")

    /** Standard Client Characteristic Configuration descriptor. */
    val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

    /**
     * Largest MTU Android will negotiate. Asking for it costs one round trip and
     * turns a 20-byte payload into ~512, which is the difference between a
     * message being practical over BLE and not.
     */
    const val REQUESTED_MTU = 517
    const val DEFAULT_ATT_MTU = 23

    /**
     * Hex chars of the device id placed in the advertisement. An advert has
     * ~31 bytes total and cannot carry a 36-char UUID, so this is a discovery
     * hint and a connect-direction tiebreak ONLY — never an identity claim.
     * The full id is read from the identity characteristic after connecting,
     * and that is what trust is checked against.
     */
    const val ADVERTISED_PREFIX_LENGTH = 8
  }

  private val lock = Any()

  private var localDeviceId: String = ""
  private var trustedDeviceIds: Set<String> = emptySet()
  private var running = false

  private var advertiser: BluetoothLeAdvertiser? = null
  private var gattServer: BluetoothGattServer? = null
  private var chunkCharacteristic: BluetoothGattCharacteristic? = null

  /** Links where WE dialled out. Keyed by resolved remote device id. */
  private val centralLinks = mutableMapOf<String, BluetoothGatt>()

  /**
   * Peers whose identity we have READ but to whom we have not yet successfully
   * WRITTEN ours. Mirrors the Swift half's `announcingLinks` (doc 35).
   *
   * Deliberately not `centralLinks`: that map is what `connectedPeers()` and
   * `sendChunk()` read, so publishing a peer into it at identity-read time made
   * it sendable before it could attribute our chunks back to us. `emitPeers()`
   * was already correctly deferred to the announce write, but `connectedPeers()`
   * bypasses that and reads the map directly — so any unrelated `emitPeers()` in
   * the window (a third device connecting, routine with 2+ phones around) put
   * the half-announced peer in a snapshot, JS sent to it, and the remote dropped
   * the chunk under its own "no identity yet" guard WHILE ACKING THE WRITE AS
   * SUCCESS. Reported delivered by every layer, never requeued, gone.
   *
   * Only the duplicate-link tie-break may read this.
   */
  private val announcingLinks = mutableMapOf<String, BluetoothGatt>()

  /** Guards the shared `chunkCharacteristic` value across notifies. See `notifyChunk`. */
  private val notifyLock = Any()
  /** Links where the peer dialled US. Keyed by resolved remote device id. */
  private val peripheralLinks = mutableMapOf<String, BluetoothDevice>()

  private val mtuByDeviceId = mutableMapOf<String, Int>()
  /** Address -> device id, filled once the identity characteristic is read. */
  private val identityByAddress = mutableMapOf<String, String>()

  /**
   * One outstanding write per GATT link, resolved from the write callback.
   * Android permits a single in-flight operation per connection; issuing a
   * second silently returns false and drops the first's completion.
   */
  private val pendingWrites = mutableMapOf<String, Promise>()

  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("No React context")

  private val adapter: BluetoothAdapter?
    get() = (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

  // ---------------------------------------------------------------- module

  override fun definition() = ModuleDefinition {
    Name("SplitCircleBle")

    Events("onChunk", "onPeersChanged")

    /**
     * HARDWARE AND RADIO ONLY — deliberately NOT permissions.
     *
     * This used to include `hasPermissions()`, which deadlocked the whole
     * transport: `bleTransport.start()` short-circuits on `isAvailable()`, so
     * with permissions ungranted this returned false, start never ran, and the
     * runtime permission request that lives inside start was never reached.
     * Permission could not be obtained without starting, and starting could not
     * happen without permission. The UI then reported "Unavailable on this
     * device" on hardware that was perfectly capable.
     *
     * Consent is a separate question from capability, and `hasPermissions` below
     * answers it separately so the UI can say which one is actually missing.
     */
    Function("isAvailable") {
      val bluetoothAdapter = adapter
      bluetoothAdapter != null &&
        bluetoothAdapter.isEnabled &&
        bluetoothAdapter.bluetoothLeAdvertiser != null
    }

    /** Exposed so the UI can distinguish "no permission" from "no radio". */
    Function("hasPermissions") {
      hasPermissions()
    }

    AsyncFunction("start") { deviceId: String, trusted: List<String> ->
      synchronized(lock) {
        if (running) {
          // Idempotent: a trust refresh must not tear the radio down.
          trustedDeviceIds = trusted.toSet()
          return@synchronized true
        }
        val bluetoothAdapter = adapter
        if (bluetoothAdapter == null || !bluetoothAdapter.isEnabled || !hasPermissions()) {
          return@synchronized false
        }
        localDeviceId = deviceId
        trustedDeviceIds = trusted.toSet()
        val started = startPeripheralLocked() && startCentralLocked()
        running = started
        if (!started) stopLocked()
        started
      }
    }

    Function("stop") {
      synchronized(lock) { stopLocked() }
    }

    Function("updateTrust") { trusted: List<String> ->
      val dropped: List<String>
      synchronized(lock) {
        trustedDeviceIds = trusted.toSet()
        // Evict anyone who just lost trust. Unlike MultipeerConnectivity (whose
        // single shared MCSession forced an all-peer teardown, doc 32 §10.2),
        // BLE links are independent — dropping one costs the others nothing.
        dropped = (centralLinks.keys + peripheralLinks.keys)
          .filter { it !in trustedDeviceIds }
          .distinct()
        dropped.forEach { disconnectLocked(it) }
      }
      if (dropped.isNotEmpty()) emitPeers()
    }

    Function("connectedPeers") {
      synchronized(lock) { snapshotPeersLocked() }
    }

    AsyncFunction("sendChunk") { peerDeviceId: String, chunk: String, promise: Promise ->
      sendChunk(peerDeviceId, chunk, promise)
    }

    OnDestroy {
      synchronized(lock) { stopLocked() }
    }
  }

  // ------------------------------------------------------------ permissions

  private fun hasPermission(name: String): Boolean =
    ContextCompat.checkSelfPermission(context, name) == PackageManager.PERMISSION_GRANTED

  /**
   * The API 31 split is not cosmetic: below it BLE scanning is gated on LOCATION
   * (a scan can infer position), and above it on the dedicated Bluetooth
   * permissions. Checking only one set leaves the other platform version
   * permanently unable to scan, with no error beyond an empty result list.
   */
  private fun hasPermissions(): Boolean =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      hasPermission(Manifest.permission.BLUETOOTH_SCAN) &&
        hasPermission(Manifest.permission.BLUETOOTH_CONNECT) &&
        hasPermission(Manifest.permission.BLUETOOTH_ADVERTISE)
    } else {
      hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)
    }

  // -------------------------------------------------------------- lifecycle

  @SuppressLint("MissingPermission")
  private fun startPeripheralLocked(): Boolean {
    val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
      ?: return false

    val server = manager.openGattServer(context, serverCallback) ?: return false
    gattServer = server

    val chunk = BluetoothGattCharacteristic(
      CHUNK_UUID,
      BluetoothGattCharacteristic.PROPERTY_WRITE or
        BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE or
        BluetoothGattCharacteristic.PROPERTY_NOTIFY,
      BluetoothGattCharacteristic.PERMISSION_WRITE,
    )
    chunk.addDescriptor(
      BluetoothGattDescriptor(
        CCCD_UUID,
        BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE,
      ),
    )
    chunkCharacteristic = chunk

    // READ **and** WRITE. GATT is asymmetric — only the central can initiate —
    // so a peripheral has no way to ask "who are you?". Without a writable
    // identity characteristic the peripheral never learns the central's id,
    // `identityByAddress` stays empty on that side, and every inbound chunk is
    // dropped by the lookup in onCharacteristicWriteRequest. The link would
    // look established from both ends and carry traffic in one direction only.
    val identity = BluetoothGattCharacteristic(
      IDENTITY_UUID,
      BluetoothGattCharacteristic.PROPERTY_READ or BluetoothGattCharacteristic.PROPERTY_WRITE,
      BluetoothGattCharacteristic.PERMISSION_READ or BluetoothGattCharacteristic.PERMISSION_WRITE,
    )

    val service = BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)
    service.addCharacteristic(chunk)
    service.addCharacteristic(identity)
    server.addService(service)

    val bleAdvertiser = adapter?.bluetoothLeAdvertiser ?: return false
    advertiser = bleAdvertiser

    val settings = AdvertiseSettings.Builder()
      .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
      .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
      .setConnectable(true)
      .build()

    // The service UUID alone is 16 bytes of a ~31 byte budget, so the prefix
    // goes in a separate service-DATA field rather than the device name, which
    // Android may pad or truncate unpredictably.
    val data = AdvertiseData.Builder()
      .setIncludeDeviceName(false)
      .addServiceUuid(ParcelUuid(SERVICE_UUID))
      .addServiceData(ParcelUuid(SERVICE_UUID), advertisedPrefix().toByteArray(Charsets.UTF_8))
      .build()

    bleAdvertiser.startAdvertising(settings, data, advertiseCallback)
    return true
  }

  @SuppressLint("MissingPermission")
  private fun startCentralLocked(): Boolean {
    val scanner = adapter?.bluetoothLeScanner ?: return false
    val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE_UUID)).build()
    val settings = ScanSettings.Builder()
      .setScanMode(ScanSettings.SCAN_MODE_BALANCED)
      .build()
    scanner.startScan(listOf(filter), settings, scanCallback)
    return true
  }

  @SuppressLint("MissingPermission")
  private fun stopLocked() {
    running = false
    try { advertiser?.stopAdvertising(advertiseCallback) } catch (_: Throwable) {}
    try { adapter?.bluetoothLeScanner?.stopScan(scanCallback) } catch (_: Throwable) {}
    advertiser = null

    centralLinks.values.forEach { gatt ->
      try { gatt.disconnect() } catch (_: Throwable) {}
      try { gatt.close() } catch (_: Throwable) {}
    }
    centralLinks.clear()
    announcingLinks.clear()
    peripheralLinks.clear()
    mtuByDeviceId.clear()
    identityByAddress.clear()

    // Fail every in-flight write rather than leaving JS promises pending
    // forever — bleTransport treats false as undeliverable and the router
    // stores and forwards, but a promise that never settles wedges the queue.
    pendingWrites.values.forEach { it.resolve(false) }
    pendingWrites.clear()

    try { gattServer?.close() } catch (_: Throwable) {}
    gattServer = null
    chunkCharacteristic = null
  }

  /**
   * Drops every link to ONE peer, in both roles. Caller must hold `lock`.
   *
   * A peer can hold a central link, a peripheral link, or (during the prefix-tie
   * window) both, so all of them have to go — leaving one behind would keep the
   * device reachable after its trust was revoked, which is the entire point of
   * calling this.
   */
  @SuppressLint("MissingPermission")
  private fun disconnectLocked(deviceId: String) {
    announcingLinks.remove(deviceId)
    centralLinks.remove(deviceId)?.let { gatt ->
      identityByAddress.remove(gatt.address())
      try { gatt.disconnect() } catch (_: Throwable) {}
      try { gatt.close() } catch (_: Throwable) {}
    }
    peripheralLinks.remove(deviceId)?.let { device ->
      identityByAddress.remove(device.address)
      try { gattServer?.cancelConnection(device) } catch (_: Throwable) {}
    }
    mtuByDeviceId.remove(deviceId)
    // Settle rather than strand: bleTransport awaits this promise, and a write
    // to a peer we just evicted can never complete.
    pendingWrites.remove(deviceId)?.resolve(false)
  }

  private fun advertisedPrefix(): String =
    localDeviceId.replace("-", "").take(ADVERTISED_PREFIX_LENGTH).lowercase()

  // ------------------------------------------------------------ central role

  private val scanCallback = object : ScanCallback() {
    @SuppressLint("MissingPermission")
    override fun onScanResult(callbackType: Int, result: ScanResult) {
      // BOTH advertisement formats. Android puts the prefix in service DATA,
      // but CBPeripheralManager CANNOT advertise service data at all — iOS can
      // only advertise a local name. Reading just our own format means Android
      // discovers only other Androids, which defeats the entire point of this
      // transport. The iOS half reads both fields for the same reason.
      val record = result.scanRecord ?: return
      val remotePrefix = (
        record.getServiceData(ParcelUuid(SERVICE_UUID))?.toString(Charsets.UTF_8)
          ?: record.deviceName
        )?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: return

      synchronized(lock) {
        if (!running) return
        if (identityByAddress.containsKey(result.device.address)) return

        // ONE link per pair, decided without negotiation: the lower id dials.
        // Without this both devices connect to each other, producing two links
        // where chunks can arrive twice and MTUs differ per direction.
        //
        // On an exact prefix tie we connect anyway: two devices whose ids share
        // the first 8 hex chars is vanishingly rare, and a duplicate link is
        // recoverable (the dedup below drops one) where both sides declining to
        // dial is a permanent failure to ever meet.
        val localPrefix = advertisedPrefix()
        if (localPrefix > remotePrefix) return

        result.device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
      }
    }
  }

  private val gattCallback = object : BluetoothGattCallback() {
    @SuppressLint("MissingPermission")
    override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
      if (newState == BluetoothProfile.STATE_CONNECTED) {
        // MTU before service discovery: a larger MTU makes discovery itself
        // cheaper, and the negotiated value is what every later write is sized
        // against.
        gatt.requestMtu(REQUESTED_MTU)
        return
      }
      if (newState == BluetoothProfile.STATE_DISCONNECTED) {
        val deviceId = synchronized(lock) {
          val id = identityByAddress.remove(gatt.address())
          if (id != null) {
            centralLinks.remove(id)
            announcingLinks.remove(id)
            if (!peripheralLinks.containsKey(id)) mtuByDeviceId.remove(id)
            pendingWrites.remove(id)?.resolve(false)
          }
          try { gatt.close() } catch (_: Throwable) {}
          id
        }
        if (deviceId != null) emitPeers()
      }
    }

    @SuppressLint("MissingPermission")
    override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
      synchronized(lock) {
        val id = identityByAddress[gatt.address()]
        if (id != null) mtuByDeviceId[id] = mtu
        else pendingMtuByAddress[gatt.address()] = mtu
      }
      gatt.discoverServices()
    }

    @SuppressLint("MissingPermission")
    override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
      val service = gatt.getService(SERVICE_UUID) ?: run { gatt.disconnect(); return }
      val identity = service.getCharacteristic(IDENTITY_UUID) ?: run { gatt.disconnect(); return }
      // Identity BEFORE anything else: trust is checked against the full id,
      // never the advertised prefix, which any device can claim.
      gatt.readCharacteristic(identity)
    }

    @Suppress("DEPRECATION")
    @SuppressLint("MissingPermission")
    override fun onCharacteristicRead(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      status: Int,
    ) {
      if (characteristic.uuid != IDENTITY_UUID) return
      val remoteId = characteristic.value?.toString(Charsets.UTF_8)?.trim().orEmpty()

      val accepted = synchronized(lock) {
        if (remoteId.isEmpty() || remoteId !in trustedDeviceIds) return@synchronized false
        // Duplicate-link dedup for the prefix-tie case above. Keep the link the
        // lower id opened so both sides independently reach the same verdict.
        if (centralLinks.containsKey(remoteId)
          || announcingLinks.containsKey(remoteId)
          || peripheralLinks.containsKey(remoteId)
        ) {
          if (localDeviceId > remoteId) return@synchronized false
        }
        identityByAddress[gatt.address()] = remoteId
        // STAGED, not published — see `announcingLinks`. It becomes sendable in
        // onCharacteristicWrite once our own identity has actually landed.
        announcingLinks[remoteId] = gatt
        pendingMtuByAddress.remove(gatt.address())?.let { mtuByDeviceId[remoteId] = it }
        true
      }

      if (!accepted) {
        gatt.disconnect()
        return
      }

      // CHAINED, one operation at a time. Android runs a single outstanding GATT
      // operation per connection: issuing the CCCD write and the identity write
      // together drops one silently. Each step is kicked off by the previous
      // step's callback — read identity → enable notifications → announce
      // ourselves → link is live.
      val chunk = gatt.getService(SERVICE_UUID)?.getCharacteristic(CHUNK_UUID)
      if (chunk == null) { gatt.disconnect(); return }
      gatt.setCharacteristicNotification(chunk, true)
      // Writing the CCCD is what actually turns notifications on. Skipping it
      // leaves setCharacteristicNotification a local-only no-op, and the link
      // silently becomes one-way.
      val cccd = chunk.getDescriptor(CCCD_UUID)
      if (cccd == null) { gatt.disconnect(); return }
      cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
      gatt.writeDescriptor(cccd)
    }

    @Suppress("DEPRECATION")
    @SuppressLint("MissingPermission")
    override fun onDescriptorWrite(
      gatt: BluetoothGatt,
      descriptor: BluetoothGattDescriptor,
      status: Int,
    ) {
      if (descriptor.uuid != CCCD_UUID) return
      // Announce ourselves. The peripheral cannot ask, so this write is the ONLY
      // way it learns our id — and therefore the only way it can attribute the
      // chunks we are about to send, or send any back.
      val identity = gatt.getService(SERVICE_UUID)?.getCharacteristic(IDENTITY_UUID)
      if (identity == null) { gatt.disconnect(); return }
      identity.value = localDeviceId.toByteArray(Charsets.UTF_8)
      identity.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
      gatt.writeCharacteristic(identity)
    }

    @Suppress("DEPRECATION")
    override fun onCharacteristicChanged(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
    ) {
      if (characteristic.uuid != CHUNK_UUID) return
      val payload = characteristic.value?.toString(Charsets.UTF_8) ?: return
      val deviceId = synchronized(lock) { identityByAddress[gatt.address()] } ?: return
      emitChunk(deviceId, payload)
    }

    override fun onCharacteristicWrite(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      status: Int,
    ) {
      when (characteristic.uuid) {
        // Our announcement landed: the peer can now attribute us, so the link
        // is genuinely bidirectional and only NOW worth reporting as a peer.
        // Emitting at connect time would advertise reachability the peer cannot
        // yet honour, and the router would send into a hole.
        IDENTITY_UUID -> {
          val promoted = synchronized(lock) {
            val remoteId = identityByAddress[gatt.address()]
            if (remoteId == null) {
              false
            } else {
              announcingLinks.remove(remoteId)
              if (status == BluetoothGatt.GATT_SUCCESS) {
                // Only NOW does it enter the map `connectedPeers()`/`sendChunk()`
                // read — the link is bidirectional at this instant and not before.
                centralLinks[remoteId] = gatt
                true
              } else {
                false
              }
            }
          }
          if (promoted) emitPeers() else gatt.disconnect()
        }
        CHUNK_UUID -> {
          val promise = synchronized(lock) {
            identityByAddress[gatt.address()]?.let { pendingWrites.remove(it) }
          }
          promise?.resolve(status == BluetoothGatt.GATT_SUCCESS)
        }
        else -> Unit
      }
    }
  }

  /** MTU can be negotiated before we know who the peer is; hold it by address. */
  private val pendingMtuByAddress = mutableMapOf<String, Int>()

  // --------------------------------------------------------- peripheral role

  private val advertiseCallback = object : AdvertiseCallback() {
    override fun onStartFailure(errorCode: Int) {
      synchronized(lock) { advertiser = null }
    }
  }

  private val serverCallback = object : BluetoothGattServerCallback() {
    @SuppressLint("MissingPermission")
    override fun onCharacteristicReadRequest(
      device: BluetoothDevice,
      requestId: Int,
      offset: Int,
      characteristic: BluetoothGattCharacteristic,
    ) {
      if (characteristic.uuid != IDENTITY_UUID) {
        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, 0, null)
        return
      }
      val bytes = localDeviceId.toByteArray(Charsets.UTF_8)
      // Honour `offset`: a device id is 36 bytes and does not fit the 23-byte
      // default MTU, so Android issues a second read for the remainder. Ignoring
      // it truncates every identity to 22 bytes before MTU negotiation lands.
      val slice = if (offset >= bytes.size) ByteArray(0) else bytes.copyOfRange(offset, bytes.size)
      gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, slice)
    }

    @SuppressLint("MissingPermission")
    override fun onCharacteristicWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      characteristic: BluetoothGattCharacteristic,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray?,
    ) {
      if (responseNeeded) {
        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null)
      }

      if (characteristic.uuid == IDENTITY_UUID) {
        val claimedId = value?.toString(Charsets.UTF_8)?.trim().orEmpty()
        val accepted = synchronized(lock) {
          if (claimedId.isEmpty() || claimedId !in trustedDeviceIds) return@synchronized false
          identityByAddress[device.address] = claimedId
          peripheralLinks[claimedId] = device
          pendingMtuByAddress.remove(device.address)?.let { mtuByDeviceId[claimedId] = it }
          true
        }
        // Trust is enforced on BOTH roles. The central checks the peripheral by
        // reading its identity; this is the mirror. Without it any device that
        // can see the advertisement could write chunks into the server, since
        // BLE itself authenticates nothing.
        if (accepted) emitPeers() else gattServer?.cancelConnection(device)
        return
      }

      if (characteristic.uuid != CHUNK_UUID) return
      val payload = value?.toString(Charsets.UTF_8) ?: return
      // No identity yet means the peer sent chunks before announcing itself.
      // Dropping is correct: an unattributed chunk cannot be routed, and
      // accepting it would let an untrusted device inject into the mesh.
      val deviceId = synchronized(lock) { identityByAddress[device.address] } ?: return
      emitChunk(deviceId, payload)
    }

    @SuppressLint("MissingPermission")
    override fun onDescriptorWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      descriptor: BluetoothGattDescriptor,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray?,
    ) {
      if (responseNeeded) {
        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null)
      }
    }

    override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
      synchronized(lock) {
        val id = identityByAddress[device.address]
        if (id != null) mtuByDeviceId[id] = mtu else pendingMtuByAddress[device.address] = mtu
      }
    }

    override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
      if (newState != BluetoothProfile.STATE_DISCONNECTED) return
      val deviceId = synchronized(lock) {
        val id = identityByAddress[device.address]
        if (id != null) {
          peripheralLinks.remove(id)
          if (!centralLinks.containsKey(id)) mtuByDeviceId.remove(id)
        }
        pendingMtuByAddress.remove(device.address)
        id
      }
      if (deviceId != null) emitPeers()
    }
  }

  // ------------------------------------------------------------------ send

  /**
   * Serializes "set the shared characteristic value, then notify" (doc 35).
   *
   * On API 33+ the framework takes the bytes as an argument, so there is no
   * shared mutable state to race on and this is genuinely correct rather than
   * merely serialized. Below that, the deprecated two-step is all there is, and
   * a dedicated lock is the only thing standing between two concurrent sends
   * and one peer receiving another peer's bytes.
   *
   * `notifyLock`, not the module `lock`: this runs OUTSIDE the module lock by
   * design (a binder call must not be made while holding it), and giving it its
   * own mutex keeps that property while still making the pair atomic.
   */
  @Suppress("DEPRECATION")
  @SuppressLint("MissingPermission")
  private fun notifyChunk(
    server: BluetoothGattServer,
    device: BluetoothDevice,
    characteristic: BluetoothGattCharacteristic,
    bytes: ByteArray,
  ): Boolean = synchronized(notifyLock) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      server.notifyCharacteristicChanged(device, characteristic, false, bytes) ==
        BluetoothStatusCodes.SUCCESS
    } else {
      characteristic.value = bytes
      server.notifyCharacteristicChanged(device, characteristic, false)
    }
  }

  @Suppress("DEPRECATION")
  @SuppressLint("MissingPermission")
  private fun sendChunk(peerDeviceId: String, chunk: String, promise: Promise) {
    val bytes = chunk.toByteArray(Charsets.UTF_8)
    val action: (() -> Unit)?

    synchronized(lock) {
      if (!running) { promise.resolve(false); return }

      // One in-flight write per peer. Android permits a single outstanding GATT
      // operation per connection and silently returns false for a second, which
      // would also strand the first promise.
      if (pendingWrites.containsKey(peerDeviceId)) { promise.resolve(false); return }

      val gatt = centralLinks[peerDeviceId]
      if (gatt != null) {
        val characteristic = gatt.getService(SERVICE_UUID)?.getCharacteristic(CHUNK_UUID)
        if (characteristic == null) { promise.resolve(false); return }
        characteristic.value = bytes
        characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        pendingWrites[peerDeviceId] = promise
        action = {
          if (!gatt.writeCharacteristic(characteristic)) {
            synchronized(lock) { pendingWrites.remove(peerDeviceId) }?.resolve(false)
          }
        }
      } else {
        val device = peripheralLinks[peerDeviceId]
        val characteristic = chunkCharacteristic
        val server = gattServer
        if (device == null || characteristic == null || server == null) {
          promise.resolve(false); return
        }
        // THE VALUE IS NOT SET HERE (doc 35). `chunkCharacteristic` is a single
        // module-level object shared by every peripheral-linked peer, so setting
        // it under `lock` and notifying outside the lock let two concurrent
        // sends interleave: thread 2 overwrote the value between thread 1's set
        // and thread 1's notify, and peer X received peer Y's bytes. Silent
        // cross-peer corruption, reported successful to both. Not rare —
        // `broadcastQueuedNearbyMessages()` and `router.flush()` both fire
        // un-awaited off the same neighbour-change event.
        //
        // Notification, not indication: there is no confirmation callback for
        // notifications, so this resolves on the local enqueue result. The
        // framing layer's reassembly TTL is what actually covers a lost chunk.
        action = { promise.resolve(notifyChunk(server, device, characteristic, bytes)) }
      }
    }

    // Outside the lock: these calls re-enter callbacks on other threads.
    action?.invoke()
  }

  // ---------------------------------------------------------------- events

  private fun snapshotPeersLocked(): List<Map<String, Any?>> =
    (centralLinks.keys + peripheralLinks.keys).distinct().map { id ->
      mapOf(
        "deviceId" to id,
        // The JS side subtracts the 3-byte ATT header, so report the negotiated
        // ATT MTU verbatim and let one place own that arithmetic.
        "mtu" to (mtuByDeviceId[id] ?: DEFAULT_ATT_MTU),
      )
    }

  private fun emitPeers() {
    val peers = synchronized(lock) { snapshotPeersLocked() }
    sendEvent("onPeersChanged", mapOf("peers" to peers))
  }

  private fun emitChunk(peerDeviceId: String, chunk: String) {
    sendEvent("onChunk", mapOf("peerDeviceId" to peerDeviceId, "chunk" to chunk))
  }
}

@SuppressLint("MissingPermission")
private fun BluetoothGatt.address(): String = this.device.address
