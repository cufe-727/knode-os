import SwiftUI

/// The agent sessions Dream reads, mirrored into raw/traces/ — what was
/// Library → Traces, now at the foot of Tasks → Dream (docs/design/20 D8).
struct AgentTracesSection: View {
    @EnvironmentObject private var model: AppModel
    /// Bumped by whoever just collected traces: the list is read again.
    var reload: Int
    @Binding var isExpanded: Bool
    @State private var traces: [TraceItem] = []
    @State private var filter = ""
    @State private var isLoading = true

    private var filtered: [TraceItem] {
        guard !filter.isEmpty else { return traces }
        let needle = filter.lowercased()
        return traces.filter {
            $0.source.lowercased().contains(needle) ||
            ($0.project ?? "").lowercased().contains(needle) ||
            ($0.sessionId ?? "").lowercased().contains(needle)
        }
    }

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .center, spacing: 10) {
                    Text(L("Mirrored into raw/traces/ — click a row to open one. They feed the nightly dream; turn on trace.episodes in knode.config.json to make them searchable too."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    TextField(L("Filter traces"), text: $filter)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 200)
                    Text(L("%@ sessions", String(filtered.count)))
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .fixedSize()
                }
                if isLoading && traces.isEmpty {
                    ProgressView(L("Loading traces…"))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 20)
                } else if filtered.isEmpty {
                    Text(traces.isEmpty
                        ? L("No traces yet — run a Claude Code or Codex session, then collect agent traces above.")
                        : L("No matching traces"))
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 8)
                } else {
                    VStack(spacing: 0) {
                        TraceHeaderRow()
                        Divider()
                        LazyVStack(spacing: 0) {
                            ForEach(filtered) { trace in
                                // a trace is a file under raw/, so it opens where every other file does
                                TraceDataRow(trace: trace)
                                    .onTapGesture { model.openFile(trace.path) }
                                    .help(L("Open %@", trace.path))
                                Divider().padding(.leading, 16)
                            }
                        }
                    }
                    .background(Color.primary.opacity(0.03), in: RoundedRectangle(cornerRadius: 8))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay { RoundedRectangle(cornerRadius: 8).stroke(Color.primary.opacity(0.08)) }
                }
            }
            .padding(.top, 10)
        } label: {
            HStack(spacing: 7) {
                Image(systemName: "terminal")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Color.knodeCyan)
                Text(L("Agent traces Dream reads (%@)", isLoading && traces.isEmpty ? "…" : String(traces.count)))
                    .font(.headline)
            }
        }
        .knodeCard(padding: 16)
        .task(id: reload) { await load() }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            traces = try await model.client().traces()
        } catch {
            model.showError(error, prefix: L("Traces failed"))
        }
    }
}

private struct TraceHeaderRow: View {
    var body: some View {
        HStack(spacing: 12) {
            Text(L("Source")).frame(width: 80, alignment: .leading)
            Text(L("Project")).frame(minWidth: 120, maxWidth: .infinity, alignment: .leading)
            Text(L("Session")).frame(width: 170, alignment: .leading)
            Text(L("Started")).frame(width: 130, alignment: .leading)
            Text(L("Size")).frame(width: 70, alignment: .leading)
            Text(L("Analyzed")).frame(width: 60, alignment: .center)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 16)
        .frame(height: 32)
    }
}

private struct TraceDataRow: View {
    let trace: TraceItem

    var body: some View {
        HStack(spacing: 12) {
            RouteBadge(label: trace.source, color: trace.source == "codex" ? .knodeCyan : .knodeViolet)
                .frame(width: 80, alignment: .leading)
            Text(trace.project ?? "—")
                .font(.system(size: 11, design: .monospaced))
                .lineLimit(1)
                .truncationMode(.middle)
                .help(trace.project ?? "")
                .frame(minWidth: 120, maxWidth: .infinity, alignment: .leading)
            Text(String((trace.sessionId ?? "—").prefix(20)))
                .font(.system(size: 11, design: .monospaced))
                .lineLimit(1)
                .textSelection(.enabled)
                .frame(width: 170, alignment: .leading)
            Text(ServiceTime.date(trace.startedAt)?.formatted(date: .abbreviated, time: .shortened) ?? trace.startedAt ?? "—")
                .font(.caption)
                .lineLimit(1)
                .frame(width: 130, alignment: .leading)
            Text(ByteCountFormatter.string(fromByteCount: Int64(trace.bytes), countStyle: .file))
                .font(.caption.monospaced())
                .frame(width: 70, alignment: .leading)
            Image(systemName: trace.analyzedAt == nil ? "circle" : "checkmark.circle.fill")
                .foregroundStyle(trace.analyzedAt == nil ? Color.secondary : Color.knodeGood)
                .help(trace.analyzedAt.map { L("Analyzed %@", $0.knodeDate) } ?? L("Not analyzed"))
                .frame(width: 60)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .contentShape(Rectangle())
    }
}
