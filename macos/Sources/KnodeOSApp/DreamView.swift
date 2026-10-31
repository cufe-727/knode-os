import SwiftUI

/// Tasks → Dream (docs/design/20 D8): a job on a clock whose output waits for
/// review — when it runs next and over how many days, Dream now, collecting
/// the agent traces it reads, the suggestions to accept or reject, and the
/// traces themselves.
struct DreamView: View {
    @EnvironmentObject private var model: AppModel
    @State private var suggestions: [Suggestion] = []
    @State private var statusFilter = "all"
    @State private var isLoading = true
    @State private var isDreaming = false
    @State private var isCollecting = false
    /// The nightly run as Tasks reports it; nil before the read, or from an older service.
    @State private var schedule: TasksSnapshot.Scheduled?
    @State private var lookbackDays: Int?
    @State private var scheduleRead = false
    @State private var tracesRevision = 0
    @State private var tracesOpen = false

    private var filtered: [Suggestion] {
        statusFilter == "all" ? suggestions : suggestions.filter { $0.status == statusFilter }
    }

    var body: some View {
        VStack(spacing: 0) {
            dreamBar
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    scheduleCard
                    suggestionsSection
                    AgentTracesSection(reload: tracesRevision, isExpanded: $tracesOpen)
                }
                .padding(20)
                .frame(maxWidth: 960, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
        }
        .background(Color(nsColor: .textBackgroundColor).opacity(0.22))
        .task {
            await load()
            await loadSchedule()
        }
    }

    private var dreamBar: some View {
        HStack(spacing: 10) {
            Button { Task { await runDream() } } label: {
                if isDreaming { ProgressView().controlSize(.small) }
                else { Label(L("Dream now"), systemImage: "moon.stars.fill") }
            }
            .buttonStyle(.borderedProminent)
            .tint(.knodeViolet)
            .disabled(isDreaming)
            .help(L("Analyze the recent agent sessions now instead of waiting for tonight"))

            Button { Task { await collect() } } label: {
                if isCollecting { ProgressView().controlSize(.small) }
                else { Label(L("Collect agent traces"), systemImage: "arrow.down.doc") }
            }
            .disabled(isCollecting)
            .help(L("Copy the Claude Code and Codex sessions on the service's machine into raw/traces/"))

            VStack(alignment: .leading, spacing: 2) {
                Text(lastDreamTitle).font(.callout.weight(.semibold)).lineLimit(1)
                Text(L("Recent traces → suggestions for skills, memory, and knowledge"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .padding(.leading, 4)
            Spacer(minLength: 8)
        }
        .padding(.horizontal, 18)
        .frame(height: 60)
        .background(.bar)
    }

    private var scheduleCard: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "moon.stars")
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(Color.knodeViolet)
                .frame(width: 26)
            VStack(alignment: .leading, spacing: 4) {
                Text(scheduleTitle).font(.callout.weight(.semibold))
                Text(scheduleDetail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let report = model.stats?.lastDream?.report {
                    Button(L("Open the last Dream report")) { model.openFile(report) }
                        .buttonStyle(.link)
                        .font(.caption)
                        .help(report)
                }
            }
            Spacer(minLength: 0)
        }
        .knodeCard(padding: 14)
    }

    private var scheduleTitle: String {
        guard scheduleRead else { return L("Nightly review of agent traces") }
        guard let schedule, schedule.enabled, let at = schedule.at else { return L("No nightly run is scheduled") }
        if schedule.running { return L("Dreaming now — runs every night at %@", at) }
        if let next = ServiceTime.until(schedule.next) { return L("Runs every night at %@ · next %@", at, next) }
        return L("Runs every night at %@", at)
    }

    private var scheduleDetail: String {
        let days = lookbackDays.map { L("over the last %@ days of your Claude Code and Codex sessions", String($0)) }
            ?? L("over your recent Claude Code and Codex sessions")
        guard scheduleRead, schedule?.enabled != true else {
            return L("Reads %@ and suggests skills, memory and knowledge to keep. Nothing changes until you accept a suggestion.", days)
        }
        return L("Reads %@ and suggests skills, memory and knowledge to keep. dream.schedule is not a time of day, so it runs only when asked.", days)
    }

    private var suggestionsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Text(L("Suggestions")).font(.headline)
                // the list holds the latest 200; the workspace's own count says how many wait in all
                let pending = max(suggestions.filter { $0.status == "pending" }.count, model.stats?.pendingSuggestions ?? 0)
                if pending > 0 {
                    Text(L("%@ to review", pending.formatted()))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.knodeViolet)
                }
                Spacer()
                Picker(L("Status"), selection: $statusFilter) {
                    Text(L("All")).tag("all")
                    Text(L("Pending")).tag("pending")
                    Text(L("Accepted")).tag("accepted")
                    Text(L("Rejected")).tag("rejected")
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 320)
            }
            if isLoading && suggestions.isEmpty {
                ProgressView(L("Loading suggestions…"))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 30)
            } else if filtered.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "moon.stars")
                        .font(.system(size: 26, weight: .light))
                        .foregroundStyle(Color.knodeViolet)
                    Text(statusFilter == "all" ? L("No suggestions yet") : L("No %@ suggestions", L(statusFilter)))
                        .font(.callout.weight(.semibold))
                    Text(L("Dream analyzes recent agent sessions and proposes grounded improvements to skills, memory, and knowledge. Collect agent traces, then Dream now — or wait for tonight."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 420)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 26)
            } else {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(filtered) { suggestion in
                        SuggestionCard(suggestion: suggestion, update: update, openReport: {
                            if let report = suggestion.reportPath { model.openFile(report) }
                        })
                    }
                }
            }
        }
    }

    private var lastDreamTitle: String {
        guard let last = model.stats?.lastDream else { return L("No dream cycle recorded") }
        let when = ServiceTime.date(last.at)?.formatted(date: .abbreviated, time: .shortened) ?? last.at ?? L("recently")
        return L("Last dream %@ · %@ sessions", when, String(last.sessions ?? 0))
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            suggestions = try await model.client().suggestions()
            await model.refreshStats()
        } catch {
            model.showError(error, prefix: L("Suggestions failed"))
        }
    }

    /// When Dream runs next and over how many days, from Tasks' read; an older service has none.
    private func loadSchedule() async {
        if let tasks = try? await model.client().tasks() {
            schedule = tasks.scheduled.first { $0.id == "dream" }
            lookbackDays = tasks.dream.lookbackDays
        }
        scheduleRead = true
    }

    private func update(_ suggestion: Suggestion, _ status: String) {
        Task {
            do {
                _ = try await model.client().updateSuggestion(id: suggestion.id, status: status)
                await load()
                model.showToast(status == "accepted" ? L("Suggestion accepted") : L("Suggestion rejected"))
            } catch {
                model.showError(error, prefix: L("Update failed"))
            }
        }
    }

    private func runDream() async {
        isDreaming = true
        model.globalActivity = L("Analyzing recent agent sessions…")
        defer {
            isDreaming = false
            model.globalActivity = nil
        }
        do {
            let result = try await model.client().dream()
            model.showToast(L("Dream complete · %@ suggestions from %@ sessions", String(result.suggestions.count), String(result.sessions)))
            suggestions = try await model.client().suggestions()
            await model.refreshStats()
        } catch {
            model.showError(error, prefix: L("Dream failed"))
        }
    }

    private func collect() async {
        isCollecting = true
        defer { isCollecting = false }
        if await model.collectTraces() != nil {
            tracesRevision += 1
            tracesOpen = true
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
                RouteBadge(label: L(suggestion.status), color: statusColor)
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
                    Button(L("Accept"), systemImage: "checkmark") { update(suggestion, "accepted") }
                        .buttonStyle(.borderedProminent)
                        .tint(.knodeGood)
                    Button(L("Reject"), systemImage: "xmark") { update(suggestion, "rejected") }
                }
                Spacer()
                if suggestion.reportPath != nil {
                    Button(L("Open Dream report"), systemImage: "doc.text") { openReport() }
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
