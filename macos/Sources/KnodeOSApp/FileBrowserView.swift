import SwiftUI
import UniformTypeIdentifiers

struct FileBrowserView: View {
    /// Mirrors MAX_PREVIEW_BYTES in the service — only used to word the notice.
    static let previewByteCap = 256 * 1024

    /// Mirrors MAX_FILE_BYTES: the largest read the service will serve, and so
    /// the largest file "Load full file" can make editable.
    static let editByteCap = 4 * 1024 * 1024

    /// One presentation slot: stacking `.sheet` modifiers on a single view is
    /// unreliable, so every editor shares this one.
    private enum ActiveSheet: Identifiable {
        case newFile
        case newFolder
        case rename(String)
        case destination(DestinationPurpose)

        var id: String {
            switch self {
            case .newFile: "newFile"
            case .newFolder: "newFolder"
            case .rename(let path): "rename-\(path)"
            case .destination(let purpose): "destination-\(purpose.id)"
            }
        }
    }

    private enum ImportKind {
        case files
        case folder
    }

    /// What the destination picker is about to do with the folder it asks for.
    private enum DestinationPurpose: Identifiable, Equatable {
        case upload(ImportKind)
        /// Every file ticked in selection mode.
        case moveChecked
        /// One file or folder, from its context menu.
        case moveNode(String)

        var id: String {
            switch self {
            case .upload(.files): "upload-files"
            case .upload(.folder): "upload-folder"
            case .moveChecked: "move-checked"
            case .moveNode(let path): "move-\(path)"
            }
        }

        var isMove: Bool {
            if case .upload = self { return false }
            return true
        }
    }

    /// A delete waiting on its confirmation alert. A folder carries the count
    /// of what goes with it, because that is the part worth confirming.
    private struct DeleteTarget: Identifiable, Equatable {
        let path: String
        let isDirectory: Bool
        let fileCount: Int

        var id: String { path }
    }

    /// How many files and bytes go into one upload request: a folder can hold
    /// thousands of files and the whole multipart body is built in memory.
    private static let uploadBatchFileLimit = 40
    private static let uploadBatchByteLimit = 24 * 1024 * 1024

    @EnvironmentObject private var model: AppModel
    @State private var tree: TreeNode?
    @State private var selectedPath: String?
    @State private var content = ""
    @State private var editorContent = ""
    @State private var isEditing = false
    @State private var isLoading = true
    @State private var isWorking = false
    @State private var showingImporter = false
    @State private var showingFolderImporter = false
    @State private var showingBatchDelete = false
    @State private var deleteTarget: DeleteTarget?
    @State private var activeSheet: ActiveSheet?
    @State private var newFilePath = "wiki/concepts/new-note.md"
    @State private var newFolderPath = "wiki/concepts/new-folder"
    /// The new name a rename sheet is editing; the old path rides on the sheet.
    @State private var renameName = ""
    /// Where the next import lands. A directory's context menu sets it
    /// directly; the toolbar asks for it in the destination picker first.
    @State private var importDestination = "raw/docs"
    /// What the destination picker is editing, and the importer it still owes
    /// once its sheet has closed — presenting a `.fileImporter` while a sheet
    /// is on screen drops it silently.
    @State private var destinationPath = "raw/docs"
    @State private var pendingImport: ImportKind?
    @State private var expandedPaths: Set<String> = ["wiki"]
    /// The folder clicked in the tree. New files, new folders and uploads
    /// default into it until another row is clicked.
    @State private var selectedDirectory: String?
    @State private var isTruncated = false
    /// The open text is Markdown knode-os derived from a PDF or image. Saving it
    /// would write that Markdown over the original's bytes, so editing stays shut.
    @State private var isDerived = false
    @State private var fileBytes: Int?
    @State private var selectionMode = false
    @State private var checkedPaths: Set<String> = []

    var body: some View {
        HSplitView {
            treePane
                .frame(minWidth: 230, idealWidth: 280, maxWidth: 380)
            filePane
                .frame(minWidth: 520, maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Color(nsColor: .textBackgroundColor).opacity(0.25))
        .task { await initialLoad() }
        .onChange(of: model.connectionState) { _, state in
            if case .connected = state, tree == nil {
                Task { await initialLoad() }
            }
        }
        .fileImporter(isPresented: $showingImporter, allowedContentTypes: [.data], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            Task { await importURLs(urls, into: importDestination) }
        }
        .sheet(item: $activeSheet, onDismiss: presentPendingImport) { sheet in
            switch sheet {
            case .newFile: newFileSheet
            case .newFolder: newFolderSheet
            case .rename(let path): renameSheet(path)
            case .destination(let purpose): destinationSheet(purpose)
            }
        }
        .alert(
            deleteTarget?.isDirectory == true ? "Delete folder?" : "Delete file?",
            isPresented: Binding(get: { deleteTarget != nil }, set: { if !$0 { deleteTarget = nil } }),
            presenting: deleteTarget
        ) { target in
            Button("Cancel", role: .cancel) {}
            Button("Delete", role: .destructive) { Task { await delete(target) } }
        } message: { target in
            Text(deleteMessage(target))
        }
        .alert("Delete \(checkedPaths.count) files?", isPresented: $showingBatchDelete) {
            Button("Cancel", role: .cancel) {}
            Button("Delete", role: .destructive) { Task { await batchDelete() } }
        } message: {
            Text("This removes the selected files from the current workspace. The knowledge extracted from them is disposed; history stays queryable.")
        }
    }

    private var defaultToolbar: some View {
        HStack(spacing: 6) {
            Button { Task { await loadTree() } } label: { Image(systemName: "arrow.clockwise") }
                .help("Refresh — reread the workspace tree from disk")
                .accessibilityLabel("Refresh files")
            // creating and uploading are the same intent — "put something in
            // this folder" — so they share one menu instead of two buttons
            Menu {
                Button { beginNewFile(in: targetDirectory) } label: { Label("New file…", systemImage: "doc.badge.plus") }
                Button { beginNewFolder(in: targetDirectory) } label: { Label("New folder…", systemImage: "folder.badge.plus") }
                Divider()
                Button { askDestination(for: .upload(.files)) } label: { Label("Upload files…", systemImage: "arrow.up.doc") }
                Button { askDestination(for: .upload(.folder)) } label: { Label("Upload folder…", systemImage: "arrow.up.folder") }
            } label: {
                Image(systemName: "plus")
            }
            .menuStyle(.button)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Add — a new file or folder, or documents uploaded from disk, into \(targetDirectory)/")
            .accessibilityLabel("Add a file or folder")
            Button { selectionMode = true } label: { Image(systemName: "checklist") }
                .help("Select — tick several files to move or delete them in one go")
                .accessibilityLabel("Select multiple files")
            Spacer(minLength: 4)
            Button { Task { await ingest() } } label: {
                if isWorking { ProgressView().controlSize(.small) }
                else { Label("Index", systemImage: "arrow.triangle.2.circlepath") }
            }
            .disabled(isWorking)
            .fixedSize()
            .help("Index — turn new and changed files into knowledge: chunk, embed, extract entities and refresh the wiki. The CLI calls this `ingest` / `sync`.")
        }
    }

    /// A one-line reminder of where a create or an upload lands, so "new file"
    /// never quietly goes somewhere else than the folder the user clicked.
    private var destinationBar: some View {
        HStack(spacing: 5) {
            Image(systemName: "folder.fill")
                .foregroundStyle(Color.knodeViolet)
            Text("New items →")
            Text(targetDirectory.isEmpty ? "workspace root" : "\(targetDirectory)/")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(.primary)
                .lineLimit(1)
                .truncationMode(.head)
            if !isWritable(targetDirectory) {
                Text("read-only")
                    .padding(.horizontal, 4)
                    .padding(.vertical, 1)
                    .background(Color.orange.opacity(0.18), in: Capsule())
                    .foregroundStyle(.orange)
            }
            Spacer(minLength: 0)
            if selectedDirectory != nil {
                Button { selectedDirectory = nil } label: { Image(systemName: "xmark.circle.fill") }
                    .buttonStyle(.plain)
                    .help("Clear the picked folder — new items follow the open file again")
            }
        }
        .font(.system(size: 10))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 12)
        .padding(.bottom, 9)
        .help("Click a folder in the tree to send new files, new folders and uploads there")
    }

    private var selectionToolbar: some View {
        HStack(spacing: 7) {
            Text("\(checkedPaths.count) selected")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
            if isWorking { ProgressView().controlSize(.small) }
            Spacer()
            Button { askDestination(for: .moveChecked) } label: {
                Label("Move", systemImage: "folder")
            }
            .disabled(checkedPaths.isEmpty || isWorking)
            .help("Move every selected file into another folder")
            Button(role: .destructive) { showingBatchDelete = true } label: {
                Label("Delete", systemImage: "trash")
            }
            .disabled(checkedPaths.isEmpty || isWorking)
            .help("Delete every selected file")
            Button("Done") {
                selectionMode = false
                checkedPaths.removeAll()
            }
            .disabled(isWorking)
        }
        .labelStyle(.iconOnly)
    }

    private var treePane: some View {
        VStack(spacing: 0) {
            Group {
                if selectionMode { selectionToolbar } else { defaultToolbar }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .padding(.horizontal, 10)
            .padding(.top, 10)
            .padding(.bottom, selectionMode ? 10 : 7)

            if !selectionMode { destinationBar }

            Divider()
            if isLoading && tree == nil {
                ProgressView("Loading files…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let children = tree?.children {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        ForEach(children) { node in
                            FileTreeNodeView(
                                node: node,
                                selectedPath: selectedPath,
                                selectedDirectory: selectedDirectory,
                                selectionMode: selectionMode,
                                checkedPaths: $checkedPaths,
                                expandedPaths: $expandedPaths,
                                openFile: { path in Task { await openFile(path) } },
                                selectDirectory: { selectedDirectory = $0 },
                                perform: perform
                            )
                        }
                    }
                    .padding(.horizontal, 6)
                    .padding(.vertical, 7)
                }
                .dropDestination(for: URL.self) { urls, _ in
                    Task { await importURLs(urls, into: uploadTarget) }
                    return !urls.isEmpty
                } isTargeted: { targeted in
                    if targeted { model.showToast("Drop files or folders to upload into \(uploadTarget)") }
                }
            } else {
                EmptyState(symbol: "folder", title: "No files", message: "Connect to the local service or initialize a workspace.")
            }
        }
        .background(.ultraThinMaterial)
        // attached here rather than next to the file importer: two
        // `.fileImporter` modifiers on one view shadow each other
        .fileImporter(isPresented: $showingFolderImporter, allowedContentTypes: [.folder], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            Task { await importURLs(urls, into: importDestination) }
        }
    }

    @ViewBuilder
    private var filePane: some View {
        if let selectedPath {
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Image(systemName: selectedPath.hasSuffix(".md") ? "doc.richtext" : "doc.text")
                        .foregroundStyle(Color.knodeCyan)
                    Text(selectedPath)
                        .font(.system(size: 12, design: .monospaced))
                        .lineLimit(1)
                        .help(selectedPath)
                    Spacer()
                    if isWorking { ProgressView().controlSize(.small) }
                    Button(isEditing ? "Preview" : "Edit") { isEditing.toggle() }
                        .disabled(!isWritable(selectedPath) || isWorking || !isEditable)
                    Button("Save") { Task { await save() } }
                        .buttonStyle(.borderedProminent)
                        .tint(.knodeCyan)
                        .disabled(!isEditing || isWorking || !isEditable)
                    Button(role: .destructive) {
                        deleteTarget = DeleteTarget(path: selectedPath, isDirectory: false, fileCount: 1)
                    } label: {
                        Image(systemName: "trash")
                    }
                    .disabled(!isWritable(selectedPath) || isWorking)
                }
                .controlSize(.small)
                .padding(.horizontal, 14)
                .frame(height: 48)
                .background(.bar)
                Divider()

                if let readOnlyNotice {
                    HStack(spacing: 8) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                        Text(readOnlyNotice)
                            .foregroundStyle(.secondary)
                        Spacer(minLength: 0)
                        if canLoadFullFile {
                            Button("Load full file") { Task { await loadFullFile() } }
                                .controlSize(.small)
                                .disabled(isWorking)
                        }
                    }
                    .font(.system(size: 11))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(Color.orange.opacity(0.11))
                    Divider()
                }

                if isEditing {
                    TextEditor(text: $editorContent)
                        .font(.system(size: 13, design: .monospaced))
                        .scrollContentBackground(.hidden)
                        .padding(14)
                } else {
                    ScrollView {
                        Group {
                            if selectedPath.hasSuffix(".md") || selectedPath.hasSuffix(".markdown") {
                                MarkdownText(markdown: content) { target in
                                    Task { await openKnowledgeLink(target, from: selectedPath) }
                                }
                                    .font(.system(size: 15))
                            } else {
                                PlainTextPreview(text: content)
                            }
                        }
                        .padding(.horizontal, 28)
                        .padding(.vertical, 24)
                        .frame(maxWidth: 940, alignment: .leading)
                        .frame(maxWidth: .infinity, alignment: .center)
                    }
                }
            }
        } else {
            EmptyState(
                symbol: "doc.text.magnifyingglass",
                title: "Select a file",
                message: "Browse the workspace tree, or drag documents and folders onto it to upload and index them."
            )
        }
    }

    private var newFileSheet: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 5) {
                Eyebrow(text: "Workspace file")
                Text("Create a new note").font(.title2.bold())
                Text("Writable paths must live under wiki/ or raw/docs/.")
                    .foregroundStyle(.secondary)
            }
            TextField("wiki/concepts/new-note.md", text: $newFilePath)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 12, design: .monospaced))
            pathNote(newFilePath, noun: "files")
            HStack {
                Spacer()
                Button("Cancel") { activeSheet = nil }
                Button("Create") { Task { await createFile() } }
                    .buttonStyle(.borderedProminent)
                    .tint(.knodeCyan)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!isWritable(newFilePath))
            }
        }
        .padding(26)
        .frame(width: 500)
    }

    private var newFolderSheet: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 5) {
                Eyebrow(text: "Workspace folder")
                Text("Create a new folder").font(.title2.bold())
                Text("Writable paths must live under wiki/ or raw/docs/. Intermediate folders are created too.")
                    .foregroundStyle(.secondary)
            }
            TextField("wiki/concepts/pricing", text: $newFolderPath)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 12, design: .monospaced))
            pathNote(newFolderPath, noun: "folders")
            HStack {
                Spacer()
                Button("Cancel") { activeSheet = nil }
                Button("Create") { Task { await createFolder() } }
                    .buttonStyle(.borderedProminent)
                    .tint(.knodeCyan)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!isWritable(newFolderPath))
            }
        }
        .padding(26)
        .frame(width: 500)
    }

    private func renameSheet(_ path: String) -> some View {
        let isDirectory = node(at: path)?.kind == .dir
        let target = renameTarget(for: path)
        return VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 5) {
                Eyebrow(text: isDirectory ? "Workspace folder" : "Workspace file")
                Text("Rename").font(.title2.bold())
                Text(isDirectory
                     ? "Everything inside the folder moves with it. A path is a document's identity in the graph, so the subtree is re-indexed right after."
                     : "A path is the document's identity in the graph, so the file is re-indexed right after.")
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            TextField("name", text: $renameName)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 12, design: .monospaced))
            Label(target, systemImage: "arrow.turn.down.right")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.head)
            HStack {
                Spacer()
                Button("Cancel") { activeSheet = nil }
                Button("Rename") { Task { await moveSubtree(from: path, to: target) } }
                    .buttonStyle(.borderedProminent)
                    .tint(.knodeCyan)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!isValidRename(of: path))
            }
        }
        .padding(26)
        .frame(width: 460)
    }

    /// Whether a typed path can be created, said in the sheet rather than left
    /// to a disabled button the user has to guess about.
    @ViewBuilder
    private func pathNote(_ path: String, noun: String) -> some View {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        if isWritable(trimmed) {
            let parent = parentDirectory(of: trimmed)
            Label("Lands in \(parent.isEmpty ? "the workspace root" : parent + "/")", systemImage: "arrow.turn.down.right")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
        } else {
            Label("Only wiki/ and raw/docs/ take new \(noun) — edit the path above", systemImage: "exclamationmark.triangle.fill")
                .font(.system(size: 11))
                .foregroundStyle(.orange)
        }
    }

    private var trimmedRenameName: String {
        renameName.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Where a rename would put `path`: the same folder, the new name.
    private func renameTarget(for path: String) -> String {
        let parent = parentDirectory(of: path)
        return parent.isEmpty ? trimmedRenameName : "\(parent)/\(trimmedRenameName)"
    }

    private func isValidRename(of path: String) -> Bool {
        let name = trimmedRenameName
        guard !name.isEmpty, !name.contains("/"), !name.contains("\\"), name != ".", name != ".." else { return false }
        let target = renameTarget(for: path)
        return target != path && isWritable(target)
    }

    private func destinationSheet(_ purpose: DestinationPurpose) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 5) {
                Eyebrow(text: purpose.isMove ? "Move" : "Upload")
                Text(destinationTitle(purpose)).font(.title2.bold())
                Text(destinationHint(purpose))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            TextField("raw/docs", text: $destinationPath)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 12, design: .monospaced))

            VStack(alignment: .leading, spacing: 6) {
                Text("Existing folders")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        ForEach(writableDirectories, id: \.self) { directory in
                            Button { destinationPath = directory } label: {
                                HStack(spacing: 7) {
                                    Image(systemName: "folder.fill")
                                        .foregroundStyle(Color.knodeViolet)
                                        .frame(width: 15)
                                    Text(directory)
                                        .font(.system(size: 11, design: .monospaced))
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                    Spacer(minLength: 0)
                                }
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .contentShape(Rectangle())
                                .background(
                                    directory == trimmedDestination ? Color.knodeCyan.opacity(0.16) : .clear,
                                    in: RoundedRectangle(cornerRadius: 5)
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.vertical, 4)
                }
                .frame(height: 170)
                .background(Color(nsColor: .textBackgroundColor).opacity(0.4), in: RoundedRectangle(cornerRadius: 7))
                .overlay { RoundedRectangle(cornerRadius: 7).stroke(Color.secondary.opacity(0.18)) }
            }

            HStack {
                if !destinationExists && isWritable(trimmedDestination) {
                    Label("Creates \(trimmedDestination)/", systemImage: "folder.badge.plus")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Cancel") { activeSheet = nil }
                Button(purpose.isMove ? "Move" : "Choose…") { confirmDestination(purpose) }
                    .buttonStyle(.borderedProminent)
                    .tint(.knodeCyan)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canConfirm(purpose))
            }
        }
        .padding(26)
        .frame(width: 520)
    }

    private var trimmedDestination: String {
        destinationPath
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\\", with: "/")
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    private var destinationExists: Bool {
        writableDirectories.contains(trimmedDestination)
    }

    /// Every folder an upload or a move may target, newest tree first.
    private var writableDirectories: [String] {
        (tree?.children ?? []).flatMap(\.writableDirectoryPaths)
    }

    private func destinationTitle(_ purpose: DestinationPurpose) -> String {
        switch purpose {
        case .upload(.files): "Upload files to…"
        case .upload(.folder): "Upload a folder to…"
        case .moveChecked: "Move \(checkedPaths.count) file\(checkedPaths.count == 1 ? "" : "s") to…"
        case .moveNode(let path): "Move \(name(of: path)) to…"
        }
    }

    private func destinationHint(_ purpose: DestinationPurpose) -> String {
        switch purpose {
        case .upload(.files):
            "Pick or type the folder the documents land in. Uploads go under raw/docs/ or wiki/; a folder that does not exist yet is created."
        case .upload(.folder):
            "Pick or type the folder the dropped folder's subtree is recreated under. Uploads go under raw/docs/ or wiki/."
        case .moveChecked:
            "A file's path is its identity in the knowledge graph, so moving it re-indexes it — embeddings and extractions are rebuilt on the ingest that follows."
        case .moveNode(let path):
            node(at: path)?.kind == .dir
                ? "The folder and everything in it moves. Every path below it is its document's identity in the graph, so the subtree is re-indexed right after."
                : "A file's path is its identity in the knowledge graph, so moving it re-indexes it right after."
        }
    }

    private func askDestination(for purpose: DestinationPurpose) {
        switch purpose {
        case .upload: destinationPath = uploadTarget
        case .moveChecked: destinationPath = commonParentOfChecked
        case .moveNode(let path):
            let parent = parentDirectory(of: path)
            destinationPath = isWritable(parent) ? parent : "raw/docs"
        }
        activeSheet = .destination(purpose)
    }

    /// Whether the picked folder is somewhere this purpose may actually go.
    private func canConfirm(_ purpose: DestinationPurpose) -> Bool {
        let destination = trimmedDestination
        guard isWritable(destination) else { return false }
        // a folder cannot be moved into itself: rename would fail on the way
        if case .moveNode(let path) = purpose, node(at: path)?.kind == .dir {
            return destination != path && !destination.hasPrefix("\(path)/")
        }
        return true
    }

    private func confirmDestination(_ purpose: DestinationPurpose) {
        let destination = trimmedDestination
        guard canConfirm(purpose) else { return }
        activeSheet = nil
        switch purpose {
        case .upload(let kind):
            importDestination = destination
            pendingImport = kind
        case .moveChecked:
            Task { await batchMove(into: destination) }
        case .moveNode(let path):
            guard destination != parentDirectory(of: path) else {
                model.showToast("\(name(of: path)) is already in \(destination)")
                return
            }
            Task { await moveSubtree(from: path, to: "\(destination)/\(name(of: path))") }
        }
    }

    /// The file importer is opened from `onDismiss`: asking for it while the
    /// destination sheet is still up leaves both off screen.
    private func presentPendingImport() {
        guard let kind = pendingImport else { return }
        pendingImport = nil
        switch kind {
        case .files: showingImporter = true
        case .folder: showingFolderImporter = true
        }
    }

    /// Where a create or an upload goes: the folder last clicked in the tree,
    /// else the folder of the open file, else the wiki root.
    private var targetDirectory: String {
        if let selectedDirectory { return selectedDirectory }
        if let selectedPath {
            let parent = parentDirectory(of: selectedPath)
            if !parent.isEmpty { return parent }
        }
        return "wiki"
    }

    /// The same folder, kept to one an upload may actually land in — a click
    /// on `ledger/` must not silently redirect a drop to a read-only tree.
    private var uploadTarget: String {
        isWritable(targetDirectory) ? targetDirectory : "raw/docs"
    }

    /// Prefill for a move: where the selection already lives, when it shares
    /// one folder — the common case is "these files, one level down".
    private var commonParentOfChecked: String {
        let parents = Set(checkedPaths.map(parentDirectory(of:)))
        guard parents.count == 1, let only = parents.first, isWritable(only) else { return "raw/docs" }
        return only
    }

    private func initialLoad() async {
        await loadTree()
        let requested = model.consumePendingFile()
        await openFile(requested ?? "wiki/index.md")
    }

    private func loadTree() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let loadedTree = try await model.client().tree()
            tree = loadedTree
            let directoryPaths = Set(loadedTree.flattenedDirectoryPaths)
            expandedPaths.formIntersection(directoryPaths)
            if directoryPaths.contains("wiki") { expandedPaths.insert("wiki") }
        } catch {
            model.showError(error, prefix: "Files")
        }
    }

    private func openFile(_ path: String) async {
        isWorking = true
        defer { isWorking = false }
        do {
            let response = try await model.client().file(at: path)
            selectedPath = response.path
            // the create target follows the last thing clicked: a file hands it
            // back to the file's own folder
            selectedDirectory = nil
            content = response.content
            // A capped read must never round-trip through the editor: saving it
            // back would rewrite the file with only the previewed prefix.
            isTruncated = response.truncated ?? false
            isDerived = response.derived ?? false
            fileBytes = response.bytes
            editorContent = isEditable ? response.content : ""
            isEditing = false
        } catch {
            model.showError(error, prefix: "Open failed")
        }
    }

    /// Re-read the open file without the preview cap, so it can be edited.
    /// The editor only ever holds a complete file: that is what makes a save safe.
    private func loadFullFile() async {
        guard let selectedPath else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            let response = try await model.client().file(at: selectedPath, maxBytes: Self.editByteCap)
            let stillCapped = response.truncated ?? false
            content = response.content
            isTruncated = stillCapped
            isDerived = response.derived ?? false
            fileBytes = response.bytes
            editorContent = isEditable ? response.content : ""
            if stillCapped {
                model.showToast("\(selectedPath) is too large to edit here")
            }
        } catch {
            model.showError(error, prefix: "Load failed")
        }
    }

    private func openKnowledgeLink(_ target: String, from sourcePath: String) async {
        do {
            let resolved = try await model.client().resolveLink(target, from: sourcePath)
            expand(parentDirectory(of: resolved.path))
            await openFile(resolved.path)
        } catch {
            model.showError(error, prefix: "Link unavailable")
        }
    }

    private func save() async {
        guard let selectedPath else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            _ = try await model.client().saveFile(path: selectedPath, content: editorContent)
            content = editorContent
            isEditing = false
            model.showToast("Saved \(selectedPath)")
            await loadTree()
        } catch {
            model.showError(error, prefix: "Save failed")
        }
    }

    private func createFile() async {
        let path = newFilePath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty else { return }
        isWorking = true
        do {
            let title = URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent.replacingOccurrences(of: "-", with: " ")
            _ = try await model.client().saveFile(path: path, content: "# \(title)\n\n")
            activeSheet = nil
            await loadTree()
            expand(parentDirectory(of: path))
            await openFile(path)
        } catch {
            isWorking = false
            model.showError(error, prefix: "Create failed")
        }
    }

    private func createFolder() async {
        let path = newFolderPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isWritable(path) else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            _ = try await model.client().createDirectory(path: path)
            activeSheet = nil
            await loadTree()
            expand(path)
            model.showToast("Created \(path)/")
        } catch {
            model.showError(error, prefix: "Create folder failed")
        }
    }

    private func beginNewFile(in directory: String) {
        let folder = directory.isEmpty ? "wiki" : directory
        newFilePath = "\(folder)/\(freeName(in: folder, base: "new-note", ext: ".md"))"
        activeSheet = .newFile
    }

    private func beginNewFolder(in directory: String) {
        let folder = directory.isEmpty ? "wiki" : directory
        newFolderPath = "\(folder)/\(freeName(in: folder, base: "new-folder"))"
        activeSheet = .newFolder
    }

    private func beginRename(_ path: String) {
        renameName = name(of: path)
        activeSheet = .rename(path)
    }

    private func beginImport(_ kind: ImportKind, into destination: String) {
        importDestination = destination
        switch kind {
        case .files: showingImporter = true
        case .folder: showingFolderImporter = true
        }
    }

    /// Everything the tree's context menu can ask for, on the row it was
    /// opened from — never on whatever happens to be selected elsewhere.
    private func perform(_ action: NodeAction, on node: TreeNode) {
        switch action {
        case .newFile:
            selectedDirectory = node.path
            beginNewFile(in: node.path)
        case .newFolder:
            selectedDirectory = node.path
            beginNewFolder(in: node.path)
        case .uploadFiles:
            selectedDirectory = node.path
            beginImport(.files, into: node.path)
        case .uploadFolder:
            selectedDirectory = node.path
            beginImport(.folder, into: node.path)
        case .rename:
            beginRename(node.path)
        case .move:
            askDestination(for: .moveNode(node.path))
        case .delete:
            deleteTarget = DeleteTarget(path: node.path, isDirectory: node.kind == .dir, fileCount: node.fileCount)
        case .select:
            selectFiles(node.kind == .file ? (node.isWritable ? [node.path] : []) : node.writableFilePaths)
        case .copyPath:
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(node.path, forType: .string)
            model.showToast("Copied \(node.path)")
        }
    }

    /// A default name nothing in `directory` is using yet, so creating two
    /// notes in a row cannot quietly overwrite the first.
    private func freeName(in directory: String, base: String, ext: String = "") -> String {
        let siblings = Set((node(at: directory)?.children ?? []).map(\.name))
        var candidate = base + ext
        var index = 2
        while siblings.contains(candidate) {
            candidate = "\(base)-\(index)\(ext)"
            index += 1
        }
        return candidate
    }

    /// The node at a path, for the questions only the loaded tree can answer:
    /// is this a folder, what is already in it.
    private func node(at path: String) -> TreeNode? {
        func find(_ node: TreeNode) -> TreeNode? {
            if node.path == path { return node }
            guard node.path.isEmpty || path.hasPrefix("\(node.path)/") else { return nil }
            for child in node.children ?? [] {
                if let hit = find(child) { return hit }
            }
            return nil
        }
        guard let tree else { return nil }
        return find(tree)
    }

    private func name(of path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }

    private func parentDirectory(of path: String) -> String {
        guard let slash = path.lastIndex(of: "/") else { return "" }
        return String(path[path.startIndex..<slash])
    }

    /// Reveal a path in the tree by expanding it and every ancestor.
    private func expand(_ path: String) {
        let parts = path.split(separator: "/").map(String.init)
        guard !parts.isEmpty else { return }
        for count in 1...parts.count {
            expandedPaths.insert(parts.prefix(count).joined(separator: "/"))
        }
    }

    /// Delete one file or one folder. The service disposes the knowledge each
    /// deleted source produced before it answers, so there is nothing to
    /// re-ingest afterwards.
    private func delete(_ target: DeleteTarget) async {
        isWorking = true
        model.globalActivity = "Deleting \(target.path)…"
        defer {
            isWorking = false
            model.globalActivity = nil
        }
        do {
            _ = try await model.client().deleteFile(path: target.path)
            forget(target.path)
            await loadTree()
            await model.refreshStats()
            model.showToast(target.isDirectory
                ? "Deleted \(target.path)/ — \(target.fileCount) file\(target.fileCount == 1 ? "" : "s")"
                : "Deleted \(target.path)")
        } catch {
            model.showError(error, prefix: "Delete failed")
        }
    }

    private func deleteMessage(_ target: DeleteTarget) -> String {
        guard target.isDirectory else {
            return "This removes \(target.path) from the current workspace. The knowledge extracted from it is disposed; history stays queryable."
        }
        let files = target.fileCount
        return "This removes \(target.path)/ and the \(files) file\(files == 1 ? "" : "s") inside it from the current workspace. The knowledge extracted from them is disposed; history stays queryable."
    }

    /// Drop every reference to a path that is no longer on disk.
    private func forget(_ path: String) {
        func gone(_ candidate: String) -> Bool { candidate == path || candidate.hasPrefix("\(path)/") }
        if let selectedPath, gone(selectedPath) { clearOpenFile() }
        if let selectedDirectory, gone(selectedDirectory) { self.selectedDirectory = nil }
        checkedPaths = checkedPaths.filter { !gone($0) }
        expandedPaths = expandedPaths.filter { !gone($0) }
    }

    /// The one path change behind both rename and a single-node move.
    ///
    /// A path is the document's identity in the graph, so the knowledge only
    /// catches up on the ingest that follows — the deal a batch move makes too.
    private func moveSubtree(from: String, to: String) async {
        guard from != to else {
            activeSheet = nil
            return
        }
        isWorking = true
        model.globalActivity = "Moving \(name(of: from))…"
        defer {
            isWorking = false
            model.globalActivity = nil
        }
        do {
            _ = try await model.client().move(from: from, to: to)
            activeSheet = nil
            follow(from: from, to: to)
            await loadTree()
            expand(parentDirectory(of: to))
            model.showToast("Moved to \(to); re-indexing…")
        } catch {
            model.showError(error, prefix: "Move failed")
            return
        }

        // the files are already where they belong, so a failed re-index must
        // not read as a failed move
        model.globalActivity = "Re-indexing moved files…"
        do {
            let result = try await model.client().ingest()
            await loadTree()
            await model.refreshStats()
            model.showToast("Move complete — \(result.indexed) docs · \(result.chunks) chunks re-indexed")
        } catch {
            model.showError(error, prefix: "Moved, re-index failed")
        }
    }

    /// Keep the open file, the picked folder and the ticked paths pointing at
    /// the moved subtree instead of the path it just left.
    private func follow(from: String, to: String) {
        func moved(_ path: String) -> String? {
            if path == from { return to }
            guard path.hasPrefix("\(from)/") else { return nil }
            return to + String(path.dropFirst(from.count))
        }
        if let selectedPath, let updated = moved(selectedPath) { self.selectedPath = updated }
        if let selectedDirectory, let updated = moved(selectedDirectory) { self.selectedDirectory = updated }
        checkedPaths = Set(checkedPaths.map { moved($0) ?? $0 })
        expandedPaths = Set(expandedPaths.map { moved($0) ?? $0 })
    }

    /// Files upload as themselves, folders upload their whole subtree — the
    /// importer and a drop can both hand over either kind.
    private func importURLs(_ urls: [URL], into destination: String) async {
        guard !urls.isEmpty else { return }
        // Files inside a picked folder are only readable while the folder's own
        // security scope is open, so hold it for the whole import.
        let scoped = urls.filter { $0.startAccessingSecurityScopedResource() }
        defer { scoped.forEach { $0.stopAccessingSecurityScopedResource() } }

        var items: [UploadItem] = []
        for url in urls {
            if isDirectory(url) {
                items.append(contentsOf: folderItems(url))
            } else {
                items.append(UploadItem(name: url.lastPathComponent, url: url))
            }
        }
        guard !items.isEmpty else {
            model.showToast("Nothing to upload — no readable files in that folder")
            return
        }
        await upload(items, into: destination)
    }

    private func upload(_ items: [UploadItem], into destination: String) async {
        isWorking = true
        model.globalActivity = "Uploading \(items.count) file\(items.count == 1 ? "" : "s")…"
        defer {
            isWorking = false
            model.globalActivity = nil
        }
        do {
            var saved = 0
            for batch in uploadBatches(items) {
                let result = try await model.client().upload(items: batch, directory: destination)
                saved += result.saved.count
                model.globalActivity = "Uploading \(saved)/\(items.count) files…"
            }
            model.showToast("Uploaded \(saved) file\(saved == 1 ? "" : "s") into \(destination); indexing…")
            model.globalActivity = "Indexing files…"
            _ = try await model.client().ingest()
            await loadTree()
            expand(destination)
            await model.refreshStats()
            model.showToast("Upload and index complete")
        } catch {
            model.showError(error, prefix: "Upload failed")
        }
    }

    private func isDirectory(_ url: URL) -> Bool {
        if let flag = (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory { return flag }
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) && isDir.boolValue
    }

    /// Every readable file under `folder`, named by its path inside the folder
    /// so the service recreates the subtree under the destination.
    private func folderItems(_ folder: URL) -> [UploadItem] {
        let root = folder.standardizedFileURL
        let rootComponents = root.pathComponents
        guard let enumerator = FileManager.default.enumerator(
            at: root,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else { return [] }

        var items: [UploadItem] = []
        for case let url as URL in enumerator {
            guard (try? url.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true else { continue }
            let components = url.standardizedFileURL.pathComponents
            guard components.count > rootComponents.count,
                  Array(components.prefix(rootComponents.count)) == rootComponents else { continue }
            let relative = components.dropFirst(rootComponents.count).joined(separator: "/")
            items.append(UploadItem(name: "\(root.lastPathComponent)/\(relative)", url: url))
        }
        return items.sorted { $0.name < $1.name }
    }

    /// Split an import into requests small enough to hold in memory.
    private func uploadBatches(_ items: [UploadItem]) -> [[UploadItem]] {
        var batches: [[UploadItem]] = []
        var current: [UploadItem] = []
        var bytes = 0
        for item in items {
            let size = (try? item.url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
            let full = current.count >= Self.uploadBatchFileLimit || bytes + size > Self.uploadBatchByteLimit
            if !current.isEmpty && full {
                batches.append(current)
                current = []
                bytes = 0
            }
            current.append(item)
            bytes += size
        }
        if !current.isEmpty { batches.append(current) }
        return batches
    }

    private func ingest() async {
        isWorking = true
        model.globalActivity = "Indexing files…"
        defer {
            isWorking = false
            model.globalActivity = nil
        }
        do {
            let result = try await model.client().ingest()
            model.showToast("Indexed \(result.indexed) docs · \(result.chunks) chunks")
            await loadTree()
            await model.refreshStats()
        } catch {
            model.showError(error, prefix: "Index failed")
        }
    }

    /// The editor may open only on a complete file that is the user's own text.
    private var isEditable: Bool { !isTruncated && !isDerived }

    /// A truncated preview can be promoted to a full read — and so to editing —
    /// as long as the text is the file's own and the service will serve it whole.
    private var canLoadFullFile: Bool {
        guard let selectedPath, isWritable(selectedPath), !isDerived, let fileBytes else { return false }
        return isTruncated && fileBytes <= Self.editByteCap
    }

    /// Why the open file cannot be edited, or nil when it can.
    private var readOnlyNotice: String? {
        // Derived text is knode-os's rendering of a PDF or image. It is read-only
        // whatever its size: writing it back would replace the original's bytes.
        if isDerived {
            return "Derived Markdown — knode-os produced this from the original, so it is read-only. Replace the original by uploading a new copy."
        }
        guard isTruncated else { return nil }
        let cap = ByteCountFormatter.string(fromByteCount: Int64(Self.previewByteCap), countStyle: .file)
        guard let fileBytes else { return "Preview only — showing the first \(cap). Editing is disabled." }
        let total = ByteCountFormatter.string(fromByteCount: Int64(fileBytes), countStyle: .file)
        let head = "Preview only — showing the first \(cap) of \(total)."
        // Saving a capped read would rewrite the file with just the previewed
        // prefix, so editing stays closed until the whole file is in hand.
        if canLoadFullFile { return "\(head) Load the full file to edit it." }
        let limit = ByteCountFormatter.string(fromByteCount: Int64(Self.editByteCap), countStyle: .file)
        return "\(head) Files over \(limit) cannot be edited here."
    }

    private func clearOpenFile() {
        selectedPath = nil
        content = ""
        editorContent = ""
        isTruncated = false
        isDerived = false
        fileBytes = nil
        isEditing = false
    }

    private func selectFiles(_ paths: [String]) {
        guard !paths.isEmpty else { return }
        selectionMode = true
        checkedPaths.formUnion(paths)
    }

    /// Move every checked file into `destination`, keeping each file's name.
    ///
    /// The service treats a move as a plain rename, so the knowledge only
    /// catches up on the ingest that follows — one run for the whole batch,
    /// the way an upload does it.
    private func batchMove(into destination: String) async {
        let targets = checkedPaths.sorted()
        guard !targets.isEmpty else { return }
        isWorking = true
        model.globalActivity = "Moving \(targets.count) file\(targets.count == 1 ? "" : "s")…"
        defer {
            isWorking = false
            model.globalActivity = nil
        }

        var moved = 0
        var skipped = 0
        var failed: [String] = []
        for target in targets {
            let name = target.split(separator: "/").last.map(String.init) ?? target
            let to = "\(destination)/\(name)"
            if to == target {
                skipped += 1
                continue
            }
            do {
                _ = try await model.client().move(from: target, to: to)
                moved += 1
                if target == selectedPath { clearOpenFile() }
                model.globalActivity = "Moving \(moved)/\(targets.count) files…"
            } catch {
                failed.append(name)
            }
        }

        checkedPaths.removeAll()
        selectionMode = false
        await loadTree()
        expand(destination)

        guard moved > 0 else {
            model.showToast(failed.isEmpty ? "Nothing to move — already in \(destination)" : "Move failed — \(failed.prefix(3).joined(separator: ", "))")
            return
        }
        var summary = "Moved \(moved) file\(moved == 1 ? "" : "s") into \(destination)"
        if skipped > 0 { summary += "; \(skipped) already there" }
        if !failed.isEmpty { summary += "; \(failed.count) failed (\(failed.prefix(3).joined(separator: ", ")))" }
        model.showToast("\(summary); re-indexing…")

        model.globalActivity = "Re-indexing moved files…"
        do {
            let result = try await model.client().ingest()
            await loadTree()
            await model.refreshStats()
            model.showToast("Move complete — \(result.indexed) docs · \(result.chunks) chunks re-indexed")
        } catch {
            model.showError(error, prefix: "Files moved, re-index failed")
        }
    }

    private func batchDelete() async {
        let targets = checkedPaths.sorted()
        guard !targets.isEmpty else { return }
        isWorking = true
        model.globalActivity = "Deleting \(targets.count) files…"
        defer {
            isWorking = false
            model.globalActivity = nil
        }
        var deleted = 0
        var failed: [String] = []
        for target in targets {
            do {
                _ = try await model.client().deleteFile(path: target)
                deleted += 1
                if target == selectedPath { clearOpenFile() }
            } catch {
                failed.append(target)
            }
        }
        checkedPaths.removeAll()
        selectionMode = false
        await loadTree()
        await model.refreshStats()
        if failed.isEmpty {
            model.showToast("Deleted \(deleted) file\(deleted == 1 ? "" : "s")")
        } else {
            model.showToast("Deleted \(deleted), failed \(failed.count) — \(failed.prefix(3).joined(separator: ", "))")
        }
    }

    private func isWritable(_ path: String) -> Bool {
        path == "wiki" || path.hasPrefix("wiki/") || path == "raw/docs" || path.hasPrefix("raw/docs/")
    }
}

/// Plain-text preview.
///
/// Small files render as a single selectable `Text`. Larger ones switch to
/// lazily-rendered lines: one `Text` holding a whole multi-megabyte document
/// lays the entire string out on the main thread and freezes the window, which
/// is exactly what a 2 MB NDJSON file with 20k-character lines used to do.
private struct PlainTextPreview: View {
    private static let inlineCharLimit = 60_000
    private static let lineCharLimit = 4_000

    private let text: String
    private let lines: [String]?

    init(text: String) {
        self.text = text
        lines = text.count > Self.inlineCharLimit
            ? text.split(separator: "\n", omittingEmptySubsequences: false).map { String($0.prefix(Self.lineCharLimit)) }
            : nil
    }

    var body: some View {
        if let lines {
            LazyVStack(alignment: .leading, spacing: 2) {
                ForEach(lines.indices, id: \.self) { index in
                    Text(lines[index])
                        .font(.system(size: 13, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        } else {
            Text(text)
                .font(.system(size: 13, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// What a right-click on a tree row can ask for.
private enum NodeAction {
    case newFile
    case newFolder
    case uploadFiles
    case uploadFolder
    case rename
    case move
    case delete
    case select
    case copyPath
}

private struct FileTreeNodeView: View {
    let node: TreeNode
    let selectedPath: String?
    let selectedDirectory: String?
    let selectionMode: Bool
    @Binding var checkedPaths: Set<String>
    @Binding var expandedPaths: Set<String>
    let openFile: (String) -> Void
    let selectDirectory: (String) -> Void
    let perform: (NodeAction, TreeNode) -> Void

    @ViewBuilder
    var body: some View {
        if node.kind == .dir {
            DisclosureGroup(isExpanded: expansionBinding) {
                if let children = node.children {
                    ForEach(children) { child in
                        FileTreeNodeView(
                            node: child,
                            selectedPath: selectedPath,
                            selectedDirectory: selectedDirectory,
                            selectionMode: selectionMode,
                            checkedPaths: $checkedPaths,
                            expandedPaths: $expandedPaths,
                            openFile: openFile,
                            selectDirectory: selectDirectory,
                            perform: perform
                        )
                    }
                    .padding(.leading, 13)
                }
            } label: {
                rowLabel
                    .contentShape(Rectangle())
                    // one click both picks the folder new items go into and
                    // opens it — the two things a click on a folder can mean
                    .onTapGesture {
                        selectDirectory(node.path)
                        toggleExpansion()
                    }
                    .contextMenu { directoryMenu }
            }
        } else if selectionMode {
            rowLabel
                .onTapGesture { toggleChecked() }
                .contextMenu { fileMenu }
        } else {
            Button { openFile(node.path) } label: { rowLabel }
                .buttonStyle(.plain)
                .contextMenu { fileMenu }
        }
    }

    @ViewBuilder
    private var directoryMenu: some View {
        if node.isWritable {
            Button("New file here…") { perform(.newFile, node) }
            Button("New folder here…") { perform(.newFolder, node) }
            Divider()
            Button("Upload files here…") { perform(.uploadFiles, node) }
            Button("Upload folder here…") { perform(.uploadFolder, node) }
            Divider()
        }
        let writable = node.writableFilePaths
        Button("Select \(writable.count) file\(writable.count == 1 ? "" : "s") here") { perform(.select, node) }
            .disabled(writable.isEmpty)
        Button("Copy path") { perform(.copyPath, node) }
        if node.isMovable {
            Divider()
            Button("Rename folder…") { perform(.rename, node) }
            Button("Move folder to…") { perform(.move, node) }
            Button("Delete folder…", role: .destructive) { perform(.delete, node) }
        }
    }

    @ViewBuilder
    private var fileMenu: some View {
        Button("Open") { openFile(node.path) }
        Button("Select this file") { perform(.select, node) }
            .disabled(!node.isWritable || isChecked)
        Button("Copy path") { perform(.copyPath, node) }
        if node.isMovable {
            Divider()
            Button("Rename…") { perform(.rename, node) }
            Button("Move to…") { perform(.move, node) }
            Divider()
            Button("Delete…", role: .destructive) { perform(.delete, node) }
        }
    }

    private var expansionBinding: Binding<Bool> {
        Binding(
            get: { expandedPaths.contains(node.path) },
            set: { isExpanded in
                if isExpanded { expandedPaths.insert(node.path) }
                else { expandedPaths.remove(node.path) }
            }
        )
    }

    private func toggleExpansion() {
        if expandedPaths.contains(node.path) { expandedPaths.remove(node.path) }
        else { expandedPaths.insert(node.path) }
    }

    private var isChecked: Bool { checkedPaths.contains(node.path) }

    private func toggleChecked() {
        guard node.kind == .file, node.isWritable else { return }
        if isChecked { checkedPaths.remove(node.path) } else { checkedPaths.insert(node.path) }
    }

    private var rowLabel: some View {
        HStack(spacing: 7) {
            if selectionMode, node.kind == .file {
                Image(systemName: isChecked ? "checkmark.square.fill" : "square")
                    .foregroundStyle(node.isWritable ? (isChecked ? Color.knodeCyan : Color.secondary) : Color.secondary.opacity(0.3))
                    .frame(width: 13)
            }
            Image(systemName: symbol)
                .foregroundStyle(node.kind == .dir ? Color.knodeViolet : Color.secondary)
                .frame(width: 16)
            Text(node.name)
                .lineLimit(1)
            Spacer(minLength: 4)
            if let bytes = node.bytes, node.kind == .file {
                Text(ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file))
                    .font(.system(size: 8, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
        }
        .font(.system(size: 12))
        .padding(.horizontal, 7)
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .opacity(selectionMode && node.kind == .file && !node.isWritable ? 0.45 : 1)
        .background(rowHighlight, in: RoundedRectangle(cornerRadius: 6))
    }

    private var rowHighlight: Color {
        if selectionMode && isChecked { return Color.knodeCyan.opacity(0.2) }
        if node.kind == .dir {
            return node.path == selectedDirectory ? Color.knodeViolet.opacity(0.22) : Color.clear
        }
        return node.path == selectedPath ? Color.knodeCyan.opacity(0.14) : Color.clear
    }

    private var symbol: String {
        if node.kind == .dir { return "folder.fill" }
        if node.name.hasSuffix(".md") || node.name.hasSuffix(".markdown") { return "doc.richtext" }
        if node.name.hasSuffix(".json") || node.name.hasSuffix(".jsonl") { return "curlybraces" }
        return "doc.text"
    }
}

private extension TreeNode {
    var flattenedDirectoryPaths: [String] {
        guard kind == .dir else { return [] }
        return [path] + (children ?? []).flatMap(\.flattenedDirectoryPaths)
    }

    /// Directories an upload or a move may target — what the destination
    /// picker lists.
    var writableDirectoryPaths: [String] {
        guard kind == .dir else { return [] }
        let here = isWritable ? [path] : []
        return here + (children ?? []).flatMap(\.writableDirectoryPaths)
    }

    /// Every deletable file at or below this node — what "select all here" adds.
    var writableFilePaths: [String] {
        if kind == .file { return isWritable ? [path] : [] }
        return (children ?? []).flatMap(\.writableFilePaths)
    }

    /// Files at or below this node — what a folder delete warns about.
    var fileCount: Int {
        if kind == .file { return 1 }
        return (children ?? []).reduce(0) { $0 + $1.fileCount }
    }

    /// Renamable, movable, deletable: writable, but not one of the roots the
    /// workspace itself is built from — the service refuses those anyway.
    var isMovable: Bool {
        isWritable && path != "wiki" && path != "raw/docs"
    }
}
