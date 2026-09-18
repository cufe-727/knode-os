import SwiftUI

/// The chat entry: conversations on the left, the thread on the right. A turn
/// runs as a background session of the configured CLI — the composer is
/// disabled while it answers, the tool calls it makes appear as they happen,
/// and a note it wrote can be adopted (promoted out of quarantine) inline.
struct ChatView: View {
    @EnvironmentObject private var model: AppModel
    @State private var conversations: [ChatConversation] = []
    @State private var activeId: String?
    @State private var thread: ChatConversation?
    @State private var draft = ""
    @State private var activity: [ChatEvent] = []
    @State private var isAnswering = false
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var pollTask: Task<Void, Never>?
    @FocusState private var composerFocused: Bool

    var body: some View {
        HStack(spacing: 0) {
            sidebar
                .frame(width: 240)
            Divider()
            conversationPane
        }
        .background(Color(nsColor: .textBackgroundColor).opacity(0.22))
        .task { await load() }
        .onDisappear { pollTask?.cancel() }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                Task { await newConversation() }
            } label: {
                Label(L("New chat"), systemImage: "square.and.pencil").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(.knodeCyan)
            .padding(.horizontal, 12)
            .padding(.top, 12)

            if conversations.isEmpty && !isLoading {
                Text(L("No conversations yet."))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 14)
            }
            ScrollView {
                VStack(spacing: 4) {
                    ForEach(conversations) { conversation in
                        conversationRow(conversation)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.bottom, 12)
            }
        }
        .frame(maxHeight: .infinity, alignment: .top)
    }

    private func conversationRow(_ conversation: ChatConversation) -> some View {
        HStack(spacing: 6) {
            VStack(alignment: .leading, spacing: 2) {
                Text(conversation.displayTitle)
                    .lineLimit(1)
                    .font(.system(size: 12))
                Text(shortTime(conversation.updatedAt))
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            Button {
                Task { await remove(conversation) }
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .semibold))
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .help(L("Delete this conversation"))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(conversation.id == activeId ? Color.knodeCyan.opacity(0.16) : Color.clear, in: RoundedRectangle(cornerRadius: 8))
        .overlay { RoundedRectangle(cornerRadius: 8).stroke(conversation.id == activeId ? Color.knodeCyan.opacity(0.5) : Color.white.opacity(0.06)) }
        .contentShape(Rectangle())
        .onTapGesture { Task { await open(conversation.id) } }
    }

    private var conversationPane: some View {
        VStack(spacing: 0) {
            if let errorMessage {
                Text(errorMessage).font(.callout).foregroundStyle(.red).padding(10)
            }
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        if let messages = thread?.messages, !messages.isEmpty {
                            ForEach(messages) { message in
                                messageRow(message).id(message.id)
                            }
                        } else {
                            EmptyState(
                                symbol: "bubble.left.and.bubble.right",
                                title: L("Ask the knowledge base"),
                                message: L("Ask what it knows, or teach it something — what you teach is written as a quarantined note you can adopt.")
                            )
                            .frame(maxWidth: .infinity)
                            .padding(.top, 60)
                        }
                    }
                    .padding(20)
                    .frame(maxWidth: 900, alignment: .leading)
                    .frame(maxWidth: .infinity)
                }
                .onChange(of: thread?.messages?.count ?? 0) {
                    if let last = thread?.messages?.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
                }
            }
            if isAnswering {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text(L("Answering…")).font(.system(size: 11, design: .monospaced)).foregroundStyle(Color.knodeCyan)
                    ForEach(activity) { event in chip(event) }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 8)
                .background(.bar)
            }
            composer
        }
    }

    private func messageRow(_ message: ChatMessage) -> some View {
        HStack {
            if message.isUser { Spacer(minLength: 60) }
            VStack(alignment: .leading, spacing: 8) {
                if message.content.isEmpty {
                    Text(message.error.map { "(\($0))" } ?? L("(empty reply)"))
                        .font(.callout)
                        .foregroundStyle(.secondary)
                } else {
                    MarkdownText(markdown: message.content)
                }
                if !message.events.isEmpty {
                    FlowRow(spacing: 6) {
                        ForEach(message.events) { event in
                            HStack(spacing: 4) {
                                chip(event)
                                if event.tool == "wrote", let path = event.path {
                                    Button(L("Open")) { model.openFile(path) }
                                        .buttonStyle(.link)
                                        .font(.system(size: 10))
                                    Button(L("Adopt")) { Task { await adopt(path) } }
                                        .buttonStyle(.link)
                                        .font(.system(size: 10))
                                        .help(L("Promote this note from quarantined to trusted"))
                                }
                            }
                        }
                    }
                }
                if let error = message.error, !message.content.isEmpty {
                    Text(error).font(.system(size: 10, design: .monospaced)).foregroundStyle(.red)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(message.isUser ? Color.knodeCyan.opacity(0.14) : Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
            .overlay { RoundedRectangle(cornerRadius: 12).stroke(message.isUser ? Color.knodeCyan.opacity(0.35) : Color.white.opacity(0.08)) }
            .frame(maxWidth: 680, alignment: .leading)
            if !message.isUser { Spacer(minLength: 60) }
        }
    }

    private func chip(_ event: ChatEvent) -> some View {
        Text(event.label)
            .font(.system(size: 10, design: .monospaced))
            .lineLimit(1)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(Color.primary.opacity(0.08), in: Capsule())
            .foregroundStyle(event.ok == false ? Color.knodeBad : .secondary)
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextEditor(text: $draft)
                .font(.body)
                .scrollContentBackground(.hidden)
                .padding(6)
                .frame(minHeight: 54, maxHeight: 120)
                .background(Color(nsColor: .textBackgroundColor).opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
                .overlay { RoundedRectangle(cornerRadius: 8).stroke(Color.white.opacity(0.1)) }
                .overlay(alignment: .topLeading) {
                    if draft.isEmpty {
                        Text(L("Ask a question, or “remember: …” to teach the knowledge base"))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 11)
                            .padding(.vertical, 12)
                            .allowsHitTesting(false)
                    }
                }
                .focused($composerFocused)
            VStack(spacing: 6) {
                Button(L("Send")) { Task { await send() } }
                    .buttonStyle(.borderedProminent)
                    .tint(.knodeCyan)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(isAnswering || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if isAnswering {
                    Button(L("Cancel")) { Task { await cancel() } }
                        .font(.system(size: 11))
                }
            }
        }
        .padding(14)
        .background(.bar)
    }

    /* ----------------------------- data ---------------------------------- */

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            conversations = try await model.client().chatConversations()
            errorMessage = nil
            if let id = activeId ?? conversations.first?.id { await open(id) }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func open(_ id: String) async {
        activeId = id
        do {
            let conversation = try await model.client().conversation(id: id)
            thread = conversation
            errorMessage = nil
            if conversation.running == true { startPolling(id) }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func newConversation() async {
        do {
            let conversation = try await model.client().createConversation()
            conversations.insert(conversation, at: 0)
            thread = conversation
            activeId = conversation.id
            composerFocused = true
        } catch {
            model.showToast(L("Could not start a conversation: %@", error.localizedDescription))
        }
    }

    private func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        if activeId == nil { await newConversation() }
        guard let id = activeId else { return }
        draft = ""
        do {
            _ = try await model.client().sendChat(id: id, text: text)
            await open(id)
            startPolling(id)
        } catch {
            draft = text
            model.showToast(L("Send failed: %@", error.localizedDescription))
        }
    }

    private func cancel() async {
        guard let id = activeId else { return }
        _ = try? await model.client().cancelChat(id: id)
        model.showToast(L("Stopping…"))
    }

    private func adopt(_ path: String) async {
        do {
            _ = try await model.client().setTrust(path: path, to: "trusted")
            model.showToast(L("%@ is trusted now", path))
        } catch {
            model.showToast(L("Adopt failed: %@", error.localizedDescription))
        }
    }

    private func remove(_ conversation: ChatConversation) async {
        do {
            _ = try await model.client().deleteConversation(id: conversation.id)
            conversations.removeAll { $0.id == conversation.id }
            if activeId == conversation.id {
                activeId = conversations.first?.id
                thread = nil
                if let next = activeId { await open(next) }
            }
        } catch {
            model.showToast(L("Delete failed: %@", error.localizedDescription))
        }
    }

    private func startPolling(_ id: String) {
        pollTask?.cancel()
        isAnswering = true
        activity = []
        model.globalActivity = L("The agent is answering…")
        pollTask = Task {
            defer {
                isAnswering = false
                activity = []
                model.globalActivity = nil
            }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                if Task.isCancelled || activeId != id { return }
                guard let status = try? await model.client().chatStatus(id: id) else { continue }
                if status.status == "running" {
                    activity = status.activity
                    continue
                }
                await open(id)
                conversations = (try? await model.client().chatConversations()) ?? conversations
                return
            }
        }
    }

    private func shortTime(_ iso: String) -> String {
        iso.knodeDate
    }
}

/// Chips that wrap onto the next line — a tiny flow layout, since SwiftUI has none.
struct FlowRow: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > maxWidth {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: proposal.width ?? x, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
