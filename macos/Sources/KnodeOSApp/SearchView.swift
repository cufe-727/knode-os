import SwiftUI

struct SearchView: View {
    @EnvironmentObject private var model: AppModel
    @State private var query = ""
    @State private var mode: SearchMode = .hybrid
    @State private var results: [SearchResult] = []
    @State private var selectedID: String?
    @State private var isSearching = false
    @State private var hasSearched = false
    @FocusState private var searchFocused: Bool

    private var selectedResult: SearchResult? {
        results.first(where: { $0.id == selectedID })
    }

    var body: some View {
        VStack(spacing: 0) {
            searchBar
            Divider()
            if isSearching && results.isEmpty {
                ProgressView("Searching \(model.activeWorkspace?.displayName ?? "workspace")…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if !hasSearched {
                EmptyState(
                    symbol: "magnifyingglass",
                    title: L("Recall anything"),
                    message: L("Search across documents, skills, and the generated wiki. Hybrid mode combines semantic, keyword, graph, and usage signals.")
                )
            } else if results.isEmpty {
                EmptyState(
                    symbol: "magnifyingglass",
                    title: L("No matching knowledge"),
                    message: L("Try broader terms, another retrieval mode, or index more documents.")
                )
            } else {
                HSplitView {
                    resultsList
                        .frame(minWidth: 360, idealWidth: 460, maxWidth: 580)
                    resultDetail
                        .frame(minWidth: 480, maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
        .background(Color(nsColor: .textBackgroundColor).opacity(0.22))
        .onAppear { searchFocused = true }
    }

    private var searchBar: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField(L("Search the knowledge base…"), text: $query)
                .textFieldStyle(.plain)
                .font(.title3)
                .focused($searchFocused)
                .onSubmit { Task { await search() } }
            Picker(L("Mode"), selection: $mode) {
                ForEach(SearchMode.allCases) { mode in Text(mode.rawValue.capitalized).tag(mode) }
            }
            .pickerStyle(.segmented)
            .frame(width: 250)
            Button(L("Search")) { Task { await search() } }
                .buttonStyle(.borderedProminent)
                .tint(.knodeCyan)
                .disabled(query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSearching)
            if isSearching { ProgressView().controlSize(.small) }
        }
        .padding(.horizontal, 18)
        .frame(height: 60)
        .background(.bar)
    }

    private var resultsList: some View {
        List(selection: $selectedID) {
            Section("\(results.count) results · \(mode.rawValue)") {
                ForEach(results) { result in
                    VStack(alignment: .leading, spacing: 7) {
                        HStack {
                            Text(result.path)
                                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                                .foregroundStyle(Color.knodeCyan)
                                .lineLimit(1)
                            Spacer()
                            Text(result.score, format: .number.precision(.fractionLength(4)))
                                .font(.caption2.monospaced())
                                .foregroundStyle(.secondary)
                        }
                        Text(result.content.replacingOccurrences(of: "\n", with: " "))
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                        HStack(spacing: 5) {
                            ForEach(result.signals.keys.sorted(), id: \.self) { signal in
                                RouteBadge(label: signal, color: signal == "graph" ? .knodeViolet : .knodeCyan)
                            }
                        }
                    }
                    .padding(.vertical, 6)
                    .tag(result.id)
                }
            }
        }
        .listStyle(.inset)
    }

    @ViewBuilder
    private var resultDetail: some View {
        if let result = selectedResult {
            VStack(spacing: 0) {
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(result.title ?? URL(fileURLWithPath: result.path).deletingPathExtension().lastPathComponent)
                            .font(.headline)
                        Text(result.path)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Open File", systemImage: "arrow.up.forward.app") { model.openFile(result.path) }
                        .buttonStyle(.borderedProminent)
                        .tint(.knodeCyan)
                }
                .padding(16)
                .background(.bar)
                Divider()
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        HStack(spacing: 12) {
                            VStack(alignment: .leading, spacing: 3) {
                                Eyebrow(text: L("Relevance"))
                                Text(result.score, format: .number.precision(.fractionLength(4)))
                                    .font(.title2.monospacedDigit().bold())
                            }
                            ForEach(result.signals.sorted(by: { $0.key < $1.key }), id: \.key) { key, value in
                                VStack(alignment: .leading, spacing: 3) {
                                    Eyebrow(text: key, color: key == "graph" ? .knodeViolet : .knodeCyan)
                                    Text(value, format: .number.precision(.fractionLength(3)))
                                        .font(.callout.monospacedDigit())
                                }
                            }
                            Spacer()
                        }
                        .knodeCard()
                        Text(result.content)
                            .textSelection(.enabled)
                            .font(.system(size: 14))
                            .lineSpacing(4)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(22)
                    .frame(maxWidth: 880)
                    .frame(maxWidth: .infinity)
                }
            }
        } else {
            EmptyState(symbol: "doc.text.magnifyingglass", title: L("Choose a result"), message: L("Inspect its retrieval signals and open the source file."))
        }
    }

    private func search() async {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return }
        isSearching = true
        hasSearched = true
        defer { isSearching = false }
        do {
            results = try await model.client().search(query, mode: mode)
            selectedID = results.first?.id
            await model.refreshStats()
        } catch {
            results = []
            selectedID = nil
            model.showError(error, prefix: "Search failed")
        }
    }
}
