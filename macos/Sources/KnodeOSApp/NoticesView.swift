import SwiftUI

/// The toolbar's notices: what the service says needs attention in this
/// workspace — the lint report, trace collection waiting for a yes, a purpose
/// nobody wrote, a wiki never initialized, datasources that failed — in place
/// of the folders the file tree no longer shows. Shown only while there is one.
struct NoticesButton: View {
    @EnvironmentObject private var model: AppModel
    @State private var showing = false

    private var warns: Bool { model.notices.contains { $0.level == "warn" } }

    var body: some View {
        Button {
            showing.toggle()
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "bell.badge")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(warns ? Color.orange : Color.knodeCyan)
                Text(String(model.notices.count))
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(.thinMaterial, in: Capsule())
        }
        .buttonStyle(.plain)
        .help(model.notices.count == 1 ? L("1 notice about this workspace") : L("%@ notices about this workspace", String(model.notices.count)))
        .accessibilityLabel(L("Notices"))
        .popover(isPresented: $showing, arrowEdge: .bottom) {
            NoticesPanel(close: { showing = false })
                .environmentObject(model)
        }
    }
}

private struct NoticesPanel: View {
    @EnvironmentObject private var model: AppModel
    let close: () -> Void
    /// The notice whose action waits on a second click: collecting traces copies a lot.
    @State private var confirming: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L("Notices")).font(.headline)
            if model.notices.isEmpty {
                Text(L("Nothing needs your attention."))
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            ForEach(model.notices) { notice in
                card(notice)
            }
        }
        .padding(18)
        .frame(width: 400)
    }

    private func card(_ notice: WorkspaceNotice) -> some View {
        let copy = NoticeCopy(notice, onThisMac: model.connection.mode == .local)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: copy.symbol)
                    .foregroundStyle(notice.level == "warn" ? Color.orange : Color.knodeCyan)
                    .frame(width: 16)
                Text(copy.title)
                    .font(.callout.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(copy.body)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.leading, 24)
                .textSelection(.enabled)
            HStack(spacing: 8) {
                Spacer()
                if confirming == notice.id, let question = copy.confirmation, let action = copy.action {
                    Text(question)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Button(L("Cancel")) { confirming = nil }
                    Button(action) {
                        confirming = nil
                        perform(notice)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.knodeCyan)
                } else {
                    Button(L("Dismiss")) { model.dismissNotice(notice) }
                        .help(L("Hide this notice until it says something new"))
                    if let action = copy.action {
                        Button(action) {
                            if copy.confirmation != nil { confirming = notice.id } else { perform(notice) }
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(.knodeCyan)
                    }
                }
            }
            .controlSize(.small)
        }
        .padding(12)
        .background(Color.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .stroke(notice.level == "warn" ? Color.orange.opacity(0.35) : Color.white.opacity(0.06))
        }
    }

    private func perform(_ notice: WorkspaceNotice) {
        switch notice.id {
        case "lint":
            close()
            if let report = notice.report { model.openFile(report) }
        case "purpose":
            close()
            model.openFile(notice.path ?? "purpose.md")
        case "initialize":
            close()
            model.select(.wiki)
        case "traces-off":
            Task { await model.collectTraces() }
        case "datasources":
            Task { await model.retryDatasources() }
        default:
            break
        }
    }
}

/// A notice in words: the data the service sent, said in the interface language.
@MainActor
struct NoticeCopy {
    var title: String
    var body: String
    /// The one thing the notice offers to do, besides dismissing it.
    var action: String?
    var symbol: String
    /// Asked before the action runs, when it does something hard to take back.
    var confirmation: String?

    /// `onThisMac`: the service runs on this Mac, so its agent sessions are this Mac's.
    init(_ notice: WorkspaceNotice, onThisMac: Bool) {
        switch notice.id {
        case "lint":
            let summary = notice.summary
            title = L("Wiki check: %@ findings across %@ pages", Self.number(summary?.findings ?? 0), Self.number(summary?.pages ?? 0))
            var lines: [String] = []
            if let counts = summary?.counts {
                let parts = Self.findingParts(counts)
                if !parts.isEmpty { lines.append(parts.joined(separator: " · ")) }
            }
            if let previous = notice.previous, let findings = summary?.findings {
                let delta = findings - previous.summary.findings
                lines.append(delta == 0 ? L("No change since %@", previous.date) : L("%@ since %@", Self.signed(delta), previous.date))
            }
            body = lines.joined(separator: "\n")
            action = L("Open report")
            symbol = "stethoscope"
        case "traces-off":
            let sessions = String(notice.sessions ?? 0)
            let size = ByteCountFormatter.string(fromByteCount: Int64(notice.bytes ?? 0), countStyle: .file)
            title = L("Agent traces aren't collected here")
            body = onThisMac
                ? L("The nightly review learns from your Claude Code and Codex sessions, but this workspace has none. Collecting copies %@ sessions (%@) from this Mac into raw/traces and keeps adding new ones.", sessions, size)
                : L("The nightly review learns from your Claude Code and Codex sessions, but this workspace has none. Collecting copies %@ sessions (%@) from the service's machine into raw/traces and keeps adding new ones.", sessions, size)
            action = L("Collect traces")
            symbol = "terminal"
            confirmation = onThisMac
                ? L("Copy %@ sessions (%@) from this Mac into this workspace?", sessions, size)
                : L("Copy %@ sessions (%@) from the service's machine into this workspace?", sessions, size)
        case "purpose":
            title = L("Say what this workspace is for")
            body = L("purpose.md is still the template. The wiki generator and the nightly review read it to decide what matters.")
            action = L("Edit purpose.md")
            symbol = "target"
        case "initialize":
            let missing: String
            switch (notice.overview ?? false, notice.guide ?? false) {
            case (false, false): missing = L("No overview or agent guide yet.")
            case (false, true): missing = L("No overview yet.")
            default: missing = L("No agent guide yet.")
            }
            title = L("This workspace isn't initialized")
            body = "\(missing) \(L("Initializing runs an agent that writes them, then queues topic pages."))"
            action = L("Go to Initialize")
            symbol = "gearshape.2"
        case "datasources":
            let errors = notice.errors ?? []
            var lines = Array(errors.prefix(3))
            if errors.count > 3 { lines.append(L("…and %@ more", String(errors.count - 3))) }
            lines.append(L("Their dataset pages may be stale."))
            title = L("Datasources failed on the last sync")
            body = lines.joined(separator: "\n")
            action = L("Retry")
            symbol = "exclamationmark.triangle.fill"
        default:
            // a kind this build does not know yet: say nothing it cannot back
            title = notice.id
            body = ""
            symbol = "bell"
        }
    }

    private static func number(_ value: Int) -> String {
        value.formatted()
    }

    private static func signed(_ value: Int) -> String {
        value > 0 ? "+\(value.formatted())" : "−\(abs(value).formatted())"
    }

    /// The nonzero counts, in words, in the report's own order.
    private static func findingParts(_ counts: LintCounts) -> [String] {
        let kinds: [(Int?, String, String)] = [
            (counts.orphan, L("1 page nothing links to"), "%@ pages nothing links to"),
            (counts.brokenLink, L("1 broken link"), "%@ broken links"),
            (counts.staleResearch, L("1 research page due for a refresh"), "%@ research pages due for a refresh"),
            (counts.unreviewed, L("1 unreviewed research page"), "%@ unreviewed research pages"),
            (counts.expired, L("1 expired page"), "%@ expired pages"),
            (counts.supersededText, L("1 superseded statement"), "%@ superseded statements"),
            (counts.openDispute, L("1 page with open disputes"), "%@ pages with open disputes"),
        ]
        return kinds.compactMap { count, one, many in
            guard let count, count > 0 else { return nil }
            return count == 1 ? one : L(many, number(count))
        }
    }
}
