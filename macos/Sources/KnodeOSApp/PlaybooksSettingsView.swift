import SwiftUI

/// Settings · Playbooks: playbooks/, which the file tree leaves out — the
/// templates, prompts and vocabularies knode-os and its agents work from.
/// Each group says what it is for; a file opens in a plain editor that saves
/// through the service's checks (YAML that parses, a research template's
/// frontmatter) and can go back to the version knode-os ships. Agents and
/// research profiles have pages of their own, so their groups only point there.
struct PlaybooksSettingsSection: View {
    @EnvironmentObject private var model: AppModel
    /// Owned by SettingsView, so a draft outlives a switch to another settings tab.
    @ObservedObject var editor: PlaybooksEditor
    @State private var showingReset = false
    /// Where to go once unsaved edits are discarded: a file, or a group.
    @State private var pendingSwitch: PlaybooksEditor.Target?

    private var groups: [PlaybookGroup] { editor.groups }
    private var selectedGroupID: String { editor.selectedGroupID }
    private var selectedFile: PlaybookFile? { editor.selectedFile }
    private var selectedGroup: PlaybookGroup? { editor.selectedGroup }
    private var isWorking: Bool { editor.isWorking }
    private var saveError: String? { editor.saveError }

    /// The page that edits the open file instead, if any: the group's say first, then the file's.
    private var owner: String? { selectedGroup?.managedIn ?? selectedFile?.managedIn }

    private var mayEdit: Bool {
        guard let file = selectedFile else { return false }
        return model.maySaveSettings && !file.readonly && owner == nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 3) {
                Text(L("Playbooks")).font(.title3.bold())
                Text(L("The templates, prompts and vocabularies knode-os and its agents work from: the files under playbooks/, which the file tree leaves out."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if editor.isLoading && groups.isEmpty {
                ProgressView(L("Loading playbooks…"))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 60)
            } else if groups.isEmpty {
                EmptyState(symbol: "doc.badge.gearshape", title: L("Playbooks unavailable"), message: L("The service did not list this workspace's playbooks."), actionTitle: L("Retry"), action: { Task { await editor.load(model) } })
            } else {
                HStack(alignment: .top, spacing: 16) {
                    groupList
                        .frame(width: 230)
                    groupDetail
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                }
            }
        }
        .task { await editor.load(model) }
        .confirmationDialog(
            L("Discard unsaved changes to %@?", selectedFile?.name ?? ""),
            isPresented: Binding(get: { pendingSwitch != nil }, set: { if !$0 { pendingSwitch = nil } }),
            titleVisibility: .visible
        ) {
            Button(L("Discard and switch"), role: .destructive) {
                guard let target = pendingSwitch else { return }
                pendingSwitch = nil
                editor.revert()
                Task { await editor.go(to: target, model) }
            }
            Button(L("Keep editing"), role: .cancel) { pendingSwitch = nil }
        }
        .confirmationDialog(
            L("Reset %@ to the built-in version?", selectedFile?.name ?? ""),
            isPresented: $showingReset,
            titleVisibility: .visible
        ) {
            Button(L("Reset"), role: .destructive) { Task { await editor.reset(model) } }
            Button(L("Cancel"), role: .cancel) {}
        } message: {
            Text(L("The version knode-os ships replaces your edits to this file."))
        }
    }

    // MARK: - Groups

    private var groupList: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(groups) { group in
                let selected = group.id == selectedGroupID
                Button {
                    request(.group(group.id))
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(Self.title(group.id))
                                .font(.callout.weight(selected ? .semibold : .regular))
                            Spacer(minLength: 4)
                            if group.managedIn != nil {
                                Image(systemName: "arrow.up.right.square")
                                    .font(.system(size: 10))
                                    .foregroundStyle(.tertiary)
                            } else {
                                Text(String(group.files.count))
                                    .font(.system(size: 10, design: .monospaced))
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        Text(Self.explanation(group.id))
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(selected ? Color.knodeCyan.opacity(0.14) : Color.clear, in: RoundedRectangle(cornerRadius: 8))
                    .overlay {
                        RoundedRectangle(cornerRadius: 8)
                            .stroke(selected ? Color.knodeCyan.opacity(0.45) : Color.clear)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(Self.explanation(group.id))
            }
        }
        .knodeCard(padding: 8)
    }

    @ViewBuilder
    private var groupDetail: some View {
        if let group = selectedGroup {
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(Self.title(group.id)).font(.headline)
                        Text("\(group.dir)/")
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(.tertiary)
                            .textSelection(.enabled)
                    }
                    Text(Self.explanation(group.id))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let managedIn = group.managedIn {
                    ownerPointer(managedIn)
                } else if group.files.isEmpty {
                    Text(L("Nothing here yet."))
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 8)
                } else {
                    HStack(alignment: .top, spacing: 12) {
                        fileList(group)
                            .frame(width: 200)
                        editorPane
                            .frame(maxWidth: .infinity, alignment: .topLeading)
                    }
                }
            }
        }
    }

    /// Where a group or file is edited instead of here.
    @ViewBuilder
    private func ownerPointer(_ managedIn: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "arrow.up.right.square")
                .foregroundStyle(Color.knodeCyan)
            Text(Self.ownerLine(managedIn))
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            switch managedIn {
            case "providers":
                Button(L("Open Providers & Agents")) { model.select(.providers) }
            case "research":
                Button(L("Open Research settings")) { model.select(.research) }
            default:
                EmptyView()
            }
        }
        .knodeCard(padding: 14)
    }

    // MARK: - Files

    private func fileList(_ group: PlaybookGroup) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(group.files) { file in
                let selected = file.path == selectedFile?.path
                Button {
                    request(.file(file))
                } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(file.name)
                            .font(.system(size: 11.5, design: .monospaced))
                            .lineLimit(1)
                            .truncationMode(.middle)
                        HStack(spacing: 4) {
                            badges(file)
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(selected ? Color.knodeCyan.opacity(0.14) : Color.clear, in: RoundedRectangle(cornerRadius: 6))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(file.path)
            }
        }
    }

    @ViewBuilder
    private func badges(_ file: PlaybookFile) -> some View {
        if file.readonly {
            RouteBadge(label: L("generated"), color: .secondary)
        } else if file.modified {
            RouteBadge(label: L("edited"), color: .orange)
        } else if file.builtin {
            RouteBadge(label: L("built-in"), color: .knodeCyan)
        }
    }

    // MARK: - Editor

    @ViewBuilder
    private var editorPane: some View {
        if let file = selectedFile {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Text(file.path)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.head)
                        .textSelection(.enabled)
                    Spacer(minLength: 8)
                    if isWorking { ProgressView().controlSize(.small) }
                    if mayEdit {
                        Button(L("Revert")) { editor.revert() }
                        .disabled(!editor.isDirty || isWorking)
                        .help(L("Back to the text as it was last saved"))
                        if file.builtin && file.modified {
                            Button(L("Reset to built-in")) { showingReset = true }
                                .disabled(isWorking)
                        }
                        Button(L("Save")) { Task { await editor.save(model) } }
                            .buttonStyle(.borderedProminent)
                            .tint(.knodeCyan)
                            .disabled(!editor.isDirty || isWorking)
                    }
                }
                .controlSize(.small)
                if let reason = readOnlyReason(file) {
                    Label(reason, systemImage: "lock")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                // a constant binding keeps a read-only file selectable and scrollable without letting a key change it
                TextEditor(text: mayEdit ? $editor.draft : .constant(editor.draft))
                    .font(.system(size: 11.5, design: .monospaced))
                    .scrollContentBackground(.hidden)
                    .padding(6)
                    .frame(minHeight: 440)
                    .background(Color(nsColor: .textBackgroundColor).opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
                    .overlay { RoundedRectangle(cornerRadius: 8).stroke(Color.white.opacity(0.08)) }
                    .onChange(of: editor.draft) { _, _ in
                        if editor.saveError != nil { editor.saveError = nil }
                    }
                if let saveError {
                    Label(saveError, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(Color.knodeBad)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text(L("A playbook stays in the language it is written in — it is what knode-os and its agents actually read."))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        } else {
            Text(L("Pick a file to read or edit it."))
                .font(.callout)
                .foregroundStyle(.secondary)
                .padding(.vertical, 8)
        }
    }

    private func readOnlyReason(_ file: PlaybookFile) -> String? {
        if let owner { return Self.ownerLine(owner) }
        if file.readonly { return L("knode-os regenerates this file, so edits would not last.") }
        if !model.maySaveSettings { return L("Read-only: settings are an administrator's") }
        return nil
    }

    /// Switch files or groups, asking first when the open file has unsaved edits.
    private func request(_ target: PlaybooksEditor.Target) {
        if case .file(let file) = target, file.path == selectedFile?.path { return }
        if case .group(let id) = target, id == selectedGroupID { return }
        if editor.isDirty {
            pendingSwitch = target
        } else {
            Task { await editor.go(to: target, model) }
        }
    }

    // MARK: - Words

    static func title(_ group: String) -> String {
        switch group {
        case "research": L("Research templates")
        case "phases": L("Research phases")
        case "packs": L("Context packs")
        case "intents": L("Intents")
        case "ontology": L("Ontology")
        case "concepts": L("Concept stop list")
        case "capabilities": L("Capability notes")
        case "chat": L("Ask prompts")
        case "agents": L("Agents")
        case "profiles": L("Research profiles")
        case "sources": L("Research sources")
        default: group
        }
    }

    static func explanation(_ group: String) -> String {
        switch group {
        case "research": L("What a research agent is told for each kind of page, and AGENTS.md, the protocol every research job shares.")
        case "phases": L("The prompt for each step of a research run: plan, collect, research, synthesize, review, revise.")
        case "packs": L("How knode gathers context for a question. The nightly review can revise them from what worked.")
        case "intents": L("What an answer to each kind of question needs before it is worth giving.")
        case "ontology": L("The entity and relation types the knowledge graph uses.")
        case "concepts": L("Words never mined as concepts. frequent.yaml is learned from your documents and regenerated.")
        case "capabilities": L("Notes on live datasources: metric definitions, joins, pitfalls.")
        case "chat": L("How Ask behaves (AGENTS.md, its protocol) and the prompt it sends each turn (turn.md).")
        case "agents": ownerLine("providers")
        case "profiles": ownerLine("research")
        case "sources": ownerLine("sources")
        default: ""
        }
    }

    /// Where a group or file is edited instead: a page of this app, or of the web app for sources.
    static func ownerLine(_ managedIn: String) -> String {
        switch managedIn {
        case "providers": L("Edited in Settings → Providers & Agents.")
        case "research": L("Edited in Settings → Research.")
        case "sources": L("Edited on the Research → Sources page of the web app.")
        default: L("Edited on another settings page.")
        }
    }
}

/// What the Playbooks section shows and edits: the groups, the open file, and
/// the draft of it. Kept by SettingsView rather than by the section, which is
/// rebuilt on every settings tab switch.
@MainActor
final class PlaybooksEditor: ObservableObject {
    enum Target: Equatable {
        case file(PlaybookFile)
        case group(String)
    }

    @Published var groups: [PlaybookGroup] = []
    @Published var selectedGroupID = "research"
    @Published var selectedFile: PlaybookFile?
    /// The file as the service last returned it, and the editor's draft of it.
    @Published var savedText = ""
    @Published var draft = ""
    @Published var isLoading = false
    @Published var isWorking = false
    /// Why the last save was refused, shown under the editor until the next edit.
    @Published var saveError: String?

    var selectedGroup: PlaybookGroup? { groups.first { $0.id == selectedGroupID } }
    var isDirty: Bool { selectedFile != nil && draft != savedText }

    /// List the groups again, keeping the open file and its draft.
    func load(_ model: AppModel) async {
        isLoading = true
        defer { isLoading = false }
        do {
            groups = try await model.client().playbooks().groups
            if selectedGroup == nil, let first = groups.first { selectedGroupID = first.id }
            if selectedFile == nil, let group = selectedGroup, group.managedIn == nil, let first = group.files.first {
                await open(first, model)
            }
        } catch {
            model.showError(error, prefix: L("Playbooks unavailable"))
        }
    }

    func go(to target: Target, _ model: AppModel) async {
        switch target {
        case .file(let file):
            await open(file, model)
        case .group(let id):
            selectedGroupID = id
            selectedFile = nil
            savedText = ""
            draft = ""
            saveError = nil
            if let group = selectedGroup, group.managedIn == nil, let first = group.files.first {
                await open(first, model)
            }
        }
    }

    func revert() {
        draft = savedText
        saveError = nil
    }

    func save(_ model: AppModel) async {
        guard let file = selectedFile else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            apply(try await model.client().savePlaybook(path: file.path, text: draft))
            model.showToast(L("Saved %@", file.path))
        } catch {
            // the service says why — YAML that does not parse, a template without its kind — so it stays on screen
            saveError = error.localizedDescription
        }
    }

    func reset(_ model: AppModel) async {
        guard let file = selectedFile else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            apply(try await model.client().resetPlaybook(path: file.path))
            model.showToast(L("%@ is the built-in version again", file.name))
        } catch {
            model.showError(error, prefix: L("Reset failed"))
        }
    }

    private func open(_ file: PlaybookFile, _ model: AppModel) async {
        isWorking = true
        defer { isWorking = false }
        do {
            apply(try await model.client().playbook(at: file.path))
        } catch {
            model.showError(error, prefix: L("Open failed"))
        }
    }

    /// Show what the service returned, and keep the file's row in its group in step (its badges).
    private func apply(_ loaded: PlaybookText) {
        selectedFile = loaded.file
        savedText = loaded.text
        draft = loaded.text
        saveError = nil
        if let g = groups.firstIndex(where: { $0.id == selectedGroupID }),
           let f = groups[g].files.firstIndex(where: { $0.path == loaded.file.path }) {
            groups[g].files[f] = loaded.file
        }
    }
}
