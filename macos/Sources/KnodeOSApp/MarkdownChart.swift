import Charts
import SwiftUI

/// A ```chart block of a wiki page, drawn with Swift Charts — the native
/// counterpart of web/chart.js. Research pages carry their charts as data
/// (`src/research/chart.ts`): a JSON object with `type`, `title`, `x`,
/// `series`, `unit`, `source` and `note`. A block this cannot read is shown as
/// the code it is, so nothing a page says is ever hidden.
struct ChartSpec: Decodable, Equatable {
    struct Series: Decodable, Equatable {
        var name: String
        var values: [Double?]

        private enum CodingKeys: String, CodingKey { case name, values }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            name = (try? c.decode(String.self, forKey: .name)) ?? ""
            var out: [Double?] = []
            if var list = try? c.nestedUnkeyedContainer(forKey: .values) {
                while !list.isAtEnd {
                    if let number = try? list.decode(Double.self) {
                        out.append(number.isFinite ? number : nil)
                    } else if let text = try? list.decode(String.self) {
                        // the server reads "1,234" as a number and "" as a gap; so does this
                        let cleaned = text.replacingOccurrences(of: ",", with: "").trimmingCharacters(in: .whitespaces)
                        out.append(cleaned.isEmpty ? nil : Double(cleaned))
                    } else {
                        _ = try? list.decodeNil()
                        out.append(nil)
                    }
                }
            }
            values = out
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

    private enum CodingKeys: String, CodingKey { case type, title, subtitle, unit, x, series, source, note }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = ((try? c.decode(String.self, forKey: .type)) ?? "bar").lowercased()
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
    }

    /// The spec in a code block, or nil when there is nothing drawable in it.
    static func parse(_ text: String) -> ChartSpec? {
        guard let data = text.data(using: .utf8), let spec = try? JSONDecoder().decode(ChartSpec.self, from: data) else { return nil }
        guard !spec.x.isEmpty, spec.series.contains(where: { $0.values.contains { $0 != nil } }) else { return nil }
        return spec
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
                return Point(id: "\(s)-\(i)", category: label, index: i, series: entry.name.isEmpty ? "Series \(s + 1)" : entry.name, value: value)
            }
        }
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
        spec.series.enumerated().map { $0.element.name.isEmpty ? "Series \($0.offset + 1)" : $0.element.name }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !spec.title.isEmpty {
                Text(spec.title).font(.system(size: 13, weight: .semibold))
            }
            if let subtitle = spec.subtitle, !subtitle.isEmpty {
                Text(subtitle).font(.system(size: 11)).foregroundStyle(.secondary)
            }
            chart
                .frame(height: spec.type == "hbar" ? CGFloat(max(160, min(520, spec.x.count * 26 + 40))) : 230)
                .chartForegroundStyleScale(domain: seriesNames, range: Array(palette.prefix(max(1, seriesNames.count))))
                .chartLegend(spec.series.count > 1 ? .visible : .hidden)
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
        let unit = spec.unit ?? ""
        switch spec.type {
        case "line", "area":
            Chart(spec.points) { p in
                if spec.type == "area" {
                    AreaMark(x: .value("Period", p.category), y: .value(unit.isEmpty ? "Value" : unit, p.value), stacking: .unstacked)
                        .foregroundStyle(by: .value("Series", p.series))
                        .opacity(0.35)
                }
                LineMark(x: .value("Period", p.category), y: .value(unit.isEmpty ? "Value" : unit, p.value))
                    .foregroundStyle(by: .value("Series", p.series))
                    .lineStyle(StrokeStyle(lineWidth: 2))
                PointMark(x: .value("Period", p.category), y: .value(unit.isEmpty ? "Value" : unit, p.value))
                    .foregroundStyle(by: .value("Series", p.series))
                    .symbolSize(30)
            }
            .chartXScale(domain: spec.x)
            .chartYAxisLabel(unit)
        case "hbar":
            Chart(spec.points) { p in
                BarMark(x: .value(unit.isEmpty ? "Value" : unit, p.value), y: .value("Category", p.category))
                    .foregroundStyle(by: .value("Series", p.series))
                    .position(by: .value("Series", p.series))
                    .cornerRadius(3)
            }
            .chartYScale(domain: spec.x)
            .chartXAxisLabel(unit)
        default:
            // bar and stacked-bar; anything unknown is drawn as bars, as the web viewer does
            Chart(spec.points) { p in
                if spec.type == "stacked-bar" {
                    BarMark(x: .value("Category", p.category), y: .value(unit.isEmpty ? "Value" : unit, p.value))
                        .foregroundStyle(by: .value("Series", p.series))
                        .cornerRadius(2)
                } else {
                    BarMark(x: .value("Category", p.category), y: .value(unit.isEmpty ? "Value" : unit, p.value))
                        .foregroundStyle(by: .value("Series", p.series))
                        .position(by: .value("Series", p.series))
                        .cornerRadius(3)
                }
            }
            .chartXScale(domain: spec.x)
            .chartYAxisLabel(unit)
        }
    }
}
