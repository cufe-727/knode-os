import SwiftUI

/// Research studies (docs/design/15): a topic, refined into a brief, then
/// researched into several wiki pages and a report. The list of studies on
/// the left; on the right the composer, a draft's brief (answer its questions,
/// say what to change, refine again, start), or a study that runs or ran.
/// Editing a brief page by page is the web UI's; this screen covers the loop.
/// Mirrors the web UI's Research → Studies.
struct StudiesView: View {
    @EnvironmentObject private var model: AppModel
    @State private var studies: [StudySummary] = []
    @State private var selected: String?
    @State private var detail: StudyDetail?
    @State private var agents: [AvailableAgent] = []
    @State private var topic = ""
    @State private var agent = ""
    @State private var web = true
    @State private var feedback = ""
    @State private var answers: [String: String] = [:]
    @State private var busy = false
    @State private var errorMessage: String?
    @State private var poller: Task<Void, Never>?
    /// The draft whose Start is being confirmed, with its estimate.
    @State private var confirming: StudyDetail?
    /// The list shows the archived studies instead.
    @State private var showArchived = false
    /// The study whose Remove is being confirmed.
    @State private var removing: StudyDetail?

    private let stepLabels = ["seed": "Capture seed sources", "collect": "Collect material", "index": "Index what was collected", "pages": "Write the pages", "report": "Write the report"]

    var body: some View {
        HStack(spacing: 0) {
            list
                .frame(width: 270)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let errorMessage {
                        Text(errorMessage).font(.callout).foregroundStyle(.red)
                    }
                    if let detail {
                        if detail.refining != nil {
                            refiningCard(detail)
                        } else if detail.job.status == "draft" {
                            draftCard(detail)
                        } else {
                            studyCard(detail)
                        }
                    } else {
                        composer
                    }
                }
                .padding(20)
                .frame(maxWidth: 980, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
        }
        .background(Color(nsColor: .textBackgroundColor).opacity(0.22))
        .task {
            await load()
            await takeHandOffs()
        }
        .onDisappear { poller?.cancel() }
        // a topic from the search field, or a study Tasks opened, while this screen is up
        .onChange(of: model.pendingResearchTopic) { _, pending in
            guard pending != nil else { return }
            Task { await takeHandOffs() }
        }
        .onChange(of: model.pendingStudyID) { _, pending in
            guard pending != nil else { return }
            Task { await takeHandOffs() }
        }
        .confirmationDialog(L("Remove this study?"), isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), presenting: removing) { d in
            Button(L("Remove"), role: .destructive) { Task { await remove(d) } }
        } message: { _ in
            Text(L("Its jobs and session logs go; the pages, notes and sources it already wrote stay in the knowledge base."))
        }
        // a study spends an agent's quota for an hour or more: what it would take, before it starts
        .sheet(isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } })) {
            if let d = confirming {
                StudyStartSheet(title: d.payload.brief.title, pages: d.payload.brief.pages.count, id: d.job.id) {
                    confirming = nil
                    Task { await start(d) }
                } cancel: {
                    confirming = nil
                }
                .environmentObject(model)
            }
        }
    }

    /* ---------------------------------------------------------------- list */

    private var list: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(showArchived ? L("Archived") : L("Studies")).font(.headline)
                Spacer()
                Button(showArchived ? L("Studies") : L("Archived")) {
                    showArchived.toggle()
                    Task { await load() }
                }
                .controlSize(.small)
                .help(L("Finished studies taken off the list"))
                Button {
                    poller?.cancel()
                    selected = nil
                    detail = nil
                } label: {
                    Label(L("New study"), systemImage: "plus")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    if studies.isEmpty {
                        Text(showArchived ? L("Nothing archived. Archive a finished study from its page to take it off the list.") : L("No studies yet. Describe a topic on the right to start one.")).font(.callout).foregroundStyle(.secondary)
                    }
                    ForEach(studies) { s in
                        Button {
                            Task { await open(s.id) }
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(s.title.isEmpty ? s.topic : s.title).font(.system(size: 12.5, weight: .medium)).lineLimit(2)
                                HStack(spacing: 6) {
                                    if let pause = s.pause { PauseChip(pause: pause) } else { StatusChip(status: s.status) }
                                    Text("\(s.stage) · \(s.pages) \(L("pages"))").font(.system(size: 10.5)).foregroundStyle(.secondary)
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(9)
                            .background(selected == s.id ? Color.knodeCyan.opacity(0.14) : Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .padding(14)
    }

    /* ------------------------------------------------------------ composer */

    private var composer: some View {
        VStack(alignment: .leading, spacing: 12) {
            Eyebrow(text: L("New study"))
            Text(L("What do you want to research?")).font(.title3.weight(.semibold))
            Text(L("A topic, a question, or a paragraph of what you want to understand. The refiner turns it into a brief — questions, the pages to write, the sources to start from — that you edit before anything runs."))
                .font(.callout).foregroundStyle(.secondary)
            TextEditor(text: $topic)
                .font(.system(size: 13))
                .frame(minHeight: 120)
                .padding(6)
                .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 8))
            HStack(spacing: 14) {
                Picker(L("Runs on"), selection: $agent) {
                    Text(L("The research agent")).tag("")
                    ForEach(agents.filter(\.available)) { a in Text(a.label).tag(a.id) }
                }
                .frame(maxWidth: 360)
                Toggle(L("Search the web"), isOn: $web)
            }
            HStack {
                Button(L("Refine the question")) { Task { await create() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy || topic.trimmingCharacters(in: .whitespacesAndNewlines).count < 8)
                if busy { ProgressView().controlSize(.small) }
            }
        }
    }

    private func refiningCard(_ d: StudyDetail) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Eyebrow(text: "\(L("Draft")) · \(d.job.id)")
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(L("Refining the question…")).font(.title3.weight(.semibold))
            }
            Text(L("The refiner reads your request, what this knowledge base already holds about it and the sources you picked, and plans the questions, the pages and the sources to start from. Nothing is searched or fetched yet."))
                .font(.callout).foregroundStyle(.secondary)
            Text(d.payload.topic).font(.callout).textSelection(.enabled)
        }
    }

    /* --------------------------------------------------------------- draft */

    private func draftCard(_ d: StudyDetail) -> some View {
        let b = d.payload.brief
        return VStack(alignment: .leading, spacing: 14) {
            Eyebrow(text: "\(L("Draft")) · \(d.job.id)")
            Text(b.title).font(.title3.weight(.semibold)).textSelection(.enabled)
            Text(b.objective).font(.callout).textSelection(.enabled)
            if !b.restatement.isEmpty {
                Text(b.restatement).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
            }
            if !b.clarifications.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text(L("Questions for you")).font(.headline)
                    ForEach(b.clarifications, id: \.question) { c in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(c.question).font(.callout)
                            if !c.options.isEmpty {
                                Picker("", selection: answerBinding(c)) {
                                    Text(L("Not answered")).tag("")
                                    ForEach(c.options, id: \.self) { o in Text(o).tag(o) }
                                }
                                .labelsHidden()
                            }
                            TextField(L("your answer"), text: answerBinding(c))
                                .textFieldStyle(.roundedBorder)
                        }
                    }
                }
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("\(L("Pages")) · \(b.pages.count)").font(.headline)
                ForEach(b.pages, id: \.id) { page in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(page.title).font(.system(size: 13, weight: .semibold))
                        if !page.purpose.isEmpty { Text(page.purpose).font(.system(size: 11.5)).foregroundStyle(.secondary) }
                        ForEach(page.questions, id: \.self) { qid in
                            if let q = b.questions.first(where: { $0.id == qid }) {
                                Text("• \(q.text)").font(.system(size: 11.5))
                            }
                        }
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(L("Refine again")).font(.headline)
                TextEditor(text: $feedback)
                    .font(.system(size: 12.5))
                    .frame(minHeight: 60)
                    .padding(6)
                    .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 8))
                HStack {
                    Button(L("Refine with my answers")) { Task { await refine(d) } }.disabled(busy)
                    Button(L("Start research")) { confirming = d }
                        .buttonStyle(.borderedProminent)
                        .disabled(busy || d.startProblem != nil)
                    if busy { ProgressView().controlSize(.small) }
                    if let problem = d.startProblem { Text(problem).font(.caption).foregroundStyle(.orange) }
                }
                Text(L("Edit pages and questions one by one in the web UI (Research → Studies)."))
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func answerBinding(_ c: StudyDetail.Clarification) -> Binding<String> {
        Binding(get: { answers[c.question] ?? c.answer ?? "" }, set: { answers[c.question] = $0 })
    }

    /* --------------------------------------------------------------- study */

    private func studyCard(_ d: StudyDetail) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Eyebrow(text: "\(L("Study")) · \(d.job.id)")
            Text(d.payload.brief.title).font(.title3.weight(.semibold)).textSelection(.enabled)
            HStack(spacing: 8) {
                StatusChip(status: d.job.status)
                Text("\(d.payload.stage) · \(d.job.agent ?? d.payload.runner.agent)").font(.caption).foregroundStyle(.secondary)
                Spacer()
                if d.pause != nil {
                    Button(L("Resume now")) { Task { await resume(d) } }
                        .help(L("The limit is lifted: run it now instead of when the pause ends"))
                }
                if d.isLive {
                    Button(L("Cancel")) { Task { await cancel(d) } }
                }
                if d.job.status == "failed" || d.job.status == "cancelled" {
                    Button(L("Retry")) { Task { await retry(d) } }
                }
                if !d.isLive {
                    Button(d.archivedAt == nil ? L("Archive") : L("Unarchive")) { Task { await archive(d, archived: d.archivedAt == nil) } }
                        .help(L("Take it off the list; its report, pages and sources stay where they are"))
                }
                if d.job.status == "failed" || d.job.status == "cancelled" {
                    Button(L("Remove"), role: .destructive) { removing = d }
                }
                if let n = d.tiers?.pages.quarantined, n > 0 {
                    Button(L("Promote pages (%@)", String(n))) { Task { await promote(d, what: "pages") } }
                }
                if let n = d.tiers?.sources.quarantined, n > 0 {
                    Button(L("Promote sources (%@)", String(n))) { Task { await promote(d, what: "sources") } }
                }
                if d.reportExists || d.pages.contains(where: { $0.status == "done" }) {
                    Button(L("Export")) { Task { await model.openStudyExport(id: d.job.id, slug: d.payload.brief.slug) } }
                        .help(L("The report and its pages as one HTML file, its charts as numbered figures: read it, save it, or print it to PDF"))
                }
            }
            if let pause = d.pause {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        PauseChip(pause: pause)
                        Text(L("It goes on by itself then, from where it stopped.")).font(.caption).foregroundStyle(.secondary)
                    }
                    Text(pause.reason).font(.caption).foregroundStyle(.secondary).textSelection(.enabled).lineLimit(3)
                }
            } else if let error = d.job.error {
                Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled)
            }
            VStack(alignment: .leading, spacing: 4) {
                ForEach(d.payload.steps, id: \.name) { step in
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        StatusChip(status: step.status)
                        Text(L(stepLabels[step.name] ?? step.name)).font(.system(size: 12, weight: .medium)).frame(width: 190, alignment: .leading)
                        Text(step.detail ?? "").font(.system(size: 11.5)).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(L("Report")).font(.headline)
                if d.reportExists {
                    Button(d.payload.brief.report.title) { model.openFile(d.reportPath) }.buttonStyle(.link)
                } else {
                    Text(L("Written once the pages are done.")).font(.callout).foregroundStyle(.secondary)
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(L("Pages")).font(.headline)
                ForEach(d.pages) { page in
                    HStack(spacing: 8) {
                        if page.status == "done" {
                            Button(page.title) { model.openFile(page.path) }.buttonStyle(.link)
                        } else {
                            Text(page.title)
                        }
                        Spacer()
                        if let trust = page.trust { Text(L(trust)).font(.caption).foregroundStyle(trust == "trusted" ? .green : .orange) }
                        if let pause = page.pause { PauseChip(pause: pause) } else { StatusChip(status: page.status) }
                    }
                    if let error = page.error { Text(error).font(.caption).foregroundStyle(.secondary).lineLimit(3) }
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("\(L("Sources")) · \(d.captures.count)").font(.headline)
                    if let t = d.tiers?.sources, !d.captures.isEmpty {
                        if t.quarantined > 0 {
                            Text(L("%@ files quarantined (captures, notes, register)", String(t.quarantined))).font(.caption).foregroundStyle(.orange)
                        } else if t.unindexed > 0 {
                            Text(L("%@ files not indexed yet", String(t.unindexed))).font(.caption).foregroundStyle(.secondary)
                        } else {
                            Text(L("all trusted")).font(.caption).foregroundStyle(.green)
                        }
                    }
                }
                ForEach(d.captures) { c in
                    HStack(spacing: 8) {
                        Button(c.title ?? c.url) { model.openFile(c.path) }.buttonStyle(.link).lineLimit(1)
                        Spacer()
                        Text([c.site, c.published.map { String($0.prefix(10)) } ?? "", c.kind].filter { !$0.isEmpty }.joined(separator: " · "))
                            .font(.caption).foregroundStyle(.secondary)
                        if AppModel.hasOriginal(c.path) {
                            Button(L("Original")) { Task { await model.openOriginal(c.path) } }
                                .buttonStyle(.link).font(.caption)
                                .help(L("The file itself, as it was captured"))
                        }
                    }
                }
            }
        }
    }

    /* ------------------------------------------------------------- actions */

    /// What another screen handed over: a study to open, or a topic for the
    /// composer. A topic waits there — refining it spends a model call, so the
    /// click that starts it stays the person's.
    private func takeHandOffs() async {
        if let id = model.consumePendingStudy() {
            await open(id)
        }
        if let pending = model.consumePendingResearchTopic() {
            poller?.cancel()
            selected = nil
            detail = nil
            topic = pending
            errorMessage = nil
        }
    }

    private func load() async {
        guard let api = try? model.client() else { return }
        do {
            async let list = api.studies(archived: showArchived)
            async let available = api.availableAgents()
            studies = try await list
            agents = (try? await available)?.agents ?? []
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func open(_ id: String) async {
        selected = id
        guard let api = try? model.client() else { return }
        do {
            detail = try await api.study(id: id)
            answers = [:]
            errorMessage = nil
            watch(id)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Poll while the study runs or its brief is being refined.
    private func watch(_ id: String) {
        poller?.cancel()
        guard detail?.isLive == true else { return }
        poller = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: detail?.refining != nil ? 2_500_000_000 : 5_000_000_000)
                guard !Task.isCancelled, selected == id, let api = try? model.client(), let next = try? await api.study(id: id) else { continue }
                detail = next
                if let list = try? await api.studies() { studies = list }
                if !next.isLive { break }
            }
        }
    }

    private func run(_ work: @escaping (APIClient) async throws -> Void) async {
        guard let api = try? model.client() else { return }
        busy = true
        defer { busy = false }
        do {
            try await work(api)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func create() async {
        await run { api in
            let created = try await api.createStudy(topic: topic, agent: agent, web: web)
            topic = ""
            await load()
            await open(created.job.id)
        }
    }

    private func refine(_ d: StudyDetail) async {
        await run { api in
            let next = try await api.refineStudy(id: d.job.id, feedback: feedback, answers: answers.filter { !$0.value.isEmpty })
            feedback = ""
            detail = next
            watch(d.job.id)
        }
    }

    private func start(_ d: StudyDetail) async {
        await run { api in
            let next = try await api.startStudy(id: d.job.id)
            detail = next
            await load()
            watch(d.job.id)
        }
    }

    private func cancel(_ d: StudyDetail) async {
        await run { api in
            _ = try await api.cancelStudy(id: d.job.id)
            await open(d.job.id)
        }
    }

    private func retry(_ d: StudyDetail) async {
        await run { api in
            detail = try await api.retryStudy(id: d.job.id)
            await load()
            watch(d.job.id)
        }
    }

    private func resume(_ d: StudyDetail) async {
        await run { api in
            _ = try await api.resumeStudy(id: d.job.id)
            await open(d.job.id)
        }
    }

    private func archive(_ d: StudyDetail, archived: Bool) async {
        await run { api in
            detail = try await api.archiveStudy(id: d.job.id, archived: archived)
            await load()
            if archived { model.showToast(L("Archived — the Archived list keeps it"), duration: 3_000_000_000) }
        }
    }

    private func remove(_ d: StudyDetail) async {
        await run { api in
            let r = try await api.removeStudy(id: d.job.id)
            removing = nil
            selected = nil
            detail = nil
            await load()
            model.showToast(r.kept.isEmpty ? L("Removed") : L("Removed — what it wrote stays in the knowledge base"), duration: 4_000_000_000)
        }
    }

    private func promote(_ d: StudyDetail, what: String) async {
        await run { api in
            let r = try await api.promoteStudy(id: d.job.id, what: what)
            await open(d.job.id)
            model.showToast(promotionSummary(r, what: what), duration: r.failed.isEmpty && r.notIndexed.isEmpty ? 3_000_000_000 : 6_000_000_000)
        }
    }

    /// "Pages and report: 7 now trusted · 1 not indexed yet" — what a Promote changed, as the web UI words it.
    private func promotionSummary(_ r: PromoteStudyResponse, what: String) -> String {
        var parts: [String] = []
        if !r.changed.isEmpty { parts.append(L("%@ now trusted", String(r.changed.count))) }
        if !r.unchanged.isEmpty { parts.append(L("%@ already trusted", String(r.unchanged.count))) }
        if !r.notIndexed.isEmpty { parts.append(L("%@ not indexed yet — try again in a moment", String(r.notIndexed.count))) }
        if let first = r.failed.first { parts.append(L("%@ failed: %@", String(r.failed.count), first.error)) }
        return "\(what == "pages" ? L("Pages and report") : L("Sources")): \(parts.isEmpty ? L("nothing to promote") : parts.joined(separator: " · "))"
    }
}

/// "paused until 01:32 · usage limit": a job waiting out a pause, the agent's words on hover.
struct PauseChip: View {
    let pause: RunPause

    private var when: String {
        guard let date = ServiceTime.date(pause.until) else { return pause.until }
        return Calendar.current.isDateInToday(date) ? date.formatted(date: .omitted, time: .shortened) : date.formatted(date: .abbreviated, time: .shortened)
    }

    private var why: String {
        switch pause.kind {
        case "quota": L("usage limit")
        case "transient": L("agent busy")
        case "setup": L("agent not set up")
        default: ""
        }
    }

    var body: some View {
        Text(why.isEmpty ? L("paused until %@", when) : "\(L("paused until %@", when)) · \(why)")
            .font(.system(size: 10, weight: .semibold, design: .monospaced))
            .foregroundStyle(.orange)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(Color.orange.opacity(0.12), in: Capsule())
            .help(pause.reason)
    }
}

/// A job or step status as a small coloured label.
struct StatusChip: View {
    let status: String

    private var color: Color {
        switch status {
        case "done": .green
        case "failed", "cancelled": .red
        case "running", "validating", "waiting", "queued": .knodeCyan
        case "paused": .orange
        default: .secondary
        }
    }

    var body: some View {
        Text(L(status))
            .font(.system(size: 10, weight: .semibold, design: .monospaced))
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(color.opacity(0.12), in: Capsule())
    }
}
