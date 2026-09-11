import SwiftUI

struct AskView: View {
    @EnvironmentObject private var model: AppModel
    @State private var question = ""
    @State private var response: AskResponse?
    @State private var isAsking = false
    @State private var hasAsked = false
    @FocusState private var questionFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            askBar
            Divider()
            if isAsking && response == nil {
                VStack(spacing: 14) {
                    ProgressView()
                        .controlSize(.large)
                    Text("Searching context, following the graph, and composing a cited answer…")
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let response {
                answer(response)
            } else if hasAsked {
                EmptyState(symbol: "exclamationmark.bubble", title: "No answer returned", message: "Check the local service and your default reasoning model route.")
            } else {
                EmptyState(
                    symbol: "sparkles",
                    title: "Ask your knowledge base",
                    message: "Answers are grounded in retrieved chunks and extracted claims. Citations link straight back to the source files."
                )
            }
        }
        .background(Color(nsColor: .textBackgroundColor).opacity(0.22))
        .onAppear { questionFocused = true }
    }

    private var askBar: some View {
        HStack(spacing: 10) {
            Image(systemName: "sparkles").foregroundStyle(Color.knodeViolet)
            TextField("Ask a question — answered from your workspace with citations…", text: $question)
                .textFieldStyle(.plain)
                .font(.title3)
                .focused($questionFocused)
                .onSubmit { Task { await ask() } }
            Button("Ask") { Task { await ask() } }
                .buttonStyle(.borderedProminent)
                .tint(.knodeViolet)
                .disabled(question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isAsking)
            if isAsking { ProgressView().controlSize(.small) }
        }
        .padding(.horizontal, 18)
        .frame(height: 60)
        .background(.bar)
    }

    private func answer(_ response: AskResponse) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 12) {
                    Eyebrow(text: "Answer", color: .knodeViolet)
                    MarkdownText(markdown: response.answer)
                        .font(.system(size: 16))
                        .lineSpacing(5)
                }
                .knodeCard(padding: 20)

                if !response.citations.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        Label("Citations", systemImage: "quote.opening")
                            .font(.headline)
                        ForEach(response.citations) { citation in
                            Button { model.openFile(citation.path) } label: {
                                HStack {
                                    Text("[\(citation.ref)]")
                                        .font(.callout.monospaced().bold())
                                        .foregroundStyle(Color.knodeCyan)
                                    Text(citation.path)
                                        .font(.callout.monospaced())
                                        .lineLimit(1)
                                    Spacer()
                                    Image(systemName: "arrow.up.forward.app").foregroundStyle(.tertiary)
                                }
                                .padding(10)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .background(Color.knodeCyan.opacity(0.07), in: RoundedRectangle(cornerRadius: 8))
                        }
                    }
                }

                if !response.facts.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        Label("Known facts", systemImage: "checkmark.seal")
                            .font(.headline)
                        ForEach(response.facts.prefix(8)) { fact in
                            HStack(alignment: .top, spacing: 10) {
                                RouteBadge(label: fact.status, color: fact.status == "verified" ? .knodeGood : .knodeViolet)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(fact.statement)
                                    Text(fact.subject)
                                        .font(.caption.monospaced())
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .padding(.vertical, 5)
                        }
                    }
                    .knodeCard()
                }

                if !response.gaps.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        Label("Knowledge gaps", systemImage: "exclamationmark.triangle")
                            .font(.headline)
                            .foregroundStyle(Color.knodeBad)
                        ForEach(response.gaps, id: \.self) { gap in
                            HStack(alignment: .top) {
                                Image(systemName: "circle.fill").font(.system(size: 5)).padding(.top, 7)
                                Text(gap)
                            }
                        }
                    }
                    .padding(16)
                    .background(Color.knodeBad.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                    .overlay { RoundedRectangle(cornerRadius: 12).stroke(Color.knodeBad.opacity(0.2)) }
                }
            }
            .padding(24)
            .frame(maxWidth: 920)
            .frame(maxWidth: .infinity)
        }
    }

    private func ask() async {
        let question = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty else { return }
        isAsking = true
        hasAsked = true
        defer { isAsking = false }
        do {
            response = try await model.client().ask(question)
            await model.refreshStats()
        } catch {
            response = nil
            model.showError(error, prefix: "Ask failed")
        }
    }
}
