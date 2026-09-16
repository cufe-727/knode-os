import SwiftUI

struct DreamView: View {
    @EnvironmentObject private var model: AppModel
    @State private var suggestions: [Suggestion] = []
    @State private var statusFilter = "all"
    @State private var isLoading = true
    @State private var isDreaming = false

    private var filtered: [Suggestion] {
        statusFilter == "all" ? suggestions : suggestions.filter { $0.status == statusFilter }
    }

    var body: some View {
        VStack(spacing: 0) {
            dreamBar
            Divider()
            if isLoading && suggestions.isEmpty {
                ProgressView("Loading suggestions…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if filtered.isEmpty {
                EmptyState(
                    symbol: "moon.stars",
                    title: statusFilter == "all" ? "No suggestions yet" : "No \(statusFilter) suggestions",
                    message: L("Dream analyzes recent agent sessions and proposes grounded improvements to skills, memory, and knowledge.")
                )
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        ForEach(filtered) { suggestion in
                            SuggestionCard(suggestion: suggestion, update: update, openReport: {
                                if let report = suggestion.reportPath { model.openFile(report) }
                            })
                        }
                    }
                    .padding(20)
                    .frame(maxWidth: 920)
                    .frame(maxWidth: .infinity)
                }
            }
        }
        .background(Color(nsColor: .textBackgroundColor).opacity(0.22))
        .task { await load() }
    }

    private var dreamBar: some View {
        HStack(spacing: 12) {
            Button { Task { await runDream() } } label: {
                if isDreaming { ProgressView().controlSize(.small) }
                else { Label("Dream now", systemImage: "moon.stars.fill") }
            }
            .buttonStyle(.borderedProminent)
            .tint(.knodeViolet)
            .disabled(isDreaming)

            VStack(alignment: .leading, spacing: 2) {
                Text(lastDreamTitle).font(.callout.weight(.semibold))
                Text(L("Recent traces → suggestions for skills, memory, and knowledge"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Picker(L("Status"), selection: $statusFilter) {
                Text(L("All")).tag("all")
                Text(L("Pending")).tag("pending")
                Text(L("Accepted")).tag("accepted")
                Text(L("Rejected")).tag("rejected")
            }
            .pickerStyle(.segmented)
            .frame(width: 330)
        }
        .padding(.horizontal, 18)
        .frame(height: 66)
        .background(.bar)
    }

    private var lastDreamTitle: String {
        guard let last = model.stats?.lastDream else { return "No dream cycle recorded" }
        let when = last.at?.knodeDate ?? "recently"
        let sessions = last.sessions ?? 0
        return "Last dream \(when) · \(sessions) sessions"
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            suggestions = try await model.client().suggestions()
            await model.refreshStats()
        } catch {
            model.showError(error, prefix: "Suggestions failed")
        }
    }

    private func update(_ suggestion: Suggestion, _ status: String) {
        Task {
            do {
                _ = try await model.client().updateSuggestion(id: suggestion.id, status: status)
                await load()
                model.showToast("Suggestion \(status)")
            } catch {
                model.showError(error, prefix: "Update failed")
            }
        }
    }

    private func runDream() async {
        isDreaming = true
        model.globalActivity = "Analyzing recent agent sessions…"
        defer {
            isDreaming = false
            model.globalActivity = nil
        }
        do {
            let result = try await model.client().dream()
            model.showToast("Dream complete · \(result.suggestions.count) suggestions from \(result.sessions) sessions")
            suggestions = try await model.client().suggestions()
            await model.refreshStats()
        } catch {
            model.showError(error, prefix: "Dream failed")
        }
    }
}

private struct SuggestionCard: View {
    let suggestion: Suggestion
    let update: (Suggestion, String) -> Void
    let openReport: () -> Void
    @State private var evidenceExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                RouteBadge(label: suggestion.kind, color: kindColor)
                RouteBadge(label: suggestion.status, color: statusColor)
                Text(suggestion.createdAt.knodeDate)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                Spacer()
            }
            Text(suggestion.title).font(.title3.bold())
            MarkdownText(markdown: suggestion.body)
                .font(.callout)

            if !suggestion.evidence.isEmpty {
                DisclosureGroup(isExpanded: $evidenceExpanded) {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(suggestion.evidence, id: \.self) { item in
                            Label(item, systemImage: "quote.opening")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.top, 6)
                } label: {
                    Text(L("Evidence · %@", String(suggestion.evidence.count)))
                        .font(.caption.weight(.semibold))
                }
            }

            HStack {
                if suggestion.status == "pending" {
                    Button("Accept", systemImage: "checkmark") { update(suggestion, "accepted") }
                        .buttonStyle(.borderedProminent)
                        .tint(.knodeGood)
                    Button("Reject", systemImage: "xmark") { update(suggestion, "rejected") }
                }
                Spacer()
                if suggestion.reportPath != nil {
                    Button("Open Dream report", systemImage: "doc.text") { openReport() }
                }
            }
            .controlSize(.small)
        }
        .knodeCard(padding: 18)
        .opacity(suggestion.status == "rejected" ? 0.62 : 1)
    }

    private var kindColor: Color {
        switch suggestion.kind {
        case "skill": .knodeCyan
        case "memory": .knodeViolet
        default: .orange
        }
    }

    private var statusColor: Color {
        switch suggestion.status {
        case "accepted": .knodeGood
        case "rejected": .knodeBad
        default: .secondary
        }
    }
}
