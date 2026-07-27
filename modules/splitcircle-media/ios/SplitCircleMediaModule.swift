import ExpoModulesCore
import Photos
import PhotosUI
import UIKit

/// Photos access that survives "Optimize iPhone Storage".
///
/// WHY THIS EXISTS. `expo-image-picker` materializes every selected asset
/// before `launchImageLibraryAsync` resolves. For a library that lives mostly
/// in iCloud that means downloading the full original — potentially hundreds
/// of MB per video — inside the picker call, and its fast path calls
/// `PHAssetResourceManager.writeData` WITHOUT setting `progressHandler` and
/// with no cancellation. The user therefore sees a frozen app for as long as
/// the download takes, with no progress, no way out, and a watchdog kill or
/// memory crash if the file is large enough.
///
/// The fix is to separate the three things that call was doing at once:
///
///   1. `pickAssets`        — identifiers and metadata only. Returns instantly;
///                            touches no file data whatsoever.
///   2. `requestThumbnail`  — a small local render for the preview UI. Photos
///                            keeps thumbnails on-device even under Optimize
///                            Storage, which is the entire point of that
///                            setting, so this stays fast for iCloud assets.
///   3. `materializeAsset`  — the actual (possibly very slow) fetch of the
///                            original, with real progress and real
///                            cancellation, deferred until the user has
///                            committed to sending.
///
/// Only step 3 can be slow, and by then the send pipeline already has a
/// progress ring and a Cancel control to attach it to.
public class SplitCircleMediaModule: Module {
  /// In-flight resource requests, keyed by the JS-supplied request id so a
  /// specific item can be cancelled. Guarded because Photos invokes its
  /// handlers on arbitrary queues.
  private var activeRequests: [String: PHAssetResourceDataRequestID] = [:]
  /// Ids cancelled before their request id was registered — a user can hit
  /// Cancel in the window between JS calling materialize and Photos handing
  /// back an id, and without this that cancel would be silently lost.
  private var cancelledBeforeStart: Set<String> = []
  private let requestLock = NSLock()

  private var pickerDelegate: PickerDelegate?

  public func definition() -> ModuleDefinition {
    Name("SplitCircleMedia")

    Events("onMaterializeProgress")

    /// Write a line to the device log from JS.
    ///
    /// A Release build's `console.*` never reaches the device log, so the only
    /// way to see what the JS half of this pipeline is doing on a real phone
    /// is to hand the string to NSLog. Kept deliberately trivial and cheap;
    /// callers gate their own verbosity.
    Function("log") { (message: String) in
      NSLog("[SCMedia/JS] %@", message)
    }

    /// Present the system picker and return identifiers + metadata only.
    ///
    /// `PHPickerConfiguration(photoLibrary:)` is required rather than the
    /// bare initialiser: without an explicit library the results come back
    /// with `assetIdentifier == nil`, and the identifier is the whole point.
    /// That does mean this path needs library authorization, which the app
    /// already requests before calling here.
    AsyncFunction("pickAssets") { (selectionLimit: Int, mediaTypes: String, promise: Promise) in
      NSLog("[SCMedia] pickAssets limit=%d types=%@", selectionLimit, mediaTypes)
      DispatchQueue.main.async { [weak self] in
        guard let self else {
          promise.reject("E_MODULE_GONE", "Media module was deallocated.")
          return
        }
        guard let presenter = self.appContext?.utilities?.currentViewController() else {
          NSLog("[SCMedia] pickAssets FAILED: no presenter")
          promise.reject("E_NO_PRESENTER", "No view controller available to present the picker.")
          return
        }

        var config = PHPickerConfiguration(photoLibrary: .shared())
        config.selectionLimit = selectionLimit
        config.preferredAssetRepresentationMode = .current
        // Preserve the order the user tapped items in — the chat sends each
        // as its own message and that order is meaningful.
        config.selection = .ordered
        switch mediaTypes {
        case "images": config.filter = .images
        case "videos": config.filter = .videos
        default: config.filter = .any(of: [.images, .videos])
        }

        let picker = PHPickerViewController(configuration: config)
        let delegate = PickerDelegate { [weak self] results in
          self?.pickerDelegate = nil
          promise.resolve(Self.metadata(for: results))
        }
        self.pickerDelegate = delegate
        picker.delegate = delegate
        NSLog("[SCMedia] presenting PHPicker from %@", String(describing: type(of: presenter)))
        presenter.present(picker, animated: true)
      }
    }

    /// A small, cheap render for preview UI. Never blocks on a full download.
    AsyncFunction("requestThumbnail") { (assetId: String, maxPixel: Double, promise: Promise) in
      guard let asset = Self.fetchAsset(assetId) else {
        promise.reject("E_ASSET_NOT_FOUND", "That item is no longer in the photo library.")
        return
      }

      let options = PHImageRequestOptions()
      // NETWORK ACCESS OFF — this is load-bearing, not an optimisation.
      //
      // With it on, asking for a `.highQualityFormat` poster frame of a video
      // that lives in iCloud makes Photos download THE WHOLE VIDEO to render
      // one frame. That call sits in a Promise.all before the picker hands
      // anything back to the chat, so it reproduced the exact freeze this
      // module was built to remove — just moved one layer down.
      //
      // Photos keeps small renditions on-device even under Optimize Storage
      // (that is the point of the setting), so the local copy is almost always
      // there. When it genuinely is not, we return a clear "in cloud" failure
      // and the UI shows a placeholder — never a stall.
      options.isNetworkAccessAllowed = false
      // A single callback, unlike `.opportunistic`, which fires twice and
      // would otherwise leave us resolving with the blurry degraded frame.
      options.deliveryMode = .highQualityFormat
      options.resizeMode = .fast
      options.isSynchronous = false

      let target = CGSize(width: maxPixel, height: maxPixel)
      var settled = false

      PHImageManager.default().requestImage(
        for: asset,
        targetSize: target,
        contentMode: .aspectFit,
        options: options
      ) { image, info in
        // `.opportunistic` can call back twice (degraded then full). Even on
        // `.highQualityFormat` guard against a double resume, which would
        // crash the bridge.
        guard !settled else { return }

        if let cancelled = info?[PHImageCancelledKey] as? Bool, cancelled {
          settled = true
          promise.reject("E_CANCELLED", "Thumbnail request was cancelled.")
          return
        }
        if let error = info?[PHImageErrorKey] as? NSError {
          settled = true
          promise.reject("E_THUMBNAIL", error.localizedDescription)
          return
        }
        if image == nil, let inCloud = info?[PHImageResultIsInCloudKey] as? Bool, inCloud {
          settled = true
          // Deliberately NOT retried with network access on — see the options
          // comment above. The caller shows a placeholder instead.
          NSLog("[SCMedia] thumbnail unavailable locally (in iCloud) for %@", assetId)
          promise.reject("E_IN_CLOUD", "No local preview for this item.")
          return
        }
        guard let image, let data = image.jpegData(compressionQuality: 0.85) else {
          settled = true
          NSLog("[SCMedia] thumbnail render failed for %@", assetId)
          promise.reject("E_THUMBNAIL", "Could not render a preview for this item.")
          return
        }
        settled = true
        do {
          let url = try Self.cacheURL(extension: "jpg", prefix: "thumb")
          try data.write(to: url, options: .atomic)
          promise.resolve([
            "uri": url.absoluteString,
            "width": image.size.width * image.scale,
            "height": image.size.height * image.scale,
          ])
        } catch {
          promise.reject("E_THUMBNAIL_WRITE", error.localizedDescription)
        }
      }
    }

    /// Stream the original asset to a file, reporting progress and honouring
    /// cancellation. This is the call that can take minutes on a large iCloud
    /// video, and the reason the whole module exists.
    AsyncFunction("materializeAsset") { (assetId: String, requestId: String, promise: Promise) in
      NSLog("[SCMedia] materialize start id=%@ req=%@", assetId, requestId)
      guard let asset = Self.fetchAsset(assetId) else {
        NSLog("[SCMedia] materialize FAILED: asset not found %@", assetId)
        promise.reject("E_ASSET_NOT_FOUND", "That item is no longer in the photo library.")
        return
      }

      let resources = PHAssetResource.assetResources(for: asset)
      NSLog("[SCMedia] asset media=%ld resources=%d types=%@", asset.mediaType.rawValue, resources.count,
            resources.map { String($0.type.rawValue) }.joined(separator: ","))
      // Prefer the edited/full-size rendition so a user's crop or filter from
      // the Photos app is what actually gets sent.
      let preferred: [PHAssetResourceType] = asset.mediaType == .video
        ? [.fullSizeVideo, .video]
        : [.fullSizePhoto, .photo]
      guard let resource = preferred.compactMap({ type in
        resources.first(where: { $0.type == type })
      }).first ?? resources.first else {
        promise.reject("E_NO_RESOURCE", "This item has no downloadable file.")
        return
      }

      NSLog("[SCMedia] chose resource type=%ld name=%@", resource.type.rawValue, resource.originalFilename)
      let ext = (resource.originalFilename as NSString).pathExtension
      let destination: URL
      do {
        destination = try Self.cacheURL(
          extension: ext.isEmpty ? (asset.mediaType == .video ? "mov" : "jpg") : ext,
          prefix: "asset"
        )
        FileManager.default.createFile(atPath: destination.path, contents: nil)
      } catch {
        promise.reject("E_CACHE", error.localizedDescription)
        return
      }

      guard let handle = try? FileHandle(forWritingTo: destination) else {
        promise.reject("E_CACHE", "Could not open a file to write this item to.")
        return
      }

      let options = PHAssetResourceRequestOptions()
      options.isNetworkAccessAllowed = true
      options.progressHandler = { [weak self] fraction in
        self?.sendEvent("onMaterializeProgress", [
          "requestId": requestId,
          "fraction": fraction,
        ])
      }

      var settled = false

      let succeed: () -> Void = { [weak self] in
        guard !settled else { return }
        settled = true
        try? handle.close()
        self?.clearRequest(requestId)
        let attributes = try? FileManager.default.attributesOfItem(atPath: destination.path)
        let size = (attributes?[.size] as? NSNumber)?.intValue ?? 0
        NSLog("[SCMedia] materialize OK req=%@ bytes=%d", requestId, size)
        promise.resolve([
          "uri": destination.absoluteString,
          "width": asset.pixelWidth,
          "height": asset.pixelHeight,
          "duration": asset.duration * 1000, // ms, matching expo-image-picker
          "fileSize": size,
          "fileName": resource.originalFilename,
        ])
      }

      let fail: (String, String) -> Void = { [weak self] code, message in
        guard !settled else { return }
        settled = true
        try? handle.close()
        self?.clearRequest(requestId)
        // Drop the partial file — a truncated video left in the cache would
        // otherwise be indistinguishable from a complete one on a later read.
        try? FileManager.default.removeItem(at: destination)
        NSLog("[SCMedia] materialize FAIL req=%@ code=%@ msg=%@", requestId, code, message)
        promise.reject(code, message)
      }

      // `requestData` streams in chunks rather than handing back one Data, so
      // a 2GB video never has to fit in memory — `writeData` gives no progress
      // and no cancellation, which is precisely what makes the stock picker
      // unusable here.
      let id = PHAssetResourceManager.default().requestData(
        for: resource,
        options: options,
        dataReceivedHandler: { chunk in
          // Called on an arbitrary queue, potentially many times. Writing is
          // serialized by the handle itself; a throw here means the disk is
          // full or the file vanished, and the completion handler below will
          // surface it.
          do {
            try handle.write(contentsOf: chunk)
          } catch {
            // Nothing actionable here — record nothing and let completion
            // report the failure with its own error.
          }
        },
        completionHandler: { error in
          if let error = error as NSError? {
            // A cancel surfaces as a normal error; distinguish it so the JS
            // side doesn't offer to retry something the user just stopped.
            if error.domain == PHPhotosErrorDomain,
               error.code == PHPhotosError.userCancelled.rawValue {
              fail("E_CANCELLED", "Cancelled.")
            } else {
              fail("E_MATERIALIZE", error.localizedDescription)
            }
            return
          }
          succeed()
        }
      )

      // Register for cancellation — and honour a cancel that arrived while
      // Photos was still starting the request.
      if self.registerRequest(requestId, id: id) == false {
        PHAssetResourceManager.default().cancelDataRequest(id)
      }
    }

    Function("cancelMaterialize") { (requestId: String) in
      self.requestLock.lock()
      let id = self.activeRequests.removeValue(forKey: requestId)
      if id == nil {
        // Cancel beat the request's registration; remember it.
        self.cancelledBeforeStart.insert(requestId)
      }
      self.requestLock.unlock()

      if let id {
        PHAssetResourceManager.default().cancelDataRequest(id)
      }
    }
  }

  // MARK: - Request bookkeeping

  /// Returns false when this id was already cancelled, so the caller can tear
  /// the just-started request down immediately.
  private func registerRequest(_ requestId: String, id: PHAssetResourceDataRequestID) -> Bool {
    requestLock.lock()
    defer { requestLock.unlock() }
    if cancelledBeforeStart.remove(requestId) != nil {
      return false
    }
    activeRequests[requestId] = id
    return true
  }

  private func clearRequest(_ requestId: String) {
    requestLock.lock()
    activeRequests.removeValue(forKey: requestId)
    cancelledBeforeStart.remove(requestId)
    requestLock.unlock()
  }

  // MARK: - Helpers

  private static func fetchAsset(_ localIdentifier: String) -> PHAsset? {
    PHAsset.fetchAssets(withLocalIdentifiers: [localIdentifier], options: nil).firstObject
  }

  private static func cacheURL(extension ext: String, prefix: String) throws -> URL {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("splitcircle-media", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("\(prefix)-\(UUID().uuidString).\(ext)")
  }

  /// Metadata only — deliberately reads nothing that would trigger a download.
  private static func metadata(for results: [PHPickerResult]) -> [[String: Any]] {
    let identifiers = results.compactMap(\.assetIdentifier)
    NSLog("[SCMedia] picked %d results, %d with identifiers", results.count, identifiers.count)
    guard !identifiers.isEmpty else { return [] }

    let fetched = PHAsset.fetchAssets(withLocalIdentifiers: identifiers, options: nil)
    var byId: [String: PHAsset] = [:]
    fetched.enumerateObjects { asset, _, _ in
      byId[asset.localIdentifier] = asset
    }

    // Map back over `identifiers` rather than the fetch result: fetchAssets
    // does not preserve the requested order, and the pick order is what the
    // chat sends in.
    return identifiers.compactMap { id -> [String: Any]? in
      guard let asset = byId[id] else { return nil }
      let isVideo = asset.mediaType == .video
      let filename = PHAssetResource.assetResources(for: asset).first?.originalFilename
      return [
        "assetId": id,
        "type": isVideo ? "video" : "image",
        "width": asset.pixelWidth,
        "height": asset.pixelHeight,
        "duration": isVideo ? asset.duration * 1000 : 0,
        "fileName": filename ?? (isVideo ? "video.mov" : "photo.jpg"),
      ]
    }
  }
}

/// Retained for the lifetime of one presentation — `PHPickerViewController`
/// holds its delegate weakly, so without an owning reference the callback is
/// never delivered and the promise hangs forever.
private final class PickerDelegate: NSObject, PHPickerViewControllerDelegate {
  private let onFinish: ([PHPickerResult]) -> Void

  init(onFinish: @escaping ([PHPickerResult]) -> Void) {
    self.onFinish = onFinish
  }

  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    picker.dismiss(animated: true)
    onFinish(results)
  }
}
