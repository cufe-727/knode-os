import SwiftUI
import UniformTypeIdentifiers

struct FileBrowserView: View {
    /// Mirrors MAX_PREVIEW_BYTES in the service — only used to word the notice.
    static let previewByteCap = 256 * 1024

    /// One presentation slot: stacking `.sheet` modifiers on a single view is
    /// unreliable, so every editor shares this one.
    private enum ActiveSheet: Identifiable {
        case newFile
        case newFolder
        case destination(DestinationPurpose)

        var id: String {
            switch self {
            case .newFile: "newFile"
            case .newFolder: "newFolder"
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
        case move

        var id: String {
            switch self {
            case .upload(.files): "upload-files"
            case .upload(.folder): "upload-folder"
            case .move: "move"
            }
        }
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
    @State private var showingDelete = false
    @State private var showingBatchDelete = false
    @State private var activeSheet: ActiveSheet?
    @State private var newFilePath = "wiki/concepts/new-note.md"
    @State private var newFolderPath = "wiki/concepts/new-folder"
    /// Where the next import lands. A directory's context menu sets it
    /// directly; the toolbar asks for it in the destination picker first.
    @State private var importDestination = "raw/docs"
    /// What the destination picker is editing, and the importer it still owes
    /// once its sheet has closed — presenting a `.fileImporter` while a sheet
    /// is on screen drops it silently.
    @State private var destinationPath = "raw/docs"
    @State private var pendingImport: ImportKind?
    @State private var expandedPaths: Set<String> = ["wiki"]
    @State private var isTruncated = false
    @State private var fileBytes: Int?
    @State private var selectionMode = false
    @State private var checkedPaths: Set<String> = []

    var body: some View {
        HSplitView {
            treePane
                .frame(minWidth: 220, idealWidth: 270, maxWidth: 360)
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
            case .destination(let purpose): destinationSheet(purpose)
            }
        }
        .alert("Delete file?", isPresented: $showingDelete) {
            Button("Cancel", role: .cancel) {}
            Button("Delete", role: .destructive) { Task { await deleteSelectedFile() } }
        } message: {
            Text(selectedPath.map { "This removes \($0) from the current workspace." } ?? "")
        }
        .alert("Delete \(checkedPaths.count) files?", isPresented: $showingBatchDelete) {
            Button("Cancel", role: .cancel) {}
            Button("Delete", role: .destructive) { Task { await batchDelete() } }
        } message: {
            Text("This removes the selected files from the current workspace. Their extracted knowledge is disposed on the next ingest.")
        }
    }

    private var defaultToolbar: some View {
        HStack(spacing: 7) {
            Button { Task { await loadTree() } } label: { Image(systemName: "arrow.clockwise") }
                .help("Refresh files")
            Button { beginNewFile(in: defaultDirectory) } label: { Image(systemName: "doc.badge.plus") }
                .help("New file")
            Button { beginNewFolder(in: defaultDirectory) } label: { Image(systemName: "folder.badge.plus") }
                .help("New folder")
            Menu {
                Button("Upload files…") { askDestination(for: .upload(.files)) }
                Button("Upload folder…") { askDestination(for: .upload(.folder)) }
            } label: {
                Image(systemName: "square.and.arrow.down")
            }
            .menuStyle(.button)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Upload documents or a whole folder — you pick the destination folder")
            Button { selectionMode = true } label: { Image(systemName: "checklist") }
                .help("Select multiple files to move or delete")
            Spacer()
            Button { Task { await ingest() } } label: {
                if isWorking { ProgressView().controlSize(.small) }
                else { Label("Ingest", systemImage: "tray.and.arrow.down.fill") }
            }
            .disabled(isWorking)
            .help("Chunk, embed, and update the graph")
        }
    }

    private var selectionToolbar: some View {
        HStack(spacing: 7) {
            Text("\(checkedPaths.count) selected")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
            if isWorking { ProgressView().controlSize(.small) }
            Spacer()
            Button { askDestination(for: .move) } label: {
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
            .padding(10)

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
                                selectionMode: selectionMode,
                                checkedPaths: $checkedPaths,
                                expandedPaths: $expandedPaths,
                                openFile: { path in Task { await openFile(path) } },
                                selectFiles: selectFiles,
                                directoryAction: directoryAction
                            )
                        }
                    }
                    .padding(.horizontal, 6)
                    .padding(.vertical, 7)
                }
                .dropDestination(for: URL.self) { urls, _ in
                    Task { await importURLs(urls, into: "raw/docs") }
                    return !urls.isEmpty
                } isTargeted: { targeted in
                    if targeted { model.showToast("Drop files or folders to upload into raw/docs") }
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
                        .disabled(!isWritable(selectedPath) || isWorking || isTruncated)
                    Button("Save") { Task { await save() } }
                        .buttonStyle(.borderedProminent)
                        .tint(.knodeCyan)
                        .disabled(!isEditing || isWorking || isTruncated)
                    Button(role: .destructive) { showingDelete = true } label: {
                        Image(systemName: "trash")
                    }
                    .disabled(!isWritable(selectedPath) || isWorking)
                }
                .controlSize(.small)
                .padding(.horizontal, 14)
                .frame(height: 48)
                .background(.bar)
                Divider()

                if isTruncated {
                    HStack(spacing: 8) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                        Text(truncationNotice)
                            .foregroundStyle(.secondary)
                        Spacer(minLength: 0)
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
                message: "Browse the workspace tree, or drag documents and folders onto it to upload and ingest them."
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

    private func destinationSheet(_ purpose: DestinationPurpose) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 5) {
                Eyebrow(text: purpose == .move ? "Move" : "Upload")
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
                Button(purpose == .move ? "Move" : "Choose…") { confirmDestination(purpose) }
                    .buttonStyle(.borderedProminent)
                    .tint(.knodeCyan)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!isWritable(trimmedDestination))
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
        case .move: "Move \(checkedPaths.count) file\(checkedPaths.count == 1 ? "" : "s") to…"
        }
    }

    private func destinationHint(_ purpose: DestinationPurpose) -> String {
        switch purpose {
        case .upload(.files):
            "Pick or type the folder the documents land in. Uploads go under raw/docs/ or wiki/; a folder that does not exist yet is created."
        case .upload(.folder):
            "Pick or type the folder the dropped folder's subtree is recreated under. Uploads go under raw/docs/ or wiki/."
        case .move:
            "A file's path is its identity in the knowledge graph, so moving it re-indexes it — embeddings and extractions are rebuilt on the ingest that follows."
        }
    }

    private func askDestination(for purpose: DestinationPurpose) {
        destinationPath = purpose == .move ? commonParentOfChecked : defaultUploadDirectory
        activeSheet = .destination(purpose)
    }

    private func confirmDestination(_ purpose: DestinationPurpose) {
        let destination = trimmedDestination
        guard isWritable(destination) else { return }
        activeSheet = nil
        switch purpose {
        case .upload(let kind):
            importDestination = destination
            pendingImport = kind
        case .move:
            Task { await batchMove(into: destination) }
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

    /// Prefill for an upload: the open file's folder when documents may go
    /// there, otherwise the document root.
    private var defaultUploadDirectory: String {
        guard let selectedPath, isWritable(selectedPath) else { return "raw/docs" }
        let parent = parentDirectory(of: selectedPath)
        return isWritable(parent) ? parent : "raw/docs"
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
            content = response.content
            // A capped read must never round-trip through the editor: saving it
            // back would rewrite the file with only the previewed prefix.
            isTruncated = response.truncated ?? false
            fileBytes = response.bytes
            editorContent = isTruncated ? "" : response.content
            isEditing = false
        } catch {
            model.showError(error, prefix: "Open failed")
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
        newFilePath = directory.isEmpty ? "wiki/new-note.md" : "\(directory)/new-note.md"
        activeSheet = .newFile
    }

    private func beginNewFolder(in directory: String) {
        newFolderPath = directory.isEmpty ? "wiki/new-folder" : "\(directory)/new-folder"
        activeSheet = .newFolder
    }

    private func beginImport(_ kind: ImportKind, into destination: String) {
        importDestination = destination
        switch kind {
        case .files: showingImporter = true
        case .folder: showingFolderImporter = true
        }
    }

    private func directoryAction(_ action: DirectoryAction, on directory: String) {
        switch action {
        case .newFolder: beginNewFolder(in: directory)
        case .uploadFiles: beginImport(.files, into: directory)
        case .uploadFolder: beginImport(.folder, into: directory)
        }
    }

    /// What the toolbar's create actions prefill: the open file's folder when
    /// that is writable, otherwise the wiki root.
    private var defaultDirectory: String {
        guard let selectedPath, isWritable(selectedPath) else { return "wiki" }
        let parent = parentDirectory(of: selectedPath)
        return isWritable(parent) ? parent : "wiki"
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

    private func deleteSelectedFile() async {
        guard let selectedPath else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            _ = try await model.client().deleteFile(path: selectedPath)
            model.showToast("Deleted \(selectedPath)")
            clearOpenFile()
            await loadTree()
            await model.refreshStats()
        } catch {
            model.showError(error, prefix: "Delete failed")
        }
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
            model.showToast("Uploaded \(saved) file\(saved == 1 ? "" : "s") into \(destination); ingesting…")
            model.globalActivity = "Ingesting knowledge…"
            _ = try await model.client().ingest()
            await loadTree()
            expand(destination)
            await model.refreshStats()
            model.showToast("Upload and ingest complete")
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
        model.globalActivity = "Ingesting knowledge…"
        defer {
            isWorking = false
            model.globalActivity = nil
        }
        do {
            let result = try await model.client().ingest()
            model.showToast("Ingested \(result.indexed) docs · \(result.chunks) chunks")
            await loadTree()
            await model.refreshStats()
        } catch {
            model.showError(error, prefix: "Ingest failed")
        }
    }

    private var truncationNotice: String {
        let cap = ByteCountFormatter.string(fromByteCount: Int64(Self.previewByteCap), countStyle: .file)
        guard let fileBytes else { return "Preview only — showing the first \(cap). Editing is disabled." }
        let total = ByteCountFormatter.string(fromByteCount: Int64(fileBytes), countStyle: .file)
        return "Preview only — showing the first \(cap) of \(total). Editing is disabled so a save cannot truncate the file."
    }

    private func clearOpenFile() {
        selectedPath = nil
        content = ""
        editorContent = ""
        isTruncated = false
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

/// What a right-click on a writable directory row offers.
private enum DirectoryAction {
    case newFolder
    case uploadFiles
    case uploadFolder
}

private struct FileTreeNodeView: View {
    let node: TreeNode
    let selectedPath: String?
    let selectionMode: Bool
    @Binding var checkedPaths: Set<String>
    @Binding var expandedPaths: Set<String>
    let openFile: (String) -> Void
    let selectFiles: ([String]) -> Void
    let directoryAction: (DirectoryAction, String) -> Void

    @ViewBuilder
    var body: some View {
        if node.kind == .dir {
            DisclosureGroup(isExpanded: expansionBinding) {
                if let children = node.children {
                    ForEach(children) { child in
                        FileTreeNodeView(
                            node: child,
                            selectedPath: selectedPath,
                            selectionMode: selectionMode,
                            checkedPaths: $checkedPaths,
                            expandedPaths: $expandedPaths,
                            openFile: openFile,
                            selectFiles: selectFiles,
                            directoryAction: directoryAction
                        )
                    }
                    .padding(.leading, 13)
                }
            } label: {
                rowLabel
                    .contentShape(Rectangle())
                    .onTapGesture { toggleExpansion() }
                    .contextMenu {
                        if node.isWritable {
                            Button("New folder here…") { directoryAction(.newFolder, node.path) }
                            Button("Upload files here…") { directoryAction(.uploadFiles, node.path) }
                            Button("Upload folder here…") { directoryAction(.uploadFolder, node.path) }
                            Divider()
                        }
                        let writable = node.writableFilePaths
                        Button("Select \(writable.count) file\(writable.count == 1 ? "" : "s") here") {
                            selectFiles(writable)
                        }
                        .disabled(writable.isEmpty)
                    }
            }
        } else if selectionMode {
            rowLabel
                .onTapGesture { toggleChecked() }
        } else {
            Button { openFile(node.path) } label: { rowLabel }
                .buttonStyle(.plain)
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
}
