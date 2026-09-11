import SwiftUI
import UniformTypeIdentifiers

struct FileBrowserView: View {
    @EnvironmentObject private var model: AppModel
    @State private var tree: TreeNode?
    @State private var selectedPath: String?
    @State private var content = ""
    @State private var editorContent = ""
    @State private var isEditing = false
    @State private var isLoading = true
    @State private var isWorking = false
    @State private var showingImporter = false
    @State private var showingNewFile = false
    @State private var showingDelete = false
    @State private var newFilePath = "wiki/concepts/new-note.md"
    @State private var expandedPaths: Set<String> = ["wiki"]

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
            Task { await upload(urls) }
        }
        .sheet(isPresented: $showingNewFile) { newFileSheet }
        .alert("Delete file?", isPresented: $showingDelete) {
            Button("Cancel", role: .cancel) {}
            Button("Delete", role: .destructive) { Task { await deleteSelectedFile() } }
        } message: {
            Text(selectedPath.map { "This removes \($0) from the current workspace." } ?? "")
        }
    }

    private var treePane: some View {
        VStack(spacing: 0) {
            HStack(spacing: 7) {
                Button { Task { await loadTree() } } label: { Image(systemName: "arrow.clockwise") }
                    .help("Refresh files")
                Button {
                    newFilePath = "wiki/concepts/new-note.md"
                    showingNewFile = true
                } label: { Image(systemName: "doc.badge.plus") }
                    .help("New file")
                Button { showingImporter = true } label: { Image(systemName: "square.and.arrow.down") }
                    .help("Upload documents")
                Spacer()
                Button { Task { await ingest() } } label: {
                    if isWorking { ProgressView().controlSize(.small) }
                    else { Label("Ingest", systemImage: "tray.and.arrow.down.fill") }
                }
                .disabled(isWorking)
                .help("Chunk, embed, and update the graph")
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
                                expandedPaths: $expandedPaths
                            ) { path in
                                Task { await openFile(path) }
                            }
                        }
                    }
                    .padding(.horizontal, 6)
                    .padding(.vertical, 7)
                }
                .dropDestination(for: URL.self) { urls, _ in
                    Task { await upload(urls) }
                    return !urls.isEmpty
                } isTargeted: { targeted in
                    if targeted { model.showToast("Drop files to upload into raw/docs") }
                }
            } else {
                EmptyState(symbol: "folder", title: "No files", message: "Connect to the local service or initialize a workspace.")
            }
        }
        .background(.ultraThinMaterial)
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
                        .disabled(!isWritable(selectedPath) || isWorking)
                    Button("Save") { Task { await save() } }
                        .buttonStyle(.borderedProminent)
                        .tint(.knodeCyan)
                        .disabled(!isEditing || isWorking)
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
                                Text(content)
                                    .font(.system(size: 13, design: .monospaced))
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
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
                message: "Browse the workspace tree, or drag documents onto it to upload and ingest them."
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
                Button("Cancel") { showingNewFile = false }
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
            editorContent = response.content
            isEditing = false
        } catch {
            model.showError(error, prefix: "Open failed")
        }
    }

    private func openKnowledgeLink(_ target: String, from sourcePath: String) async {
        do {
            let resolved = try await model.client().resolveLink(target, from: sourcePath)
            let parts = resolved.path.split(separator: "/").map(String.init)
            if parts.count > 1 {
                for count in 1..<parts.count {
                    expandedPaths.insert(parts.prefix(count).joined(separator: "/"))
                }
            }
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
            showingNewFile = false
            await loadTree()
            await openFile(path)
        } catch {
            isWorking = false
            model.showError(error, prefix: "Create failed")
        }
    }

    private func deleteSelectedFile() async {
        guard let selectedPath else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            _ = try await model.client().deleteFile(path: selectedPath)
            model.showToast("Deleted \(selectedPath)")
            self.selectedPath = nil
            content = ""
            editorContent = ""
            await loadTree()
            await model.refreshStats()
        } catch {
            model.showError(error, prefix: "Delete failed")
        }
    }

    private func upload(_ urls: [URL]) async {
        guard !urls.isEmpty else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            let result = try await model.client().upload(files: urls)
            model.showToast("Uploaded \(result.saved.count) file\(result.saved.count == 1 ? "" : "s"); ingesting…")
            _ = try await model.client().ingest()
            await loadTree()
            await model.refreshStats()
            model.showToast("Upload and ingest complete")
        } catch {
            model.showError(error, prefix: "Upload failed")
        }
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

    private func isWritable(_ path: String) -> Bool {
        path == "wiki" || path.hasPrefix("wiki/") || path == "raw/docs" || path.hasPrefix("raw/docs/")
    }
}

private struct FileTreeNodeView: View {
    let node: TreeNode
    let selectedPath: String?
    @Binding var expandedPaths: Set<String>
    let openFile: (String) -> Void

    @ViewBuilder
    var body: some View {
        if node.kind == .dir {
            DisclosureGroup(isExpanded: expansionBinding) {
                if let children = node.children {
                    ForEach(children) { child in
                        FileTreeNodeView(
                            node: child,
                            selectedPath: selectedPath,
                            expandedPaths: $expandedPaths,
                            openFile: openFile
                        )
                    }
                    .padding(.leading, 13)
                }
            } label: {
                rowLabel
                    .contentShape(Rectangle())
                    .onTapGesture { toggleExpansion() }
            }
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

    private var rowLabel: some View {
        HStack(spacing: 7) {
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
        .background(node.path == selectedPath ? Color.knodeCyan.opacity(0.14) : Color.clear, in: RoundedRectangle(cornerRadius: 6))
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
}
