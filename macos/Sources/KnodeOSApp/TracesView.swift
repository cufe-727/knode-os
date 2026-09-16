import SwiftUI

struct TracesView: View {
    @EnvironmentObject private var model: AppModel
    @State private var traces: [TraceItem] = []
    @State private var filter = ""
    @State private var isLoading = true
    @State private var isSyncing = false

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
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Button { Task { await sync() } } label: {
                    if isSyncing { ProgressView().controlSize(.small) }
                    else { Label("Sync now", systemImage: "arrow.triangle.2.circlepath") }
                }
                .buttonStyle(.borderedProminent)
                .tint(.knodeCyan)
                .disabled(isSyncing)
                Text(L("Claude Code and Codex transcripts are mirrored into raw/traces/"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                TextField(L("Filter traces"), text: $filter)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 220)
                Text(L("%@ sessions", String(filtered.count)))
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 18)
            .frame(height: 60)
            .background(.bar)
            Divider()

            if isLoading && traces.isEmpty {
                ProgressView("Loading traces…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if filtered.isEmpty {
                EmptyState(
                    symbol: "terminal",
                    title: traces.isEmpty ? "No traces yet" : "No matching traces",
                    message: traces.isEmpty ? "Run a Claude Code or Codex session, then sync it into this workspace." : "Try another project, source, or session ID."
                )
            } else {
                VStack(spacing: 0) {
                    TraceHeaderRow()
                    Divider()
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(filtered) { trace in
                                TraceDataRow(trace: trace)
                                Divider().padding(.leading, 16)
                            }
                        }
                    }
                }
            }
        }
        .task { await load() }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            traces = try await model.client().traces()
        } catch {
            model.showError(error, prefix: "Traces failed")
        }
    }

    private func sync() async {
        isSyncing = true
        model.globalActivity = "Syncing traces…"
        defer {
            isSyncing = false
            model.globalActivity = nil
        }
        do {
            let result = try await model.client().syncTraces()
            model.showToast("Synced \(result.copied) traces · \(result.skills) skill files")
            await load()
            await model.refreshStats()
        } catch {
            model.showError(error, prefix: "Trace sync failed")
        }
    }
}

private struct TraceHeaderRow: View {
    var body: some View {
        HStack(spacing: 12) {
            Text(L("Source")).frame(width: 90, alignment: .leading)
            Text(L("Project")).frame(minWidth: 170, maxWidth: .infinity, alignment: .leading)
            Text(L("Session")).frame(width: 220, alignment: .leading)
            Text(L("Started")).frame(width: 150, alignment: .leading)
            Text(L("Size")).frame(width: 75, alignment: .leading)
            Text(L("Analyzed")).frame(width: 70, alignment: .center)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 16)
        .frame(height: 34)
        .background(.bar)
    }
}

private struct TraceDataRow: View {
    let trace: TraceItem

    var body: some View {
        HStack(spacing: 12) {
            RouteBadge(label: trace.source, color: trace.source == "codex" ? .knodeCyan : .knodeViolet)
                .frame(width: 90, alignment: .leading)
            Text(trace.project ?? "—")
                .font(.system(size: 11, design: .monospaced))
                .lineLimit(1)
                .help(trace.project ?? "")
                .frame(minWidth: 170, maxWidth: .infinity, alignment: .leading)
            Text(String((trace.sessionId ?? "—").prefix(24)))
                .font(.system(size: 11, design: .monospaced))
                .textSelection(.enabled)
                .frame(width: 220, alignment: .leading)
            Text(trace.startedAt?.knodeDate ?? "—")
                .font(.caption)
                .frame(width: 150, alignment: .leading)
            Text(ByteCountFormatter.string(fromByteCount: Int64(trace.bytes), countStyle: .file))
                .font(.caption.monospaced())
                .frame(width: 75, alignment: .leading)
            Image(systemName: trace.analyzedAt == nil ? "circle" : "checkmark.circle.fill")
                .foregroundStyle(trace.analyzedAt == nil ? Color.secondary : Color.knodeGood)
                .help(trace.analyzedAt.map { "Analyzed \($0.knodeDate)" } ?? "Not analyzed")
                .frame(width: 70)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 9)
        .contentShape(Rectangle())
    }
}
