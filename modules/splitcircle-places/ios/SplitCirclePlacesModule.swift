import ExpoModulesCore
import MapKit

/// Place search for the location picker.
///
/// WHY THIS EXISTS. The picker searched with `Location.geocodeAsync`, which is
/// Apple's CLGeocoder *forward geocoder*: it resolves structured ADDRESSES and
/// nothing else. "1 Infinite Loop, Cupertino" works; "Starbucks", "the
/// airport", or any business, landmark or neighbourhood name returns zero
/// results and the picker reported "Could not find location". That is the
/// whole of the "search doesn't work" report — it was never broken, it was
/// answering a different question than the one users type.
///
/// `MKLocalSearch` is what the Apple Maps search field itself uses. It covers
/// POIs, businesses, landmarks and addresses, is free, needs no API key, and
/// returns results that agree with the Apple Maps view we already render — a
/// Google Places result set would place pins from one provider onto another
/// provider's map.
public class SplitCirclePlacesModule: Module {
  /// Only one search runs at a time; a new query cancels the previous one so a
  /// slow earlier request cannot land after a newer one and overwrite it.
  private var activeSearch: MKLocalSearch?

  /// Incremental completer — the as-you-type engine.
  private var completer: MKLocalSearchCompleter?
  private var completerDelegate: CompleterDelegate?
  /// The last completions, held natively because `MKLocalSearchCompletion` is
  /// an opaque token that cannot be rebuilt from the strings we hand to JS.
  /// JS refers back to one by index to resolve it into a coordinate.
  private var completions: [MKLocalSearchCompletion] = []

  public func definition() -> ModuleDefinition {
    Name("SplitCirclePlaces")

    Events("onCompletions")

    /// Feed the incremental completer.
    ///
    /// `MKLocalSearch` is the WRONG tool for a half-typed query — it runs a
    /// full search against whatever fragment it is given, which is how
    /// "1115 n co" in Missouri returned a single road in a town 150 miles
    /// away. `MKLocalSearchCompleter` is what Apple Maps' own dropdown uses:
    /// it ranks completions against a region and updates continuously as
    /// characters arrive, so partial input produces partial-input answers
    /// rather than a confident wrong one.
    ///
    /// Results arrive on the delegate, hence an event rather than a promise.
    AsyncFunction("updateCompletionQuery") {
      (query: String, latitude: Double, longitude: Double) in
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }

        if self.completer == nil {
          let created = MKLocalSearchCompleter()
          // Addresses AND venues. The default omits one or the other depending
          // on iOS version, which is how a street search can miss the street.
          created.resultTypes = [.address, .pointOfInterest, .query]
          let delegate = CompleterDelegate { [weak self] items in
            guard let self else { return }
            self.completions = items
            self.sendEvent("onCompletions", [
              "items": items.enumerated().map { index, item in
                [
                  "id": index,
                  "title": item.title,
                  "subtitle": item.subtitle,
                ]
              },
            ])
          }
          self.completerDelegate = delegate
          created.delegate = delegate
          self.completer = created
        }

        // A tight region is what makes local results rank first. Half a degree
        // is roughly 55km — wide enough to cover a metro area, narrow enough
        // that the next state does not outrank your own street.
        if latitude != 0 || longitude != 0 {
          self.completer?.region = MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: latitude, longitude: longitude),
            span: MKCoordinateSpan(latitudeDelta: 0.5, longitudeDelta: 0.5)
          )
        }

        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
          self.completions = []
          self.sendEvent("onCompletions", ["items": [] as [[String: Any]]])
          return
        }
        self.completer?.queryFragment = trimmed
      }
    }

    /// Turn a chosen completion into a real coordinate.
    AsyncFunction("resolveCompletion") { (id: Int, promise: Promise) in
      DispatchQueue.main.async { [weak self] in
        guard let self, id >= 0, id < self.completions.count else {
          promise.reject("E_STALE_COMPLETION", "That suggestion is no longer available.")
          return
        }
        let request = MKLocalSearch.Request(completion: self.completions[id])
        self.activeSearch?.cancel()
        let search = MKLocalSearch(request: request)
        self.activeSearch = search
        search.start { response, error in
          self.activeSearch = nil
          guard let item = response?.mapItems.first else {
            promise.reject("E_RESOLVE", error?.localizedDescription ?? "Could not locate that place.")
            return
          }
          let placemark = item.placemark
          promise.resolve([
            "name": item.name ?? placemark.name ?? "Dropped pin",
            "address": Self.formatAddress(placemark),
            "latitude": placemark.coordinate.latitude,
            "longitude": placemark.coordinate.longitude,
          ])
        }
      }
    }

    /// Search near a coordinate. The region biases results toward the user
    /// rather than restricting them — searching "Heathrow" from Bangalore
    /// should still find Heathrow, just after anything closer.
    AsyncFunction("searchPlaces") {
      (query: String, latitude: Double, longitude: Double, promise: Promise) in
      let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmed.isEmpty else {
        promise.resolve([])
        return
      }

      let request = MKLocalSearch.Request()
      request.naturalLanguageQuery = trimmed
      // A wide span keeps this a bias rather than a filter.
      if CLLocationCoordinate2DIsValid(CLLocationCoordinate2D(latitude: latitude, longitude: longitude)),
         latitude != 0 || longitude != 0 {
        request.region = MKCoordinateRegion(
          center: CLLocationCoordinate2D(latitude: latitude, longitude: longitude),
          span: MKCoordinateSpan(latitudeDelta: 0.5, longitudeDelta: 0.5)
        )
      }

      self.activeSearch?.cancel()
      let search = MKLocalSearch(request: request)
      self.activeSearch = search

      search.start { response, error in
        self.activeSearch = nil

        if let error = error as NSError? {
          // A cancelled search is the expected outcome of typing another
          // character, not a failure worth surfacing.
          if error.domain == MKErrorDomain, error.code == MKError.loadingThrottled.rawValue {
            promise.resolve([])
            return
          }
          if error.code == NSUserCancelledError {
            promise.resolve([])
            return
          }
          promise.reject("E_PLACE_SEARCH", error.localizedDescription)
          return
        }

        let items = response?.mapItems ?? []
        promise.resolve(items.prefix(25).map { item -> [String: Any] in
          let placemark = item.placemark
          return [
            "name": item.name ?? placemark.name ?? "Dropped pin",
            "address": Self.formatAddress(placemark),
            "latitude": placemark.coordinate.latitude,
            "longitude": placemark.coordinate.longitude,
          ]
        })
      }
    }

    /// What is around this point, with no query at all.
    ///
    /// Most location shares are somewhere nearby, so offering the surroundings
    /// on open removes the typing entirely for the common case.
    /// `MKLocalPointsOfInterestRequest` is the right primitive: it is a
    /// category browse rather than a text match, so it does not need a term to
    /// rank against and returns venues rather than street addresses.
    AsyncFunction("searchNearby") {
      (latitude: Double, longitude: Double, radius: Double, promise: Promise) in
      let center = CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
      guard CLLocationCoordinate2DIsValid(center), latitude != 0 || longitude != 0 else {
        promise.resolve([])
        return
      }

      // Clamped: the API rejects radii above 50km outright, and a huge one
      // returns things too far away to be worth offering.
      let clamped = min(max(radius, 100), 20_000)
      let request = MKLocalPointsOfInterestRequest(center: center, radius: clamped)

      self.activeSearch?.cancel()
      let search = MKLocalSearch(request: request)
      self.activeSearch = search

      search.start { response, error in
        self.activeSearch = nil
        if error != nil {
          // Nearby is a convenience, never the only way to pick a place —
          // failing it silently is better than an alert the user cannot act on.
          promise.resolve([])
          return
        }
        let items = response?.mapItems ?? []
        promise.resolve(items.prefix(25).map { item -> [String: Any] in
          let placemark = item.placemark
          return [
            "name": item.name ?? placemark.name ?? "Nearby place",
            "address": Self.formatAddress(placemark),
            "latitude": placemark.coordinate.latitude,
            "longitude": placemark.coordinate.longitude,
          ]
        })
      }
    }

    Function("cancelSearch") {
      self.activeSearch?.cancel()
      self.activeSearch = nil
    }
  }

  /// A one-line address for the results list.
  ///
  /// Built by hand rather than from `CNPostalAddressFormatter`, whose output is
  /// multi-line and repeats the venue name that is already the row's title.
  private static func formatAddress(_ placemark: MKPlacemark) -> String {
    var parts: [String] = []
    // Street number + street, when both are known.
    if let number = placemark.subThoroughfare, let street = placemark.thoroughfare {
      parts.append("\(number) \(street)")
    } else if let street = placemark.thoroughfare {
      parts.append(street)
    }
    if let locality = placemark.locality { parts.append(locality) }
    if let area = placemark.administrativeArea, placemark.locality == nil {
      parts.append(area)
    }
    if let country = placemark.country, parts.isEmpty { parts.append(country) }
    return parts.joined(separator: ", ")
  }
}

/// Retained for the completer's lifetime — `MKLocalSearchCompleter` holds its
/// delegate weakly, so without an owner the callbacks never arrive and the
/// suggestion list stays permanently empty.
private final class CompleterDelegate: NSObject, MKLocalSearchCompleterDelegate {
  private let onResults: ([MKLocalSearchCompletion]) -> Void

  init(onResults: @escaping ([MKLocalSearchCompletion]) -> Void) {
    self.onResults = onResults
  }

  func completerDidUpdateResults(_ completer: MKLocalSearchCompleter) {
    onResults(completer.results)
  }

  func completer(_ completer: MKLocalSearchCompleter, didFailWithError error: Error) {
    // Throttling and transient network failures are routine while typing;
    // clearing the list on every one would make suggestions flicker away.
    NSLog("[SCPlaces] completer failed: %@", error.localizedDescription)
  }
}
