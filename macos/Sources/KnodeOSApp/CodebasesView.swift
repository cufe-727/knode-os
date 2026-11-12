import SwiftUI

/// Library → Import → Code repositories (docs/design/25): repositories kept at
/// one commit under raw/codebase/<name>/, each with a card and its
/// documentation in raw/docs/codebase/. Adding fetches from the network onto
/// the service's machine, so it is an administrator's call; whoever may sync
/// the files may update, edit and remove what is there. A fetch runs in the
/// background as a `codebase` activity, which the sheet follows while open.
struct CodebasesSheet: View {
    @EnvironmentObject private var model: AppModel
    /// An entry to open for editing straight away (a repository's menu in the tree).
    let initialEdit: String?
    /// The tree and the counts change with a fetch or a removal.
    let changed: () async -> Void
    /// Open a repository's card in Files.
    let openCard: (String) -> Void
    let close: () -> Void

    @State private var listing = CodebaseListing()
    @State private var loaded = false
    @State private var errorText: String?
    @State private var repository = ""
    @State private var name = ""
    @State private var ref = ""
    @State private var include = ""
    @State private var exclude = ""
    @State private var follow = false
    @State private var docs = true
    /// The entry the form edits; nil while it adds one.
    @State private var editing: String?
    /// The entry whose removal waits on a yes, and whether its files stay.
    @State private var removing: String?
    @State private var keepFiles = false
    @State private var busy = false
    /// A fetch was running at the last look: its end redraws the tree and says how it went.
    @State private var wasRunning = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 5) {
                Eyebrow(text: L("Code repositories"))
                Text(L("Code repositories")).font(.title2.bold())
                Text(L("Each is kept at one commit in raw/codebase/<name>/ — source, configuration and prose, not dependencies, build output or binaries. Code turns up when a search asks for it (kind code) and agents read and grep it; the repository's card and its documentation in raw/docs/codebase/ are learned from like any document."))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            activityRow
            entriesList
            if editing != nil || model.maySaveSettings {
                form
            } else if model.mayUseFiles {
                Text(L("Adding a repository fetches it from the network onto the service's machine: an administrator's call."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let errorText {
                Label(errorText, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            actions
        }
        .padding(26)
        .frame(width: 660)
        .task { await watch() }
    }

    /* ------------------------------ activity ------------------------------ */

    /// What is fetching now, else how the last fetch ended — a background add that failed says so here.
    @ViewBuilder
    private var activityRow: some View {
        if let running = listing.activity.first {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                HStack(alignment: .top, spacing: 8) {
                    ProgressView().controlSize(.small)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(running.label).font(.system(size: 12, weight: .semibold))
                        Text(runningLine(running, now: context.date))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .truncationMode(.middle)
                    }
                    Spacer(minLength: 0)
                }
            }
            .activityBox()
        } else if listing.running {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(L("Waiting for the fetch before it")).font(.system(size: 12, weight: .semibold))
                Spacer(minLength: 0)
            }
            .activityBox()
        } else if let last = listing.recent.first {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: last.ok == false ? "xmark.circle.fill" : "checkmark.circle.fill")
                    .foregroundStyle(last.ok == false ? Color.red : Color.green)
                VStack(alignment: .leading, spacing: 2) {
                    Text(last.label).font(.system(size: 12))
                    Text([last.detail, ServiceTime.ago(last.finishedAt)].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .activityBox()
        }
    }

    private func runningLine(_ item: TasksSnapshot.ActivityItem, now: Date) -> String {
        let started = ServiceTime.date(item.startedAt) ?? now
        let span = L("running for %@", ServiceTime.span(now.timeIntervalSince(started)))
        return [span, item.progress].compactMap { $0 }.joined(separator: " · ")
    }

    /* ------------------------------ the list ------------------------------ */

    @ViewBuilder
    private var entriesList: some View {
        if !loaded {
            Text(L("Reading the repositories…")).font(.caption).foregroundStyle(.secondary)
        } else if listing.codebases.isEmpty {
            Text(model.maySaveSettings ? L("No repository is kept in this workspace yet. Add one below.") : L("No repository is kept in this workspace yet."))
                .font(.caption)
                .foregroundStyle(.secondary)
        } else {
            ScrollView {
                VStack(spacing: 6) {
                    ForEach(listing.codebases) { entry in row(entry) }
                }
            }
            .frame(maxHeight: 250)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func row(_ entry: CodebaseEntry) -> some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: entry.follow ? "arrow.triangle.2.circlepath" : "chevron.left.forwardslash.chevron.right")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(entry.follow ? Color.knodeCyan : Color.secondary)
                .frame(width: 16)
                .padding(.top, 2)
                .help(entry.follow ? L("followed: fetched again daily") : L("kept at its commit"))
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Button(entry.name) { openCard(entry.card) }
                        .buttonStyle(.link)
                        .font(.system(size: 13, weight: .semibold))
                        .help(L("Open its card, %@", entry.card))
                    if let web = entry.web, let url = URL(string: web) {
                        Link(destination: url) {
                            Text(web.replacingOccurrences(of: "https://", with: "") + " ↗")
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    } else {
                        Text(entry.url)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                Text(commitLine(entry))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                Text(followLine(entry))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if removing == entry.name { removeConfirmation(entry) }
            }
            Spacer(minLength: 0)
            if model.mayUseFiles && removing != entry.name {
                HStack(spacing: 6) {
                    Button(L("Update now")) { Task { await update(entry.name) } }
                        .help(L("Fetch %@ again and index what changed", entry.ref ?? L("its default branch")))
                    Button(L("Edit")) { beginEdit(entry) }
                        .help(L("Change the branch, the globs, following or the documentation copy"))
                    Button(L("Remove…")) {
                        keepFiles = false
                        removing = entry.name
                    }
                    .foregroundStyle(.red)
                }
                .controlSize(.small)
                .disabled(busy)
            }
        }
        .padding(9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(editing == entry.name ? Color.knodeCyan : Color.primary.opacity(0.08), lineWidth: 1)
        )
    }

    private func commitLine(_ entry: CodebaseEntry) -> String {
        let ref = entry.ref ?? L("default branch")
        var commit = L("not fetched yet")
        if let sha = entry.commit {
            commit = String(sha.prefix(12))
            if let date = ServiceTime.date(entry.committedAt) {
                commit = L("%@ of %@", commit, date.formatted(date: .abbreviated, time: .omitted))
            }
        }
        let files = entry.files == 1 ? L("1 file") : L("%@ files", entry.files.formatted())
        let bytes = ByteCountFormatter.string(fromByteCount: Int64(entry.bytes), countStyle: .file)
        return "\(ref) · \(commit) · \(files), \(bytes)"
    }

    private func followLine(_ entry: CodebaseEntry) -> String {
        var parts = [entry.follow ? L("followed — fetched again daily") : L("not followed")]
        if entry.checkedAt != nil { parts.append(L("checked %@", ServiceTime.ago(entry.checkedAt))) }
        if !entry.include.isEmpty { parts.append(L("only %@", entry.include.joined(separator: ", "))) }
        if !entry.exclude.isEmpty { parts.append(L("without %@", entry.exclude.joined(separator: ", "))) }
        if !entry.docs { parts.append(L("documentation not copied")) }
        return parts.joined(separator: " · ")
    }

    private func removeConfirmation(_ entry: CodebaseEntry) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Divider().padding(.vertical, 3)
            Text(L("Remove %@?", entry.name)).font(.system(size: 12, weight: .semibold))
            Toggle(L("Keep its files, card and documentation as plain workspace content"), isOn: $keepFiles)
                .font(.caption)
            Text(keepFiles
                ? L("It stops being a repository here: %@, its card and documentation stay as ordinary files and are no longer updated.", entry.dir)
                : L("Its files in %@, its card and documentation copy are deleted and their knowledge disposed (history stays in the ledger). The repository itself is not touched.", entry.dir))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button(L("Cancel")) { removing = nil }
                Button(L("Remove"), role: .destructive) { Task { await remove(entry.name, keepFiles: keepFiles) } }
                    .tint(.red)
                    .buttonStyle(.borderedProminent)
                    .disabled(busy)
            }
            .controlSize(.small)
        }
    }

    /* ------------------------------ the form ------------------------------ */

    private var form: some View {
        VStack(alignment: .leading, spacing: 9) {
            Eyebrow(text: editing.map { L("Edit %@", $0) } ?? L("Add a repository"), color: Color.secondary)
            field(L("Repository — owner/repo on GitHub, or an https or ssh git URL")) {
                TextField("openai/codex · https://gitlab.com/group/project.git", text: $repository)
                    .disabled(editing != nil)
            }
            HStack(alignment: .top, spacing: 12) {
                field(L("Name in raw/codebase")) {
                    TextField(L("the repository's own"), text: $name)
                        .disabled(editing != nil)
                }
                field(L("Branch, tag or commit")) {
                    TextField(L("its default branch"), text: $ref)
                }
            }
            HStack(alignment: .top, spacing: 12) {
                field(L("Only files matching")) {
                    TextField("src/**, docs/**", text: $include, axis: .vertical)
                        .lineLimit(2...4)
                }
                field(L("Leave out, besides the built-in rules")) {
                    TextField("**/*.test.ts, examples", text: $exclude, axis: .vertical)
                        .lineLimit(2...4)
                }
            }
            Text(L("Globs as in .gitignore, one per line or comma-separated. A repository over 25,000 files or 300 MB is refused — narrow it here."))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Toggle(L("Follow — fetch it again every day and index what changed"), isOn: $follow)
            Toggle(L("Copy its documentation (README, docs/…) to raw/docs/codebase/<name>/, where extraction and summaries read it"), isOn: $docs)
        }
        .textFieldStyle(.roundedBorder)
        .font(.system(size: 12))
        .padding(12)
        .background(Color.primary.opacity(0.03), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.primary.opacity(0.08)))
    }

    private func field<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.system(size: 11, weight: .semibold))
            content().font(.system(size: 12, design: .monospaced))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var actions: some View {
        HStack {
            if editing != nil {
                Button(L("Cancel edit")) { endEdit() }
            }
            Spacer()
            Button(L("Close")) { close() }
                .keyboardShortcut(.cancelAction)
            if editing != nil || model.maySaveSettings {
                Button(editing != nil ? L("Save") : busy ? L("Adding…") : L("Add repository")) {
                    Task { await submit() }
                }
                .buttonStyle(.borderedProminent)
                .tint(.knodeCyan)
                .keyboardShortcut(.defaultAction)
                .disabled(busy || (editing == nil && repository.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
            }
        }
    }

    /* ------------------------------- actions ------------------------------ */

    /// Read the list now and again while the sheet is open: often while something fetches.
    private func watch() async {
        await load()
        if let initialEdit, let entry = listing.codebases.first(where: { $0.name == initialEdit }) { beginEdit(entry) }
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: listing.running ? 2_500_000_000 : 15_000_000_000)
            if Task.isCancelled { break }
            await load()
        }
    }

    private func load() async {
        do {
            let next = try await model.client().codebases()
            let ended = wasRunning && !next.running
            listing = next
            loaded = true
            wasRunning = next.running
            if ended { await fetchEnded() }
        } catch {
            loaded = true
            if let api = error as? APIError, api.sessionEnded { model.showError(error) }
            errorText = error.localizedDescription
        }
    }

    /// A fetch the sheet watched has ended: the tree and the counts change with it, and a failure is said.
    private func fetchEnded() async {
        if let last = listing.recent.first {
            if last.ok == false {
                errorText = "\(last.label): \(last.detail ?? L("failed"))"
            } else {
                model.showToast([last.label, last.detail].compactMap { $0 }.joined(separator: " — "), duration: 6_000_000_000)
            }
        }
        await changed()
    }

    private static func globs(_ text: String) -> [String] {
        var seen = Set<String>()
        return text.split(whereSeparator: { $0 == "\n" || $0 == "," })
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    private func resetForm() {
        repository = ""
        name = ""
        ref = ""
        include = ""
        exclude = ""
        follow = false
        docs = true
    }

    private func beginEdit(_ entry: CodebaseEntry) {
        editing = entry.name
        removing = nil
        errorText = nil
        repository = entry.web ?? entry.url
        name = entry.name
        ref = entry.ref ?? ""
        include = entry.include.joined(separator: "\n")
        exclude = entry.exclude.joined(separator: "\n")
        follow = entry.follow
        docs = entry.docs
    }

    private func endEdit() {
        editing = nil
        resetForm()
    }

    private func submit() async {
        guard !busy else { return }
        errorText = nil
        if let editing { return await save(editing) }
        let trimmed = repository.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let named = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let tracked = ref.trimmingCharacters(in: .whitespacesAndNewlines)
        busy = true
        defer { busy = false }
        do {
            _ = try await model.client().addCodebase(CodebaseDraft(
                repository: trimmed,
                name: named.isEmpty ? nil : named,
                ref: tracked.isEmpty ? nil : tracked,
                include: Self.globs(include),
                exclude: Self.globs(exclude),
                follow: follow,
                docs: docs
            ))
            resetForm()
            wasRunning = true
            model.showToast(L("Fetching %@ — it shows here and under Tasks → Background until it is indexed", trimmed), duration: 6_000_000_000)
        } catch {
            errorText = error.localizedDescription
        }
        await load()
    }

    private func save(_ entryName: String) async {
        guard let before = listing.codebases.first(where: { $0.name == entryName }) else { return endEdit() }
        let patch = CodebasePatch(
            name: entryName,
            ref: ref.trimmingCharacters(in: .whitespacesAndNewlines),
            include: Self.globs(include),
            exclude: Self.globs(exclude),
            follow: follow,
            docs: docs
        )
        // what is fetched changed: only an update applies it, so one follows the save
        let refetch = patch.ref != (before.ref ?? "") || patch.include != before.include || patch.exclude != before.exclude || patch.docs != before.docs
        busy = true
        defer { busy = false }
        do {
            _ = try await model.client().editCodebase(patch)
            endEdit()
            if refetch {
                _ = try await model.client().updateCodebase(name: entryName)
                wasRunning = true
                model.showToast(L("Saved %@ — fetching it again to apply the change", entryName), duration: 5_000_000_000)
            } else {
                model.showToast(L("Saved %@", entryName))
            }
        } catch {
            errorText = error.localizedDescription
        }
        await load()
    }

    private func update(_ entryName: String) async {
        errorText = nil
        do {
            _ = try await model.client().updateCodebase(name: entryName)
            wasRunning = true
            model.showToast(L("Fetching %@ again — it shows under Tasks → Background", entryName), duration: 5_000_000_000)
        } catch {
            errorText = error.localizedDescription
        }
        await load()
    }

    private func remove(_ entryName: String, keepFiles: Bool) async {
        busy = true
        errorText = nil
        defer { busy = false }
        do {
            _ = try await model.client().removeCodebase(name: entryName, keepFiles: keepFiles)
            removing = nil
            if editing == entryName { endEdit() }
            model.showToast(keepFiles ? L("Removed %@ — its files stay as ordinary content", entryName) : L("Removed %@ and its files", entryName), duration: 5_000_000_000)
            await changed()
        } catch {
            errorText = error.localizedDescription
        }
        await load()
    }
}

private extension View {
    /// The box the running or last fetch sits in, above the list.
    func activityBox() -> some View {
        padding(9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.primary.opacity(0.08)))
    }
}
