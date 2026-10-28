import SwiftUI

/// What a task would take before it starts (docs/design/18): the work, its
/// time, model calls, tokens, transfer and cost at API prices, and each
/// plan's share — Codex's windows as Codex reports them, the others against
/// what their plans include. The service computes it (GET
/// /api/labeling/estimate, …/studies/:id/estimate); this draws it, in the
/// processing panel and before a study starts.
struct TaskEstimate: Decodable {
    struct Span: Decodable, Hashable {
        var low: Double
        var expected: Double
        var high: Double
    }

    struct WorkRow: Decodable, Hashable {
        var label: String
        var detail: String
    }

    struct Totals: Decodable {
        struct Tokens: Decodable { var input: Span; var cached: Double; var output: Span }
        struct Bytes: Decodable { var up: Span; var down: Span; var remote: Span }
        var calls: Int
        var tokens: Tokens
        var seconds: Span?
        var bytes: Bytes
        var costUsd: Span?
        var unpriced: [String]
    }

    struct Window: Decodable, Hashable {
        var name: String
        var usedPercent: Double?
        var resetsAt: String?
        var taskPercent: Span?
        var basis: String
    }

    struct Credits: Decodable {
        var hasCredits: Bool
        var unlimited: Bool
        var balance: Double?
    }

    struct Service: Decodable, Identifiable {
        struct Tokens: Decodable { var input: Double; var output: Double }
        var service: String
        var label: String
        var plan: String?
        var calls: Int
        var tokens: Tokens
        var costUsd: Span?
        var windows: [Window]
        var credits: Credits?
        var limitReached: String?
        var notes: [String]
        var id: String { service }
    }

    var task: String
    var title: String
    var work: [WorkRow]
    var totals: Totals
    var services: [Service]
    var notes: [String]
}

struct EstimateView: View {
    let estimate: TaskEstimate

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                ForEach(estimate.work, id: \.self) { row in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(L(row.label)).foregroundStyle(.secondary).frame(width: 104, alignment: .leading)
                        Text(row.detail).fixedSize(horizontal: false, vertical: true)
                    }
                    .font(.caption)
                }
            }
            figures
            ForEach(estimate.services) { service in
                ServiceShareView(service: service)
            }
            ForEach(estimate.notes, id: \.self) { note in
                Text("· \(note)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var figures: some View {
        let t = estimate.totals
        return Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
            GridRow {
                figure(L("Time"), t.seconds.map { "≈ " + EstimateFormat.duration($0.expected) } ?? L("waits"),
                       t.seconds.map { EstimateFormat.spread($0, EstimateFormat.duration) } ?? L("no slot takes it yet"))
                figure(L("Model calls"), t.calls.formatted(), nil)
            }
            GridRow {
                figure(L("Tokens"), L("%@ in · %@ out", EstimateFormat.tokens(t.tokens.input.expected), EstimateFormat.tokens(t.tokens.output.expected)),
                       L("%@ of the input from cache", EstimateFormat.tokens(t.tokens.cached)))
                figure(L("Transfer"), "↓ " + EstimateFormat.bytes(t.bytes.down.expected),
                       "↑ " + EstimateFormat.bytes(t.bytes.up.expected) + (t.bytes.remote.expected > 0 ? " · " + L("remote workers %@", EstimateFormat.bytes(t.bytes.remote.expected)) : ""))
            }
            GridRow {
                figure(L("At API prices"), t.costUsd.map { "≈ " + EstimateFormat.usd($0.expected) } ?? "—",
                       t.costUsd.map { EstimateFormat.spread($0, EstimateFormat.usd) } ?? L("no price known for the model"))
                Color.clear.frame(height: 1)
            }
        }
    }

    private func figure(_ label: String, _ value: String, _ detail: String?) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label.uppercased()).font(.system(size: 9.5, weight: .semibold)).foregroundStyle(.secondary)
            Text(value).font(.system(size: 13, weight: .semibold)).monospacedDigit()
            if let detail, !detail.isEmpty {
                Text(detail).font(.caption2).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ServiceShareView: View {
    let service: TaskEstimate.Service

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(service.label).font(.callout.weight(.semibold))
                Text([service.plan.map { L("%@ plan", $0) }, L("%@ calls", service.calls.formatted()), service.costUsd.map { "≈ " + EstimateFormat.usd($0.expected) }]
                    .compactMap { $0 }.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ForEach(service.windows, id: \.self) { window in
                WindowShareView(window: window)
            }
            if let credits = service.credits {
                Text(L("Credits: %@", credits.unlimited ? L("unlimited") : credits.balance.map { Int($0).formatted() } ?? (credits.hasCredits ? L("yes") : L("none"))))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            if let reached = service.limitReached {
                Text(L("%@ says a limit is reached: %@", service.label, reached.replacingOccurrences(of: "_", with: " ")))
                    .font(.caption)
                    .foregroundStyle(Color.knodeBad)
            }
            ForEach(service.notes, id: \.self) { note in
                Text("· \(note)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
    }
}

private struct WindowShareView: View {
    let window: TaskEstimate.Window

    private var used: Double { min(100, max(0, window.usedPercent ?? 0)) }
    private var over: Bool { (window.taskPercent?.expected ?? 0) + (window.usedPercent ?? 0) > 100 }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(L("%@ window", L(window.name.prefix(1).uppercased() + window.name.dropFirst()))).font(.caption)
                Spacer()
                if let usedPercent = window.usedPercent {
                    Text(L("%@ used", EstimateFormat.percent(usedPercent)) + (window.resetsAt.map { " · " + L("resets %@", EstimateFormat.when($0)) } ?? ""))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Rectangle().fill(Color.primary.opacity(0.08))
                    Rectangle().fill(Color.secondary.opacity(0.55)).frame(width: geo.size.width * used / 100)
                    if let task = window.taskPercent {
                        Rectangle()
                            .fill(over ? Color.knodeBad : Color.knodeCyan)
                            .frame(width: max(2, geo.size.width * min(100 - used, task.expected) / 100))
                            .offset(x: geo.size.width * used / 100)
                    }
                }
            }
            .frame(height: 7)
            .clipShape(Capsule())
            Group {
                if let task = window.taskPercent {
                    Text(L("This task: ≈ %@", EstimateFormat.percent(task.expected))).fontWeight(.semibold)
                        + Text(EstimateFormat.spread(task, EstimateFormat.percent).isEmpty ? "" : " (\(EstimateFormat.spread(task, EstimateFormat.percent)))")
                        + Text(over ? " — " + L("past the limit") : "").foregroundColor(.knodeBad)
                } else {
                    Text(L("This task: not estimated"))
                }
            }
            .font(.caption)
            Text(window.basis).font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// The estimate's numbers in a person's units — the same rules as the web UI and `knode-os estimate`.
@MainActor
enum EstimateFormat {
    static func duration(_ seconds: Double) -> String {
        guard seconds > 0 else { return "0 s" }
        if seconds < 90 { return "\(Int(seconds.rounded())) s" }
        let minutes = Int((seconds / 60).rounded())
        if minutes < 90 { return "\(minutes) min" }
        let hours = seconds / 3600
        if hours < 48 { return hours < 10 ? String(format: "%.1f h", hours) : "\(Int(hours.rounded())) h" }
        let days = hours / 24
        return days < 10 ? String(format: L("%.1f days"), days) : L("%@ days", String(Int(days.rounded())))
    }

    static func bytes(_ value: Double) -> String {
        guard value > 0 else { return "0 B" }
        let units = ["B", "KB", "MB", "GB", "TB"]
        var v = value
        var i = 0
        while v >= 1000 && i < units.count - 1 {
            v /= 1000
            i += 1
        }
        return v < 10 && i > 0 ? String(format: "%.1f %@", v, units[i]) : "\(Int(v.rounded())) \(units[i])"
    }

    static func tokens(_ n: Double) -> String {
        if n >= 1e9 { return String(format: "%.1fB", n / 1e9) }
        if n >= 1e6 { return String(format: "%.1fM", n / 1e6) }
        if n >= 1e3 { return "\(Int((n / 1e3).rounded()))k" }
        return "\(Int(n.rounded()))"
    }

    static func usd(_ usd: Double) -> String {
        usd >= 100 ? "$\(Int(usd.rounded()).formatted())" : usd >= 1 ? String(format: "$%.2f", usd) : String(format: "$%.3f", usd)
    }

    static func percent(_ p: Double) -> String {
        p >= 10 ? "\(Int(p.rounded()))%" : p >= 1 ? String(format: "%.1f%%", p) : String(format: "%.2f%%", p)
    }

    /// A time the service sent (`toISOString`, with milliseconds), as a short local date.
    static func when(_ iso: String) -> String {
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = precise.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return iso }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    /// "a – b" under a figure, unless both ends read the same.
    static func spread(_ r: TaskEstimate.Span, _ f: (Double) -> String) -> String {
        let lo = f(r.low)
        let hi = f(r.high)
        return lo == hi ? "" : "\(lo) – \(hi)"
    }
}

/// Before a study starts: what it would take, then Start or Cancel.
struct StudyStartSheet: View {
    @EnvironmentObject private var model: AppModel
    let title: String
    let pages: Int
    let id: String
    let start: () -> Void
    let cancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(L("Start research?")).font(.title3.weight(.semibold))
                Text(title).font(.callout).foregroundStyle(.secondary)
                Text(L("%@ pages and a report: a collector gathers each page's sources, an agent writes each page, then the report — measured against the studies run here before.", String(pages)))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ScrollView {
                EstimateSection { try await model.client().studyEstimate(id: id) }
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(minHeight: 160, maxHeight: 460)
            HStack {
                Spacer()
                Button(L("Cancel"), action: cancel).keyboardShortcut(.cancelAction)
                Button(L("Start research"), action: start)
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 520)
    }
}

/// The estimate as it loads: a spinner, the figures, or why there are none.
struct EstimateSection: View {
    let load: () async throws -> TaskEstimate
    @State private var estimate: TaskEstimate?
    @State private var failure: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L("Before you start")).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            if let estimate {
                EstimateView(estimate: estimate)
            } else if let failure {
                Text(L("No estimate: %@. You can still start.", failure))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(L("Estimating — counting the work and reading the plans…")).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .task {
            do {
                estimate = try await load()
            } catch {
                failure = error.localizedDescription
            }
        }
    }
}
