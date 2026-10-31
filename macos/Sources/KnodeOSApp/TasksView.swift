import AppKit
import SwiftUI

/// Words and marks for what `GET /api/tasks` names by id.
enum TaskWords {
    /// The pipeline, in the order a document passes it.
    static let stageOrder = ["index", "embed", "extract", "summarize", "translate", "review"]

    @MainActor static func stageTitle(_ id: String) -> String {
        switch id {
        case "index": L("Index")
        case "embed": L("Embed")
        case "extract": L("Extract")
        case "summarize": L("Summarize")
        case "translate": L("Translate")
        case "review": L("Review")
        default: id
        }
    }

    @MainActor static func stageAbout(_ id: String) -> String {
        switch id {
        case "index": L("Convert, chunk and apply new and changed files")
        case "embed": L("A vector for every chunk, for semantic search")
        case "extract": L("Entities, relations and claims, by a model")
        case "summarize": L("One summary page per document")
        case "translate": L("Into the primary content language")
        case "review": L("Judge calls: duplicate entities and claims")
        default: ""
        }
    }

    static func stageSymbol(_ id: String) -> String {
        switch id {
        case "index": "tray.and.arrow.down"
        case "embed": "circle.hexagongrid"
        case "extract": "text.viewfinder"
        case "summarize": "text.alignleft"
        case "translate": "character.bubble"
        case "review": "checkmark.seal"
        default: "circle"
        }
    }

    /// "documents waiting", in the stage's own unit.
    @MainActor static func waiting(_ unit: String, _ n: Int) -> String {
        switch unit {
        case "chunks": n == 1 ? L("chunk waiting") : L("chunks waiting")
        case "translations": n == 1 ? L("translation waiting") : L("translations waiting")
        case "calls": n == 1 ? L("call waiting") : L("calls waiting")
        default: n == 1 ? L("document waiting") : L("documents waiting")
        }
    }

    /// A lease's kind of work.
    @MainActor static func work(_ kind: String) -> String {
        switch kind {
        case "extract": L("Extract")
        case "summarize": L("Summarize")
        case "translate": L("Translate")
        case "judge": L("Review")
        default: kind
        }
    }

    static func workColor(_ kind: String) -> Color {
        switch kind {
        case "extract": .knodeCyan
        case "summarize": .knodeGood
        case "translate": .orange
        case "judge": .knodeViolet
        default: .secondary
        }
    }

    @MainActor static func job(_ kind: String) -> String {
        switch kind {
        case "study": L("Study")
        case "research": L("Page")
        case "init": L("Initialize")
        case "ask": L("Ask")
        default: kind
        }
    }

    static func jobSymbol(_ kind: String) -> String {
        switch kind {
        case "study": "doc.text.magnifyingglass"
        case "init": "wand.and.stars"
        case "ask": "sparkles"
        default: "book.closed"
        }
    }

    static func jobColor(_ kind: String) -> Color {
        switch kind {
        case "study": .orange
        case "ask": .knodeViolet
        default: .knodeCyan
        }
    }

    @MainActor static func scheduled(_ id: String) -> (title: String, about: String) {
        switch id {
        case "dream": (L("Dream"), L("reviews recent agent traces"))
        case "tier2": (L("Tier-2 pass"), L("merges, claim reviews, views and the wiki check"))
        case "traces": (L("Agent traces"), L("collects new Claude Code and Codex sessions"))
        case "datasources": (L("Datasources"), L("refreshes live schemas into the wiki"))
        default: (id, "")
        }
    }

    static func activitySymbol(_ kind: String) -> String {
        switch kind {
        case "sync": "arrow.triangle.2.circlepath"
        case "ingest": "tray.and.arrow.down"
        case "upload": "arrow.up.doc"
        case "folder": "folder"
        case "traces": "terminal"
        case "datasources": "cylinder"
        case "dream": "moon.stars"
        case "tier2": "gearshape.2"
        default: "circle"
        }
    }
}

/**
 * Tasks → Queue (docs/design/20 D6, D7): one view of everything the workspace
 * has under way — whether processing runs, and its switch; the pipeline stage
 * by stage; the model calls out right now and who holds them; this machine's
 * backends and the remote workers; research, study and Ask jobs; background
 * syncs; what runs on a clock. Read again every three seconds while shown.
 */
struct TasksView: View {
    @EnvironmentObject private var model: AppModel
    @State private var snapshot: TasksSnapshot?
    @State private var failure: String?
    @State private var confirmingStart = false
    @State private var confirmingStop = false
    @State private var switching = false
    /// Nil until someone opens or closes it: open by default while nothing runs.
    @State private var recentOpen: Bool?

    private static let pollNanoseconds: UInt64 = 3_000_000_000

    var body: some View {
        Group {
            if let snapshot {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        processingCard(snapshot)
                        pipeline(snapshot)
                        inFlightCard(snapshot)
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 400), spacing: 16, alignment: .top)], alignment: .leading, spacing: 16) {
                            workersCard(snapshot)
                            jobsCard(snapshot)
                            backgroundCard(snapshot)
                            scheduleCard(snapshot)
                        }
                        if !snapshot.documentErrors.isEmpty { errorsCard(snapshot) }
                    }
                    .padding(20)
                    .frame(maxWidth: 1180, alignment: .leading)
                    .frame(maxWidth: .infinity)
                }
            } else if let failure {
                EmptyState(
                    symbol: "exclamationmark.triangle",
                    title: L("The queue could not be read"),
                    message: failure,
                    actionTitle: L("Try again"),
                    action: { Task { await load() } }
                )
            } else {
                ProgressView(L("Reading the queue…"))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Color(nsColor: .textBackgroundColor).opacity(0.22))
        .task {
            if let kept = model.lastTasks, kept.revision == model.workspaceRevision, kept.workspaceID == model.activeWorkspace?.id {
                snapshot = kept.snapshot
            }
            while !Task.isCancelled {
                await load()
                // in the background a slower beat: nobody is watching
                try? await Task.sleep(nanoseconds: NSApp.isActive ? Self.pollNanoseconds : 5 * Self.pollNanoseconds)
            }
        }
        // starting spends model calls: what it would take, before anyone presses Start
        .sheet(isPresented: $confirmingStart) {
            ProcessingStartSheet {
                confirmingStart = false
                Task { await switchProcessing(true) }
            } cancel: {
                confirmingStart = false
            }
            .environmentObject(model)
        }
        .alert(L("Stop processing?"), isPresented: $confirmingStop) {
            Button(L("Cancel"), role: .cancel) {}
            Button(L("Stop processing"), role: .destructive) { Task { await switchProcessing(false) } }
        } message: {
            Text(L("Calls in flight finish; nothing new starts until someone starts it again."))
        }
    }

    /* ----------------------------- processing ----------------------------- */

    private func processingCard(_ t: TasksSnapshot) -> some View {
        let state = t.processing
        let running = state?.running == true
        return VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                StatusDot(color: running ? .knodeGood : .secondary, size: 10)
                    .padding(.top, 6)
                VStack(alignment: .leading, spacing: 4) {
                    Text(state == nil ? L("No processing here") : running ? L("Processing") : L("Processing is stopped"))
                        .font(.title3.weight(.semibold))
                    Text(stateLine(t))
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 12)
                if state != nil {
                    VStack(alignment: .trailing, spacing: 6) {
                        HStack(spacing: 8) {
                            if switching { ProgressView().controlSize(.small) }
                            Button(running ? L("Stop processing") : L("Start processing…")) {
                                if running { confirmingStop = true } else { confirmingStart = true }
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(running ? .knodeBad : .knodeCyan)
                            .disabled(switching || !model.maySaveSettings)
                        }
                        if !model.maySaveSettings {
                            Text(L("An administrator starts and stops processing."))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            if let stats = model.stats {
                HStack(spacing: 16) {
                    MetricPill(value: stats.documents, label: L("docs"))
                    MetricPill(value: stats.chunks, label: L("chunks"))
                    MetricPill(value: stats.entities, label: L("entities"))
                    MetricPill(value: stats.relations, label: L("rels"))
                    Spacer(minLength: 8)
                    if let embedding = stats.embeddingModel {
                        Label(embedding, systemImage: "circle.hexagongrid")
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                            .help(L("The embedding model vectors are made with"))
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 8))
            }
        }
        .knodeCard(padding: 18)
    }

    private func stateLine(_ t: TasksSnapshot) -> String {
        guard let state = t.processing else {
            return t.serving
                ? L("This workspace has no processing switch.")
                : L("Extraction and the other model stages run inside knode-os serve.")
        }
        let when = ServiceTime.clock(state.since)
        if state.running {
            let since = when.flatMap { when in state.by.map { L("Running since %@, started by %@", when, $0) } } ?? L("Running")
            return since + ". " + L("Extraction, reviews, summaries and translations take work as slots free up.")
        }
        if let when, let by = state.by {
            return L("Stopped at %@ by %@", when, by) + " — " + L("extraction, summaries and reviews wait until someone starts them.")
        }
        return L("Stopped — extraction, summaries and reviews wait until someone starts them.")
    }

    private func switchProcessing(_ on: Bool) async {
        switching = true
        defer { switching = false }
        await model.setProcessing(on)
        await load()
    }

    /* ------------------------------ pipeline ------------------------------ */

    private func pipeline(_ t: TasksSnapshot) -> some View {
        let stages = t.stages.sorted {
            (TaskWords.stageOrder.firstIndex(of: $0.id) ?? 99) < (TaskWords.stageOrder.firstIndex(of: $1.id) ?? 99)
        }
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(L("Pipeline")).font(.headline)
                Text(L("each document passes these stages in order"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 160), spacing: 10, alignment: .top)], alignment: .leading, spacing: 10) {
                ForEach(Array(stages.enumerated()), id: \.element.id) { index, stage in
                    stageCard(stage, step: index + 1)
                }
            }
        }
    }

    private func stageCard(_ stage: TasksSnapshot.Stage, step: Int) -> some View {
        let busy = stage.inFlight > 0
        let blocked = stage.enabled && stage.waiting > 0 && stage.note != nil
        let accent: Color = busy ? .knodeGood : blocked ? .orange : .knodeCyan
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: TaskWords.stageSymbol(stage.id))
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(stage.enabled ? accent : Color.secondary)
                Text(TaskWords.stageTitle(stage.id)).font(.callout.weight(.semibold))
                Spacer(minLength: 4)
                Text("\(step)")
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
            if stage.enabled {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Text(stage.waiting.formatted())
                        .font(.system(size: 24, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                    Text(TaskWords.waiting(stage.unit, stage.waiting))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                VStack(alignment: .leading, spacing: 3) {
                    if busy {
                        HStack(spacing: 5) {
                            StatusDot(color: .knodeGood, size: 6)
                            Text(L("%@ in flight", stage.inFlight.formatted()))
                        }
                    }
                    if let line = lastHour(stage) {
                        Text(line).foregroundStyle(.secondary)
                    }
                    if stage.failed > 0 {
                        Text(L("%@ failed", stage.failed.formatted())).foregroundStyle(Color.knodeBad)
                    }
                }
                .font(.caption)
            } else {
                Text(L("Off"))
                    .font(.system(size: 24, weight: .semibold, design: .rounded))
                    .foregroundStyle(.tertiary)
                Text(L("off for this workspace"))
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            if let note = stage.note, stage.enabled {
                Text(noteText(note))
                    .font(.caption)
                    .foregroundStyle(blocked ? Color.orange : Color.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, minHeight: 128, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 10).fill(stage.enabled ? accent.opacity(busy || blocked ? 0.08 : 0.04) : Color.primary.opacity(0.02)))
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .stroke(stage.enabled && (busy || blocked) ? accent.opacity(0.5) : Color.primary.opacity(0.09))
        }
        .opacity(stage.enabled ? 1 : 0.55)
        .help(TaskWords.stageAbout(stage.id))
    }

    /// The service's note in the interface language, its retry time as a clock time.
    private func noteText(_ note: String) -> String {
        let retrying = "the provider could not serve: retrying at "
        if note.hasPrefix(retrying), let time = ServiceTime.clock(String(note.dropFirst(retrying.count))) {
            return L("The provider could not serve — retrying at %@", time)
        }
        return L(note)
    }

    /// "Last hour: 12 done · 30 calls".
    private func lastHour(_ stage: TasksSnapshot.Stage) -> String? {
        guard stage.doneLastHour != nil || stage.callsLastHour != nil else { return nil }
        var parts: [String] = []
        if let done = stage.doneLastHour { parts.append(L("%@ done", done.formatted())) }
        if let calls = stage.callsLastHour, calls > 0 { parts.append(calls == 1 ? L("1 call") : L("%@ calls", calls.formatted())) }
        return L("Last hour: %@", parts.isEmpty ? L("nothing") : parts.joined(separator: " · "))
    }

    /* ------------------------------ in flight ----------------------------- */

    private func inFlightCard(_ t: TasksSnapshot) -> some View {
        card(L("In flight"), symbol: "bolt.horizontal", count: t.inFlight.isEmpty ? nil : t.inFlight.count.formatted()) {
            if t.inFlight.isEmpty {
                hint(t.processing?.running == true ? L("Nothing out right now — the slots are waiting for work.") : L("No model calls out."))
            } else {
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 8) {
                    GridRow {
                        Text(L("Stage"))
                        Text(L("Document"))
                        Text(L("Part"))
                        Text(L("Worker"))
                        Text(L("Running")).gridColumnAlignment(.trailing)
                        Text(L("Lease ends")).gridColumnAlignment(.trailing)
                    }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    Divider().gridCellUnsizedAxes(.horizontal)
                    ForEach(t.inFlight) { lease in
                        GridRow {
                            KindPill(text: TaskWords.work(lease.kind), color: TaskWords.workColor(lease.kind))
                            Group {
                                if lease.kind == "judge" {
                                    Text(lease.subject).lineLimit(2)
                                } else {
                                    Button(lease.subject) { model.openFile(lease.subject) }
                                        .buttonStyle(.link)
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                        .help(lease.subject)
                                }
                            }
                            .font(.system(size: 11.5, design: .monospaced))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            Text(lease.detail ?? "—")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            VStack(alignment: .leading, spacing: 1) {
                                HStack(spacing: 5) {
                                    Text(lease.backend).font(.system(size: 11.5, design: .monospaced))
                                    if lease.remote { Tag(text: L("remote"), color: .knodeViolet) }
                                }
                                Text(lease.worker)
                                    .font(.system(size: 9.5, design: .monospaced))
                                    .foregroundStyle(.tertiary)
                                    .lineLimit(1)
                            }
                            Text(ServiceTime.span(lease.ageSeconds))
                                .font(.caption.monospacedDigit())
                            Text(lease.expiresInSeconds > 0 ? ServiceTime.span(lease.expiresInSeconds) : L("lapsed"))
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(lease.expiresInSeconds > 0 ? Color.primary : Color.orange)
                        }
                    }
                }
            }
        }
    }

    /* ------------------------------- workers ------------------------------ */

    private func workersCard(_ t: TasksSnapshot) -> some View {
        let online = t.workers.filter(\.online).count
        return card(L("Workers"), symbol: "cpu", count: t.workers.isEmpty ? nil : L("%@ of %@ online", String(online), String(t.workers.count))) {
            if t.workers.isEmpty {
                hint(t.serving
                    ? L("No model slots on this machine and no remote worker has asked for work. Slots come from the stage routes in Settings → Ingest; remote workers connect with a token (knode-os remote token create).")
                    : L("Workers run inside knode-os serve."))
            }
            ForEach(t.workers) { worker in workerRow(worker) }
        }
    }

    private func workerRow(_ w: TasksSnapshot.Worker) -> some View {
        let paused = w.pausedUntil != nil
        let state = paused ? L("paused") : w.online ? (w.busy > 0 ? L("busy") : L("idle")) : L("offline")
        let load = w.slots.map { L("%@ of %@ busy", String(w.busy), String($0)) } ?? L("%@ leased", String(w.busy))
        var line = [state, load, L("%@ ok", w.ok.formatted())]
        if w.failed > 0 { line.append(L("%@ failed", w.failed.formatted())) }
        if w.remote { line.append(L("seen %@", ServiceTime.ago(w.lastSeen))) }
        return HStack(alignment: .top, spacing: 9) {
            StatusDot(color: paused ? .orange : w.online ? .knodeGood : .secondary, size: 7)
                .padding(.top, 5)
                .help(state)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(w.label).font(.system(size: 12.5, weight: .semibold, design: .monospaced)).lineLimit(1)
                    Tag(text: w.remote ? L("remote") : L("this machine"), color: w.remote ? .knodeViolet : .secondary)
                    if !w.kinds.isEmpty {
                        Text(w.kinds.map(TaskWords.work).joined(separator: " · "))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Text(line.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(w.failed > 0 ? Color.primary : Color.secondary)
                if w.remote {
                    Text(w.id).font(.system(size: 9.5, design: .monospaced)).foregroundStyle(.tertiary).lineLimit(1)
                }
                if paused {
                    Text(L("Resting until %@", ServiceTime.clock(w.pausedUntil) ?? "…") + (w.pauseReason.map { ": \($0)" } ?? ""))
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                } else if let error = w.lastError {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(Color.knodeBad)
                        .lineLimit(3)
                        .help(error)
                }
            }
            Spacer(minLength: 0)
        }
    }

    /* -------------------------------- jobs -------------------------------- */

    private func jobsCard(_ t: TasksSnapshot) -> some View {
        let live = t.jobs.filter(\.isLive).count
        return card(L("Jobs"), symbol: "doc.text.magnifyingglass", count: live > 0 ? L("%@ under way", String(live)) : nil) {
            if t.jobs.isEmpty {
                hint(L("No research, study or Ask turn is running, and none ended in the last day."))
            }
            ForEach(t.jobs) { job in jobRow(job) }
        }
    }

    private func jobRow(_ job: TasksSnapshot.Job) -> some View {
        let when: String = job.finishedAt != nil
            ? L("ended %@", ServiceTime.ago(job.finishedAt))
            : job.startedAt != nil ? L("started %@", ServiceTime.ago(job.startedAt)) : L("queued %@", ServiceTime.ago(job.createdAt))
        return HStack(alignment: .top, spacing: 9) {
            Image(systemName: TaskWords.jobSymbol(job.kind))
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(TaskWords.jobColor(job.kind))
                .frame(width: 18)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 4) {
                Button(job.title.isEmpty ? TaskWords.job(job.kind) : job.title) { open(job) }
                    .buttonStyle(.plain)
                    .font(.system(size: 12.5, weight: .semibold))
                    .lineLimit(2)
                    .help(openHelp(job))
                HStack(spacing: 6) {
                    StatusChip(status: job.status)
                    Text(TaskWords.job(job.kind)).font(.caption).foregroundStyle(.tertiary)
                    if let stage = job.stage, job.kind != "ask", stage != job.kind {
                        Text(stage).font(.caption).foregroundStyle(.secondary)
                    }
                    Text(when).font(.caption).foregroundStyle(.secondary)
                    if let output = job.outputPath {
                        Button((output as NSString).lastPathComponent) { model.openFile(output) }
                            .buttonStyle(.link)
                            .font(.system(size: 10.5, design: .monospaced))
                            .lineLimit(1)
                            .help(output)
                    }
                }
                if let error = job.error {
                    Text(String(error.prefix(240)))
                        .font(.caption)
                        .foregroundStyle(Color.knodeBad)
                        .lineLimit(3)
                        .help(error)
                }
            }
            Spacer(minLength: 0)
        }
    }

    /// Where a job lives: a study in Research, an Ask turn in its conversation, a page job in the wiki.
    private func open(_ job: TasksSnapshot.Job) {
        switch job.kind {
        case "study": model.openStudy(job.id)
        case "ask": model.openConversation(job.id)
        default: model.select(.wiki)
        }
    }

    private func openHelp(_ job: TasksSnapshot.Job) -> String {
        switch job.kind {
        case "study": L("Open the study in Explore → Research")
        case "ask": L("Open the conversation in Explore → Ask")
        default: L("Open Knowledge → Wiki")
        }
    }

    /* ----------------------------- background ----------------------------- */

    private func backgroundCard(_ t: TasksSnapshot) -> some View {
        let running = t.activity.running
        let recent = Array(t.activity.recent.prefix(12))
        return card(L("Background"), symbol: "arrow.triangle.2.circlepath", count: running.isEmpty ? nil : L("%@ running", String(running.count))) {
            if running.isEmpty && recent.isEmpty {
                hint(L("Nothing has run in the background since the service started."))
            }
            ForEach(running) { item in
                HStack(alignment: .top, spacing: 9) {
                    ProgressView().controlSize(.small).frame(width: 18)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(L(item.label)).font(.system(size: 12.5, weight: .medium)).lineLimit(2)
                        Text(L("running for %@", ServiceTime.span(Date().timeIntervalSince(ServiceTime.date(item.startedAt) ?? Date()))))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                }
            }
            if !recent.isEmpty {
                DisclosureGroup(isExpanded: Binding(get: { recentOpen ?? running.isEmpty }, set: { recentOpen = $0 })) {
                    VStack(alignment: .leading, spacing: 7) {
                        ForEach(recent) { item in recentRow(item) }
                    }
                    .padding(.top, 6)
                } label: {
                    Text(L("Recent · %@", String(t.activity.recent.count)))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func recentRow(_ item: TasksSnapshot.ActivityItem) -> some View {
        let ok = item.ok != false
        var meta: [String] = []
        if let detail = item.detail, !detail.isEmpty { meta.append(detail) }
        meta.append(ServiceTime.ago(item.finishedAt))
        if let start = ServiceTime.date(item.startedAt), let end = ServiceTime.date(item.finishedAt) {
            meta.append(L("took %@", ServiceTime.span(end.timeIntervalSince(start))))
        }
        return HStack(alignment: .top, spacing: 9) {
            Image(systemName: ok ? "checkmark.circle.fill" : "xmark.circle.fill")
                .font(.system(size: 11))
                .foregroundStyle(ok ? Color.knodeGood : Color.knodeBad)
                .frame(width: 18)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Image(systemName: TaskWords.activitySymbol(item.kind))
                        .font(.system(size: 9.5))
                        .foregroundStyle(.tertiary)
                    Text(L(item.label)).font(.system(size: 12)).lineLimit(2)
                }
                Text(meta.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(ok ? Color.secondary : Color.knodeBad)
                    .lineLimit(2)
                    .help(item.detail ?? "")
            }
            Spacer(minLength: 0)
        }
    }

    /* ------------------------------ schedule ------------------------------ */

    private func scheduleCard(_ t: TasksSnapshot) -> some View {
        card(L("Schedule"), symbol: "clock", count: nil) {
            ForEach(t.scheduled) { item in scheduleRow(item) }
            if !t.folders.isEmpty {
                Text(L("Linked folders"))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.top, 4)
                ForEach(t.folders) { folder in folderRow(folder) }
            }
            if t.dream.pendingSuggestions > 0 {
                Button(t.dream.pendingSuggestions == 1
                    ? L("Dream has 1 suggestion waiting for review")
                    : L("Dream has %@ suggestions waiting for review", String(t.dream.pendingSuggestions))) {
                    model.select(.dream)
                }
                .buttonStyle(.link)
                .font(.caption)
                .padding(.top, 2)
            }
        }
    }

    private func scheduleRow(_ item: TasksSnapshot.Scheduled) -> some View {
        let words = TaskWords.scheduled(item.id)
        var when: String
        if !item.enabled {
            when = L("Off")
        } else if let at = item.at {
            when = L("daily at %@", at)
            if let next = ServiceTime.until(item.next) { when += " · " + L("next %@", next) }
        } else if let every = item.everyMinutes {
            when = L("every %@ min", String(every))
        } else {
            when = ""
        }
        if item.running { when = L("running now") + (when.isEmpty ? "" : " · " + when) }
        return HStack(alignment: .top, spacing: 9) {
            Group {
                if item.running {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(systemName: item.id == "dream" ? "moon.stars" : "clock")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
            }
            .frame(width: 18)
            .padding(.top, 1)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(words.title).font(.system(size: 12.5, weight: .semibold))
                    Text(words.about).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Text(when).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .opacity(item.enabled ? 1 : 0.5)
    }

    private func folderRow(_ folder: TasksSnapshot.Folder) -> some View {
        var line = folder.lastSyncAt != nil ? L("synced %@", ServiceTime.ago(folder.lastSyncAt)) : L("not synced since the service started")
        if let change = folder.lastChange {
            line += " · " + L("last change: %@ copied, %@ removed", String(change.copied ?? 0), String(change.removed ?? 0))
        }
        let source = model.serviceIsOnThisMac ? (folder.source as NSString).abbreviatingWithTildeInPath : folder.source
        return HStack(alignment: .top, spacing: 9) {
            StatusDot(color: folder.watching ? .knodeGood : .secondary, size: 7)
                .frame(width: 18)
                .padding(.top, 4)
                .help(folder.watching ? L("Watching its source") : L("Not watching its source"))
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(folder.dest).font(.system(size: 11.5, weight: .semibold, design: .monospaced)).lineLimit(1)
                    Text("← \(source)")
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .help(folder.source)
                }
                Text(line).font(.caption).foregroundStyle(.secondary)
                if let error = folder.lastError {
                    Text(error).font(.caption).foregroundStyle(Color.knodeBad).lineLimit(3).help(error)
                }
            }
            Spacer(minLength: 0)
        }
    }

    /* ------------------------------- errors ------------------------------- */

    private func errorsCard(_ t: TasksSnapshot) -> some View {
        let failed = t.stages.first { $0.id == "index" }?.failed ?? t.documentErrors.count
        return card(L("Documents that failed to index"), symbol: "exclamationmark.triangle", count: failed.formatted()) {
            ForEach(t.documentErrors) { document in
                VStack(alignment: .leading, spacing: 2) {
                    Button(document.path) { model.openFile(document.path) }
                        .buttonStyle(.link)
                        .font(.system(size: 11.5, design: .monospaced))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(document.error ?? L("failed"))
                        .font(.caption)
                        .foregroundStyle(Color.knodeBad)
                        .lineLimit(3)
                        .textSelection(.enabled)
                }
            }
            if failed > t.documentErrors.count {
                hint(L("and %@ more", String(failed - t.documentErrors.count)))
            }
        }
    }

    /* ------------------------------- pieces ------------------------------- */

    private func card<Content: View>(_ title: String, symbol: String, count: String?, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 7) {
                Image(systemName: symbol)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Color.knodeCyan)
                Text(title).font(.headline)
                if let count {
                    Text(count).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            content()
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .knodeCard(padding: 16)
    }

    private func hint(_ text: String) -> some View {
        Text(text)
            .font(.callout)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func load() async {
        do {
            let next = try await model.client().tasks()
            guard !Task.isCancelled else { return }
            snapshot = next
            failure = nil
            model.lastTasks = (model.activeWorkspace?.id, model.workspaceRevision, next)
            // the toolbar's pill and the sidebar's badge read every 15 s: catch them up when this read says otherwise
            if next.processing?.running != model.processing?.processing?.running
                || next.dream.pendingSuggestions != (model.stats?.pendingSuggestions ?? next.dream.pendingSuggestions) {
                await model.refreshStats()
            }
        } catch let error as APIError where error.sessionEnded {
            model.sessionEnded()
        } catch {
            guard !Task.isCancelled else { return }
            // a read that fails while a snapshot shows keeps it: the next beat tries again
            if snapshot == nil { failure = error.localizedDescription }
        }
    }
}

/// A short coloured label: a kind of work.
private struct KindPill: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(color.opacity(0.13), in: Capsule())
    }
}

/// "remote", "this machine".
private struct Tag: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.system(size: 9.5, weight: .semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .overlay { Capsule().stroke(color.opacity(0.45)) }
    }
}

/// Before processing starts: what it would take, then Start or Cancel.
private struct ProcessingStartSheet: View {
    @EnvironmentObject private var model: AppModel
    let start: () -> Void
    let cancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(L("Start processing?")).font(.title3.weight(.semibold))
                Text(L("Extraction of entities, relations and claims, then duplicate reviews and summary pages. They spend model calls, so they run only after someone starts them — never on their own, not even after a restart."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ScrollView {
                EstimateSection { try await model.client().processingEstimate() }
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(minHeight: 160, maxHeight: 460)
            HStack {
                Spacer()
                Button(L("Cancel"), action: cancel).keyboardShortcut(.cancelAction)
                Button(L("Start processing"), action: start)
                    .buttonStyle(.borderedProminent)
                    .tint(.knodeCyan)
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 520)
    }
}
