import WidgetKit
import SwiftUI

// MARK: - Timeline

struct BalanceEntry: TimelineEntry {
  let date: Date
  let snapshot: WidgetSharedStore.Snapshot?
}

/// Plain `TimelineProvider` (no user-configurable parameters). The app pushes fresh
/// data by calling `WidgetCenter.reloadAllTimelines()` whenever balances change
/// (SplitCircleSharedStore.writeWidgetSnapshot), so the timeline itself only needs a
/// single entry plus a lazy hourly safety refresh.
struct BalanceProvider: TimelineProvider {
  func placeholder(in context: Context) -> BalanceEntry {
    BalanceEntry(date: Date(), snapshot: WidgetSharedStore.read())
  }

  func getSnapshot(in context: Context, completion: @escaping (BalanceEntry) -> Void) {
    completion(BalanceEntry(date: Date(), snapshot: WidgetSharedStore.read()))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<BalanceEntry>) -> Void) {
    let entry = BalanceEntry(date: Date(), snapshot: WidgetSharedStore.read())
    let nextRefresh = Calendar.current.date(byAdding: .hour, value: 1, to: Date()) ?? Date().addingTimeInterval(3600)
    completion(Timeline(entries: [entry], policy: .after(nextRefresh)))
  }
}

// MARK: - Money coloring

private func balanceColor(_ value: Double) -> Color {
  if abs(value) < 0.01 { return .secondary }
  return value < 0 ? .red : .green
}

private func balancePhrase(_ value: Double, currency: String) -> String {
  if abs(value) < 0.01 { return "Settled up" }
  let amount = WidgetSharedStore.money(abs(value), currency: currency)
  return value < 0 ? "You owe \(amount)" : "You're owed \(amount)"
}

/// Deep link a tap opens — consumed by deepLinkService.ts on foreground.
private func groupURL(_ id: String) -> URL? {
  URL(string: "splitcircle://group/\(id)")
}

// MARK: - ManaSplit brand

/// A vector-only copy of the Muggu mark so the widget extension never depends on
/// the React Native asset bundle. It stays crisp in widgets, StandBy, and the
/// monochrome Lock Screen rendering modes.
struct ManaSplitWidgetMark: View {
  @Environment(\.widgetRenderingMode) private var renderingMode

  private var petalColor: Color {
    renderingMode == .fullColor ? Color(red: 0.23, green: 0.07, blue: 0.35) : .primary
  }

  private var accentColor: Color {
    renderingMode == .fullColor ? Color(red: 0.91, green: 0.63, blue: 0.24) : .primary
  }

  var body: some View {
    Canvas { context, size in
      let scale = min(size.width, size.height) / 120
      let offsetX = (size.width - 120 * scale) / 2
      let offsetY = (size.height - 120 * scale) / 2

      context.translateBy(x: offsetX, y: offsetY)
      context.scaleBy(x: scale, y: scale)

      var petal = Path()
      petal.move(to: CGPoint(x: 60, y: 60))
      petal.addCurve(
        to: CGPoint(x: 60, y: 12),
        control1: CGPoint(x: 32, y: 46),
        control2: CGPoint(x: 36, y: 22)
      )
      petal.addCurve(
        to: CGPoint(x: 60, y: 60),
        control1: CGPoint(x: 84, y: 22),
        control2: CGPoint(x: 88, y: 46)
      )
      petal.closeSubpath()

      for turn in 0..<4 {
        var rotated = context
        rotated.translateBy(x: 60, y: 60)
        rotated.rotate(by: .degrees(Double(turn) * 90))
        rotated.translateBy(x: -60, y: -60)
        rotated.stroke(
          petal,
          with: .color(petalColor),
          style: StrokeStyle(
            lineWidth: 7.2,
            lineCap: .round,
            lineJoin: .round,
            dash: [15.78, 22.43, 130.76]
          )
        )
      }

      context.fill(
        Path(ellipseIn: CGRect(x: 51.5, y: 51.5, width: 17, height: 17)),
        with: .color(accentColor)
      )

      for point in [
        CGPoint(x: 88.99, y: 31.01),
        CGPoint(x: 88.99, y: 88.99),
        CGPoint(x: 31.01, y: 88.99),
        CGPoint(x: 31.01, y: 31.01),
      ] {
        context.fill(
          Path(ellipseIn: CGRect(x: point.x - 4.2, y: point.y - 4.2, width: 8.4, height: 8.4)),
          with: .color(accentColor)
        )
      }
    }
    .accessibilityHidden(true)
  }
}

// MARK: - Views

struct BalanceWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: BalanceEntry

  var body: some View {
    switch family {
    case .systemSmall:      SmallView(snapshot: entry.snapshot)
    case .systemMedium:     MediumView(snapshot: entry.snapshot)
    case .accessoryRectangular: AccessoryRectView(snapshot: entry.snapshot)
    case .accessoryInline:  AccessoryInlineView(snapshot: entry.snapshot)
    default:                SmallView(snapshot: entry.snapshot)
    }
  }
}

private struct SmallView: View {
  let snapshot: WidgetSharedStore.Snapshot?

  var body: some View {
    let groups = snapshot?.groups ?? []
    if groups.isEmpty {
      EmptyStateView()
    } else if let primary = groups.first {
      let net = WidgetSharedStore.netBalance(groups)
      VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 5) {
          ManaSplitWidgetMark().frame(width: 18, height: 18)
          Text("ManaSplit").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
        }
        Spacer(minLength: 0)
        Text(WidgetSharedStore.money(abs(net), currency: primary.currency))
          .font(.title2.bold())
          .foregroundStyle(balanceColor(net))
          .minimumScaleFactor(0.7)
          .lineLimit(1)
        Text(net < -0.01 ? "you owe overall" : net > 0.01 ? "you're owed overall" : "all settled")
          .font(.caption2).foregroundStyle(.secondary)
        Spacer(minLength: 0)
        Text("\(groups.count) \(groups.count == 1 ? "group" : "groups")")
          .font(.caption2).foregroundStyle(.tertiary)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
      .widgetURL(primary.id.isEmpty ? nil : groupURL(primary.id))
    }
  }
}

private struct MediumView: View {
  let snapshot: WidgetSharedStore.Snapshot?

  var body: some View {
    let groups = Array((snapshot?.groups ?? []).prefix(3))
    if groups.isEmpty {
      EmptyStateView()
    } else {
      VStack(alignment: .leading, spacing: 8) {
        HStack {
          ManaSplitWidgetMark().frame(width: 20, height: 20)
          Text("ManaSplit").font(.caption.bold()).foregroundStyle(.secondary)
          Spacer()
          let net = WidgetSharedStore.netBalance(snapshot?.groups ?? [])
          Text(balancePhrase(net, currency: groups.first?.currency ?? "USD"))
            .font(.caption2).foregroundStyle(balanceColor(net))
        }
        ForEach(groups) { g in
          // Fallback is a known-valid literal (non-empty host) so the force-unwrap
          // can't crash; group rows always have a non-empty id in practice.
          Link(destination: groupURL(g.id) ?? URL(string: "splitcircle://groups")!) {
            HStack {
              Text(g.name).font(.subheadline).lineLimit(1)
              Spacer()
              Text(balancePhrase(g.balance, currency: g.currency))
                .font(.subheadline.weight(.medium))
                .foregroundStyle(balanceColor(g.balance))
                .lineLimit(1)
            }
          }
        }
        Spacer(minLength: 0)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
  }
}

private struct AccessoryRectView: View {
  let snapshot: WidgetSharedStore.Snapshot?
  var body: some View {
    let groups = snapshot?.groups ?? []
    if let primary = groups.first {
      VStack(alignment: .leading) {
        Label {
          Text("ManaSplit").font(.headline)
        } icon: {
          ManaSplitWidgetMark().frame(width: 18, height: 18)
        }
        Text(balancePhrase(WidgetSharedStore.netBalance(groups), currency: primary.currency))
          .font(.caption)
      }.frame(maxWidth: .infinity, alignment: .leading)
    } else {
      Label {
        Text("ManaSplit").font(.headline)
      } icon: {
        ManaSplitWidgetMark().frame(width: 18, height: 18)
      }
    }
  }
}

private struct AccessoryInlineView: View {
  let snapshot: WidgetSharedStore.Snapshot?
  var body: some View {
    let groups = snapshot?.groups ?? []
    let net = WidgetSharedStore.netBalance(groups)
    Text(groups.isEmpty ? "ManaSplit" : balancePhrase(net, currency: groups.first?.currency ?? "USD"))
  }
}

private struct EmptyStateView: View {
  var body: some View {
    VStack(spacing: 4) {
      ManaSplitWidgetMark().frame(width: 34, height: 34)
      Text("Open ManaSplit").font(.caption2).foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .widgetURL(URL(string: "splitcircle://groups"))
  }
}

// MARK: - Widget declaration

struct BalanceWidget: Widget {
  let kind = "SplitCircleBalanceWidget"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: BalanceProvider()) { entry in
      BalanceWidgetView(entry: entry)
        // iOS 17+ container background — also what gives iOS 26 its Liquid Glass
        // treatment automatically; respects accented/vibrant rendering modes.
        .containerBackground(.fill.tertiary, for: .widget)
    }
    .configurationDisplayName("Balances")
    .description("What you owe or are owed across your ManaSplit groups.")
    .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular, .accessoryInline])
  }
}
