import Charts
import SwiftUI

/// A ```chart block of a wiki page, drawn with Swift Charts — the native
/// counterpart of web/chart.js. Research pages carry their charts as data
/// (`src/research/chart.ts`): a JSON object with `type`, `title`, `x`,
/// `series`, `unit`, `source` and `note`. A block this cannot read is shown as
/// the code it is, so nothing a page says is ever hidden.
///
/// Four types read the categories their own way: `share` draws each column as
/// 100%; a `scatter`'s `x` names its points, its two series the horizontal and
/// the vertical measure; a `waterfall`'s one series holds levels (`totals`, by
/// x label — the first and the last bar when left out) and the changes between
/// them; a `timeline`'s `x` lists generations in order, a row per series, each
/// value a date (2025, "2025-03", "2025-Q4", "2026-H1").
struct ChartSpec: Decodable, Equatable {
    struct Series: Decodable, Equatable {
        var name: String
        var values: [Double?]
        /// Each value as the page wrote it when it was text: a timeline's dates ("2025-Q4").
        var texts: [String?]

        private enum CodingKeys: String, CodingKey { case name, values }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            name = (try? c.decode(String.self, forKey: .name)) ?? ""
            var out: [Double?] = []
            var written: [String?] = []
            if var list = try? c.nestedUnkeyedContainer(forKey: .values) {
                while !list.isAtEnd {
                    if let number = try? list.decode(Double.self) {
                        out.append(number.isFinite ? number : nil)
                        written.append(nil)
                    } else if let text = try? list.decode(String.self) {
                        // the server reads "1,234" as a number and "" as a gap; so does this
                        let cleaned = text.replacingOccurrences(of: ",", with: "").trimmingCharacters(in: .whitespaces)
                        out.append(cleaned.isEmpty ? nil : Double(cleaned))
                        written.append(text)
                    } else {
                        _ = try? list.decodeNil()
                        out.append(nil)
                        written.append(nil)
                    }
                }
            }
            values = out
            texts = written
        }
    }

    var type: String
    var title: String
    var subtitle: String?
    var unit: String?
    var x: [String]
    var series: [Series]
    var source: String?
    var note: String?
    /// A waterfall's levels, by x label.
    var totals: [String]?

    private enum CodingKeys: String, CodingKey { case type, title, subtitle, unit, x, series, source, note, totals }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = ((try? c.decode(String.self, forKey: .type)) ?? "bar").trimmingCharacters(in: .whitespaces).lowercased()
        title = (try? c.decode(String.self, forKey: .title)) ?? ""
        subtitle = try? c.decode(String.self, forKey: .subtitle)
        unit = try? c.decode(String.self, forKey: .unit)
        source = try? c.decode(String.self, forKey: .source)
        note = try? c.decode(String.self, forKey: .note)
        var labels: [String] = []
        if var list = try? c.nestedUnkeyedContainer(forKey: .x) {
            while !list.isAtEnd {
                if let s = try? list.decode(String.self) { labels.append(s) } else if let n = try? list.decode(Double.self) { labels.append(n.formatted()) } else { _ = try? list.decodeNil(); labels.append("") }
            }
        }
        x = labels
        series = Array(((try? c.decode([Series].self, forKey: .series)) ?? []).prefix(8))
        var levels: [String]?
        if var list = try? c.nestedUnkeyedContainer(forKey: .totals) {
            var names: [String] = []
            while !list.isAtEnd {
                if let s = try? list.decode(String.self) { names.append(s.trimmingCharacters(in: .whitespaces)) } else if let n = try? list.decode(Double.self) { names.append(n.formatted()) } else { _ = try? list.decodeNil() }
            }
            levels = names
        }
        totals = levels
    }

    /// The spec in a code block, or nil when there is nothing drawable in it.
    static func parse(_ text: String) -> ChartSpec? {
        guard let data = text.data(using: .utf8), let spec = try? JSONDecoder().decode(ChartSpec.self, from: data) else { return nil }
        guard !spec.x.isEmpty else { return nil }
        switch spec.type {
        case "timeline": return spec.timelineRows.contains { !$0.points.isEmpty } ? spec : nil
        case "scatter": return spec.scatterPoints.isEmpty ? nil : spec
        default: return spec.series.contains(where: { $0.values.contains { $0 != nil } }) ? spec : nil
        }
    }

    func seriesName(_ index: Int) -> String {
        series[index].name.isEmpty ? "Series \(index + 1)" : series[index].name
    }

    struct Point: Identifiable {
        let id: String
        let category: String
        let index: Int
        let series: String
        let value: Double
    }

    /// One mark per value, a series' values matched to the categories by position.
    var points: [Point] {
        series.enumerated().flatMap { s, entry in
            x.enumerated().compactMap { i, label -> Point? in
                guard i < entry.values.count, let value = entry.values[i] else { return nil }
                return Point(id: "\(s)-\(i)", category: label, index: i, series: seriesName(s), value: value)
            }
        }
    }

    /// A share chart's values as shares of their column, 0 to 1: what the bars stack to 100%.
    var sharePoints: [Point] {
        let positive = points.filter { $0.value > 0 }
        var totals: [Int: Double] = [:]
        for p in positive { totals[p.index, default: 0] += p.value }
        return positive.map { p in Point(id: p.id, category: p.category, index: p.index, series: p.series, value: p.value / (totals[p.index] ?? 1)) }
    }

    /* ------------------------------------------------------------ scatter */

    struct ScatterPoint: Identifiable {
        let id: Int
        let label: String
        let across: Double
        let up: Double
    }

    /// The points that have both measures: the first series across, the second up.
    var scatterPoints: [ScatterPoint] {
        guard series.count >= 2 else { return [] }
        return x.indices.compactMap { i in
            guard i < series[0].values.count, i < series[1].values.count, let a = series[0].values[i], let b = series[1].values[i] else { return nil }
            return ScatterPoint(id: i, label: x[i], across: a, up: b)
        }
    }

    /* ---------------------------------------------------------- waterfall */

    struct WaterfallBar: Identifiable {
        enum Kind { case level, increase, decrease, flat }
        let id: Int
        let label: String
        let kind: Kind
        /// Where the bar starts and ends: a level from zero, a change from the level before it.
        let from: Double
        let to: Double
        let value: Double
        /// The level after this bar, carried on to the next one.
        let level: Double
    }

    /// The bars of a waterfall's one series; a missing value is no change.
    var waterfallBars: [WaterfallBar] {
        guard let steps = series.first else { return [] }
        let levels: Set<Int> = totals.map { names in Set(names.compactMap { x.firstIndex(of: $0) }) } ?? Set(x.count > 1 ? [0, x.count - 1] : [0])
        var level = 0.0
        return x.indices.map { i in
            let v = (i < steps.values.count ? steps.values[i] : nil) ?? 0
            if levels.contains(i) {
                level = v
                return WaterfallBar(id: i, label: x[i], kind: .level, from: 0, to: v, value: v, level: level)
            }
            let from = level
            level += v
            return WaterfallBar(id: i, label: x[i], kind: v > 0 ? .increase : v < 0 ? .decrease : .flat, from: from, to: level, value: v, level: level)
        }
    }

    /* ----------------------------------------------------------- timeline */

    struct TimelinePoint: Identifiable {
        let id: String
        let label: String
        let at: Double
        let text: String
    }

    struct TimelineRow: Identifiable {
        let id: Int
        let name: String
        let points: [TimelinePoint]
    }

    /// A row per series, each generation `x` lists placed at its date.
    var timelineRows: [TimelineRow] {
        series.indices.map { j in
            let s = series[j]
            return TimelineRow(id: j, name: seriesName(j), points: x.indices.compactMap { i in
                let written = i < s.texts.count ? s.texts[i] : nil
                guard let date = ChartSpec.timelineDate(number: i < s.values.count ? s.values[i] : nil, text: written) else { return nil }
                return TimelinePoint(id: "\(j)-\(i)", label: x[i], at: date.at, text: date.text)
            })
        }
    }

    /**
     * A timeline's value as the server reads it (`timelineDate` in
     * src/research/chart.ts): where it stands, in years — the start of its
     * period, so "2025-Q4" is 2025.75 — and how it reads.
     */
    static func timelineDate(number: Double?, text: String?) -> (at: Double, text: String)? {
        let years = 1900...2199
        guard let text else {
            guard let number, number.isFinite, years.contains(Int(number.rounded(.down))) else { return nil }
            return (number, number.formatted(.number.grouping(.never)))
        }
        let t = text.trimmingCharacters(in: .whitespaces)
        if let m = t.wholeMatch(of: #/(\d{4})(?:\.\d+)?/#), let y = Int(m.output.1), years.contains(y), let at = Double(t) {
            return (at, t)
        }
        if let m = t.wholeMatch(of: #/(\d{4})[-\/.](\d{1,2})/#), let y = Int(m.output.1), let month = Int(m.output.2), years.contains(y), (1...12).contains(month) {
            return (Double(y) + Double(month - 1) / 12, String(format: "%d-%02d", y, month))
        }
        var part: (year: Int, kind: String, n: Int)?
        if let m = t.wholeMatch(of: #/(\d{4})[-\s]?([QqHh])([1-4])/#), let y = Int(m.output.1), let n = Int(m.output.3) {
            part = (y, m.output.2.uppercased(), n)
        } else if let m = t.wholeMatch(of: #/([QqHh])([1-4])[-\s]?(\d{4})/#), let y = Int(m.output.3), let n = Int(m.output.2) {
            part = (y, m.output.1.uppercased(), n)
        }
        guard let part, years.contains(part.year), part.kind == "Q" || part.n <= 2 else { return nil }
        return (Double(part.year) + Double(part.n - 1) / (part.kind == "Q" ? 4 : 2), "\(part.year)-\(part.kind)\(part.n)")
    }
}

struct MarkdownChart: View {
    let spec: ChartSpec
    @Environment(\.colorScheme) private var colorScheme

    /// The dataviz reference palette, in its fixed order, stepped for each mode (as web/chart.css uses the dark steps).
    private var palette: [Color] {
        let light: [UInt32] = [0x2A78D6, 0xEB6834, 0x1BAF7A, 0xEDA100, 0xE87BA4, 0x008300, 0x6250D6, 0xE34948]
        let dark: [UInt32] = [0x3987E5, 0xD95926, 0x199E70, 0xC98500, 0xD55181, 0x008300, 0x9085E9, 0xE66767]
        return (colorScheme == .dark ? dark : light).map { hex in
            Color(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
        }
    }

    private var seriesNames: [String] {
        spec.series.indices.map(spec.seriesName)
    }

    private var height: CGFloat {
        switch spec.type {
        case "hbar": CGFloat(max(160, min(520, spec.x.count * 26 + 40)))
        case "timeline": CGFloat(max(120, min(520, spec.series.count * 46 + 44)))
        case "scatter": 280
        default: 230
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !spec.title.isEmpty {
                Text(spec.title).font(.system(size: 13, weight: .semibold))
            }
            if let subtitle = spec.subtitle, !subtitle.isEmpty {
                Text(subtitle).font(.system(size: 11)).foregroundStyle(.secondary)
            }
            chart.frame(height: height)
            if let note = spec.note, !note.isEmpty {
                Text(note).font(.system(size: 10.5)).foregroundStyle(.secondary)
            }
            if let source = spec.source, !source.isEmpty {
                Text("Source: \(source)").font(.system(size: 10, design: .monospaced)).foregroundStyle(.tertiary).textSelection(.enabled)
            }
        }
        .padding(12)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(spec.type) chart: \(spec.title)")
    }

    @ViewBuilder
    private var chart: some View {
        switch spec.type {
        case "scatter": scatter
        case "waterfall": waterfall
        case "timeline": timeline.colouredBySeries(seriesNames, palette, legend: false)
        default: categorical.colouredBySeries(seriesNames, palette, legend: spec.series.count > 1)
        }
    }

    /// bar, stacked-bar, share, hbar, line and area: one value per series and category.
    @ViewBuilder
    private var categorical: some View {
        let unit = spec.unit ?? ""
        let measure = unit.isEmpty ? "Value" : unit
        switch spec.type {
        case "line", "area":
            Chart(spec.points) { p in
                if spec.type == "area" {
                    AreaMark(x: .value("Period", p.category), y: .value(measure, p.value), stacking: .unstacked)
                        .foregroundStyle(by: .value("Series", p.series))
                        .opacity(0.35)
                }
                LineMark(x: .value("Period", p.category), y: .value(measure, p.value))
                    .foregroundStyle(by: .value("Series", p.series))
                    .lineStyle(StrokeStyle(lineWidth: 2))
                PointMark(x: .value("Period", p.category), y: .value(measure, p.value))
                    .foregroundStyle(by: .value("Series", p.series))
                    .symbolSize(30)
            }
            .chartXScale(domain: spec.x)
            .chartYAxisLabel(unit)
        case "hbar":
            Chart(spec.points) { p in
                BarMark(x: .value(measure, p.value), y: .value("Category", p.category))
                    .foregroundStyle(by: .value("Series", p.series))
                    .position(by: .value("Series", p.series))
                    .cornerRadius(3)
            }
            .chartYScale(domain: spec.x)
            .chartXAxisLabel(unit)
        case "share":
            // each column stacked to 100%, its parts worked out here; a negative value has no share of it
            Chart(spec.sharePoints) { p in
                BarMark(x: .value("Category", p.category), y: .value("Share", p.value))
                    .foregroundStyle(by: .value("Series", p.series))
            }
            .chartXScale(domain: spec.x)
            .chartYScale(domain: 0...1)
            .chartYAxis {
                AxisMarks(values: [0, 0.25, 0.5, 0.75, 1]) { value in
                    AxisGridLine()
                    AxisValueLabel {
                        if let share = value.as(Double.self) { Text(share, format: .percent) }
                    }
                }
            }
        default:
            // bar and stacked-bar; anything unknown is drawn as bars, as the web viewer does
            Chart(spec.points) { p in
                if spec.type == "stacked-bar" {
                    BarMark(x: .value("Category", p.category), y: .value(measure, p.value))
                        .foregroundStyle(by: .value("Series", p.series))
                        .cornerRadius(2)
                } else {
                    BarMark(x: .value("Category", p.category), y: .value(measure, p.value))
                        .foregroundStyle(by: .value("Series", p.series))
                        .position(by: .value("Series", p.series))
                        .cornerRadius(3)
                }
            }
            .chartXScale(domain: spec.x)
            .chartYAxisLabel(unit)
        }
    }

    /// One hue for one set of points, each named beside its dot; the axes are named after the two series.
    private var scatter: some View {
        let points = spec.scatterPoints
        let across = axisName(spec.seriesName(0))
        let up = axisName(spec.seriesName(1))
        return Chart(points) { p in
            PointMark(x: .value(across, p.across), y: .value(up, p.up))
                .foregroundStyle(palette[0])
                .symbolSize(44)
                .annotation(position: .trailing, alignment: .leading, spacing: 4) {
                    Text(p.label).font(.system(size: 10)).foregroundStyle(.secondary)
                }
        }
        .chartXScale(domain: .automatic(includesZero: nearZero(points.map(\.across))))
        .chartYScale(domain: .automatic(includesZero: nearZero(points.map(\.up))))
        .chartXAxisLabel(across, position: .bottom, alignment: .trailing)
        .chartYAxisLabel(up, position: .top, alignment: .leading)
        .chartLegend(.hidden)
    }

    /// The levels in the series' hue from zero, the changes floating between them in two hues, a dotted line carrying each level on.
    private var waterfall: some View {
        let bars = spec.waterfallBars
        let unit = spec.unit ?? ""
        let measure = unit.isEmpty ? "Value" : unit
        let total = spec.series.isEmpty ? "" : spec.seriesName(0)
        let kinds: [(String, Color, WaterfallKindFilter)] = [(total, palette[0], .level), (L("Increase"), palette[2], .increase), (L("Decrease"), palette[1], .decrease)]
        let shown = kinds.filter { kind in bars.contains { kind.2.matches($0.kind) } }
        let links = bars.dropLast().map { bar in (bar, spec.x[bar.id + 1]) }
        return Chart {
            ForEach(Array(links.enumerated()), id: \.offset) { index, link in
                ForEach([link.0.label, link.1], id: \.self) { label in
                    LineMark(x: .value("Step", label), y: .value(measure, link.0.level), series: .value("Link", "\(index)"))
                        .foregroundStyle(Color.secondary.opacity(0.7))
                        .lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 3]))
                }
            }
            ForEach(bars) { bar in
                BarMark(x: .value("Step", bar.label), yStart: .value(measure, bar.from), yEnd: .value(measure, bar.to), width: .ratio(0.6))
                    .foregroundStyle(by: .value("Kind", name(of: bar.kind, total: total)))
                    .cornerRadius(3)
                    .annotation(position: bar.kind == .decrease || (bar.kind == .level && bar.value < 0) ? .bottom : .top, spacing: 2) {
                        Text(bar.kind == .level ? compact(bar.value) : signed(bar.value))
                            .font(.system(size: 10, weight: .semibold))
                            .monospacedDigit()
                    }
            }
        }
        .chartXScale(domain: spec.x)
        .chartYAxisLabel(unit)
        .chartForegroundStyleScale(domain: shown.map(\.0), range: shown.map(\.1))
        .chartLegend(.visible)
    }

    /**
     * A row per series along one time axis in years; each generation a dot
     * named above it. The rows stand on a numeric axis — row 0 at the top —
     * so each maker's name sits level with its row: a category axis puts its
     * labels on the edges between the rows.
     */
    private var timeline: some View {
        let rows = spec.timelineRows
        let dates = rows.flatMap(\.points).map(\.at)
        let first = (dates.min() ?? 2024).rounded(.down)
        let last = (dates.max() ?? 2025).rounded(.down) + 1
        let span = last - first
        let step = span <= 12 ? 1.0 : span <= 24 ? 2 : span <= 60 ? 5 : 10
        let ticks = stride(from: (first / step).rounded(.up) * step, through: last, by: step).map { $0 }
        let level = { (row: ChartSpec.TimelineRow) in Double(rows.count - 1 - row.id) }
        return Chart {
            ForEach(rows) { row in
                if let start = row.points.map(\.at).min(), let end = row.points.map(\.at).max(), end > start {
                    RuleMark(xStart: .value("Year", start), xEnd: .value("Year", end), y: .value("Row", level(row)))
                        .foregroundStyle(by: .value("Series", row.name))
                        .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round))
                        .opacity(0.4)
                }
                ForEach(row.points) { point in
                    PointMark(x: .value("Year", point.at), y: .value("Row", level(row)))
                        .foregroundStyle(by: .value("Series", row.name))
                        .symbolSize(48)
                        .annotation(position: .top, spacing: 3) {
                            Text(point.label).font(.system(size: 9.5)).foregroundStyle(.secondary)
                        }
                        .accessibilityLabel(row.name)
                        .accessibilityValue("\(point.label) \(point.text)")
                }
            }
        }
        .chartXScale(domain: first...last)
        .chartYScale(domain: -0.5...(Double(rows.count) - 0.4))
        .chartYAxis {
            AxisMarks(position: .leading, values: rows.map(level)) { value in
                AxisValueLabel {
                    if let y = value.as(Double.self), let row = rows.first(where: { level($0) == y }) {
                        Text(row.name).font(.system(size: 11))
                    }
                }
            }
        }
        .chartXAxis {
            AxisMarks(values: ticks) { value in
                AxisGridLine()
                AxisValueLabel {
                    if let year = value.as(Double.self) { Text(String(Int(year))) }
                }
            }
        }
    }

    /// An axis's name, with the chart's unit when the name does not carry it already.
    private func axisName(_ name: String) -> String {
        guard let unit = spec.unit, !unit.isEmpty, !name.contains(unit) else { return name }
        return "\(name) (\(unit))"
    }

    /// Zero belongs on a scatter's axis when it is near the values: as near as they are wide.
    private func nearZero(_ values: [Double]) -> Bool {
        guard let lo = values.min(), let hi = values.max() else { return true }
        return lo <= 0 && hi >= 0 || (lo > 0 && lo <= hi - lo) || (hi < 0 && -hi <= hi - lo)
    }

    private func name(of kind: ChartSpec.WaterfallBar.Kind, total: String) -> String {
        switch kind {
        case .level: total
        case .increase, .flat: L("Increase")
        case .decrease: L("Decrease")
        }
    }

    private func compact(_ value: Double) -> String {
        value.formatted(.number.precision(.significantDigits(1...3)))
    }

    private func signed(_ value: Double) -> String {
        value > 0 ? "+\(compact(value))" : compact(value)
    }
}

/// Which bars of a waterfall a legend entry stands for.
private enum WaterfallKindFilter {
    case level, increase, decrease

    func matches(_ kind: ChartSpec.WaterfallBar.Kind) -> Bool {
        switch (self, kind) {
        case (.level, .level), (.increase, .increase), (.increase, .flat), (.decrease, .decrease): true
        default: false
        }
    }
}

private extension View {
    /// Series 1, 2, 3 … in the palette's slots 1, 2, 3 …, never cycled.
    func colouredBySeries(_ names: [String], _ palette: [Color], legend: Bool) -> some View {
        chartForegroundStyleScale(domain: names, range: Array(palette.prefix(max(1, names.count))))
            .chartLegend(legend ? .visible : .hidden)
    }
}
