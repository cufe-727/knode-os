import SwiftUI

/// Deep-research pages: queue a page for the configured coding-agent CLI,
/// watch jobs, review the pages it wrote (promote / demote / refresh), and
/// accept recommendations. Mirrors the web UI's Wiki tab.
struct WikiView: View {
    @EnvironmentObject private var model: AppModel
    @State private var kind = "entity"
    @State private var target = ""
    @State private var jobs: [ResearchJob] = []
    @State private var pages: [ResearchPage] = []
    @State private var recommendations: [ResearchRecommendation] = []
    @State private var isLoading = true
    @State private var errorMessage: String?

    private let kinds: [(String, String)] = [
        ("entity", "Entity page"), ("concept", "Concept page"), ("comparison", "Comparison"),
        ("timeline", "Timeline"), ("question", "Question → answer page"), ("refresh", "Refresh a page (path)"), ("verify", "Verify an entity (web)"),
    ]

    var body: some View {
        VStack(spacing: 0) {
            queueBar
            Divider()
            if isLoading && jobs.isEmpty && pages.isEmpty {
                ProgressView("Loading research…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        if let errorMessage {
                            Text(errorMessage).font(.callout).foregroundStyle(.red)
                        }
                        section("Recommended pages", empty: L("Nothing to recommend yet — recommendations come from hot entities, repeated questions and pages whose facts changed."), isEmpty: recommendations.isEmpty) {
                            ForEach(recommendations) { rec in recommendationRow(rec) }
                        }
                        section("Jobs", empty: L("No research jobs yet. Queue one above or accept a recommendation."), isEmpty: jobs.isEmpty) {
                            ForEach(jobs) { job in jobRow(job) }
                        }
                        section("Research pages", empty: L("No research pages yet."), isEmpty: pages.isEmpty) {
                            ForEach(pages) { page in pageRow(page) }
                        }
                    }
                    .padding(20)
                    .frame(maxWidth: 980)
                    .frame(maxWidth: .infinity)
                }
            }
        }
        .background(Color(nsColor: .textBackgroundColor).opacity(0.22))
        .task { await load() }
    }

    private var queueBar: some View {
        HStack(spacing: 10) {
            Picker(L("Kind"), selection: $kind) {
                ForEach(kinds, id: \.0) { Text($0.1).tag($0.0) }
            }
            .labelsHidden()
            .frame(width: 190)
            TextField(L("entity / concept name, “A vs B”, a question, or wiki/… path"), text: $target)
                .textFieldStyle(.roundedBorder)
                .onSubmit { Task { await queue() } }
            Button { Task { await queue() } } label: { Label("Queue research", systemImage: "checkmark.square") }
                .buttonStyle(.borderedProminent)
                .tint(.knodeCyan)
                .disabled(target.trimmingCharacters(in: .whitespaces).isEmpty)
            Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }
                .help(L("Reload jobs, pages and recommendations"))
        }
        .padding(.horizontal, 18)
        .frame(height: 66)
        .background(.bar)
    }

    @ViewBuilder
    private func section<Content: View>(_ title: String, empty: String, isEmpty: Bool, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title.uppercased())
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
            if isEmpty {
                Text(empty).font(.callout).foregroundStyle(.secondary)
            } else {
                content()
            }
        }
    }

    private func card<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        content()
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 9))
            .overlay { RoundedRectangle(cornerRadius: 9).stroke(Color.white.opacity(0.08)) }
    }

    private func badge(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.system(size: 10, weight: .semibold, design: .monospaced))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(color.opacity(0.16), in: Capsule())
            .foregroundStyle(color)
    }

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "done", "trusted": .green
        case "failed": .red
        case "running", "validating": Color.knodeCyan
        case "quarantined": .orange
        default: .secondary
        }
    }

    private func recommendationRow(_ rec: ResearchRecommendation) -> some View {
        card {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    badge(rec.kind, color: Color.knodeCyan)
                    Text(rec.target).font(.callout.weight(.semibold)).lineLimit(1)
                    Spacer()
                    Text(String(format: "%.2f", rec.score)).font(.caption.monospaced()).foregroundStyle(.secondary)
                    Button(L("Queue")) { Task { await accept(rec) } }.controlSize(.small)
                    if rec.suggestionId != nil {
                        Button(L("Dismiss")) { Task { await dismiss(rec) } }.controlSize(.small)
                    }
                }
                Text(rec.reasons.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func jobRow(_ job: ResearchJob) -> some View {
        card {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    badge(job.status, color: statusColor(job.status))
                    Text("\(job.kind) · \(job.subject)").font(.callout).lineLimit(1)
                    if let out = job.outputPath {
                        Button(out) { model.openFile(out) }.buttonStyle(.link).font(.caption.monospaced())
                    }
                    Spacer()
                    if let turns = job.turns { Text(L("%@ turns", String(turns))).font(.caption).foregroundStyle(.secondary) }
                    if job.status == "queued" || job.status == "running" {
                        Button(L("Cancel")) { Task { await cancel(job) } }.controlSize(.small)
                    }
                    if job.status == "failed" || job.status == "cancelled" {
                        Button(L("Retry")) { Task { await retry(job) } }.controlSize(.small)
                    }
                }
                if let error = job.error {
                    Text(error).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
        }
    }

    private func pageRow(_ page: ResearchPage) -> some View {
        card {
            HStack(spacing: 8) {
                Button(page.path) { model.openFile(page.path) }.buttonStyle(.link).font(.callout.monospaced())
                Text("\(page.kind) · \(page.target ?? "")").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                Spacer()
                badge(page.trust ?? (page.exists ? "unsynced" : "missing"), color: statusColor(page.trust ?? ""))
                if page.trust == "quarantined" {
                    Button(L("Promote")) { Task { await setTrust(page, to: "trusted") } }.controlSize(.small)
                } else if page.trust == "trusted" {
                    Button(L("Demote")) { Task { await setTrust(page, to: "quarantined") } }.controlSize(.small)
                }
                Button(L("Refresh")) { Task { await queueRefresh(page) } }.controlSize(.small)
            }
        }
    }

    // MARK: - actions

    private func load() async {
        guard let api = try? model.client() else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            async let j = api.researchJobs()
            async let p = api.researchPages()
            async let r = api.researchRecommendations()
            jobs = try await j
            pages = try await p
            recommendations = try await r
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func queue() async {
        guard let api = try? model.client() else { return }
        let text = target.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return }
        do {
            let res = try await api.queueResearch(kind: kind, target: kind == "question" ? nil : text, query: kind == "question" ? text : nil)
            model.showToast(res.created ? "Queued \(res.job.id)" : "Already queued: \(res.job.id)")
            target = ""
            await load()
        } catch {
            model.showToast("Queue failed: \(error.localizedDescription)")
        }
    }

    private func accept(_ rec: ResearchRecommendation) async {
        guard let api = try? model.client() else { return }
        do {
            if let id = rec.suggestionId {
                _ = try await api.updateSuggestion(id: id, status: "accepted")
            } else {
                _ = try await api.queueResearch(kind: rec.kind, target: rec.kind == "question" ? nil : rec.target, query: rec.kind == "question" ? rec.target : nil)
            }
            model.showToast("Research queued")
            await load()
        } catch {
            model.showToast("Failed: \(error.localizedDescription)")
        }
    }

    private func dismiss(_ rec: ResearchRecommendation) async {
        guard let api = try? model.client(), let id = rec.suggestionId else { return }
        _ = try? await api.updateSuggestion(id: id, status: "rejected")
        await load()
    }

    private func cancel(_ job: ResearchJob) async {
        guard let api = try? model.client() else { return }
        _ = try? await api.cancelResearch(id: job.id)
        await load()
    }

    private func retry(_ job: ResearchJob) async {
        guard let api = try? model.client() else { return }
        _ = try? await api.retryResearch(id: job.id)
        await load()
    }

    private func setTrust(_ page: ResearchPage, to: String) async {
        guard let api = try? model.client() else { return }
        do {
            _ = try await api.setTrust(path: page.path, to: to)
            model.showToast("\(page.path): \(to)")
            await load()
        } catch {
            model.showToast("Trust change failed: \(error.localizedDescription)")
        }
    }

    private func queueRefresh(_ page: ResearchPage) async {
        guard let api = try? model.client() else { return }
        _ = try? await api.queueResearch(kind: "refresh", target: page.path, query: nil)
        model.showToast("Refresh queued")
        await load()
    }
}
