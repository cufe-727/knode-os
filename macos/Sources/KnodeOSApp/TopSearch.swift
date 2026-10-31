import AppKit
import SwiftUI

/// One row of the search field's panel: the three things to do with the
/// text, then the names and documents that hold it.
enum TopSearchItem: Identifiable, Equatable {
    case search(String)
    case ask(String)
    case research(String)
    case entity(SuggestResponse.Entity)
    case file(SuggestResponse.Document)

    var id: String {
        switch self {
        case .search: "action-search"
        case .ask: "action-ask"
        case .research: "action-research"
        case .entity(let entity): "entity-\(entity.id)"
        case .file(let document): "file-\(document.path)"
        }
    }
}

/**
 * The search field above every screen (docs/design/20 D4) and the panel under
 * it share this: the text, whether the field has the focus, what the service
 * suggested for which text, and the highlighted row.
 *
 * The panel is drawn in the window, not in a popover: a popover takes the key
 * focus from the field the moment it opens.
 */
@MainActor
final class TopSearchModel: ObservableObject {
    @Published private(set) var text = ""
    @Published private(set) var focused = false
    @Published var highlight = 0
    @Published private(set) var suggestions: SuggestResponse?
    /// The text `suggestions` were read for: another text shows none of them.
    @Published private(set) var suggestionsQuery = ""
    /// Kept up a moment after the field lets go of the focus, so a click on a row still lands.
    @Published private var lingering = false

    /// What a chosen row does; the window that holds the field sets it.
    var onActivate: ((TopSearchItem) -> Void)?
    fileprivate weak var field: TopSearchNSField?
    private var lingerTask: Task<Void, Never>?

    var query: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    var showsPanel: Bool { (focused || lingering) && !query.isEmpty }
    /// Names are still being looked up for what was typed.
    var isLookingUp: Bool { !query.isEmpty && suggestionsQuery != query }

    var items: [TopSearchItem] {
        let q = query
        guard !q.isEmpty else { return [] }
        var out: [TopSearchItem] = [.search(q), .ask(q), .research(q)]
        if suggestionsQuery == q, let suggestions {
            out += suggestions.entities.prefix(5).map(TopSearchItem.entity)
            out += suggestions.documents.prefix(5).map(TopSearchItem.file)
        }
        return out
    }

    /// An answer for `q`; dropped when the text has moved on since it was asked.
    func setSuggestions(_ answer: SuggestResponse, for q: String) {
        guard q == query else { return }
        suggestions = answer
        suggestionsQuery = q
        highlight = min(highlight, max(0, items.count - 1))
    }

    fileprivate func textDidChange(_ new: String) {
        guard new != text else { return }
        text = new
        highlight = 0
    }

    fileprivate func focusChanged(_ isFocused: Bool) {
        lingerTask?.cancel()
        focused = isFocused
        guard !isFocused else {
            lingering = false
            return
        }
        lingering = true
        lingerTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled else { return }
            self?.lingering = false
        }
    }

    func move(_ delta: Int) {
        let n = items.count
        guard n > 0 else { return }
        highlight = ((highlight + delta) % n + n) % n
    }

    /// ↩: the highlighted row — Search, until another is picked.
    func activateHighlighted() {
        let list = items
        guard !list.isEmpty else { return }
        activate(list[min(highlight, list.count - 1)])
    }

    /// ⌘↩ and ⌥↩: Ask or Research the text, whatever is highlighted.
    fileprivate func activateAction(_ make: (String) -> TopSearchItem) {
        let q = query
        guard !q.isEmpty else { return }
        activate(make(q))
    }

    func activate(_ item: TopSearchItem) {
        endEditing()
        lingerTask?.cancel()
        lingering = false
        // a file opens beside the text, which stays for the next one; the rest is done with it
        if case .file = item {} else { setText("") }
        onActivate?(item)
    }

    /// ⌘K: the field, its text selected so typing replaces it. A click
    /// leaves the caret where the click put it.
    func focus(selectingAll: Bool = true) {
        guard let field, let window = field.window else { return }
        if field.currentEditor() == nil || window.firstResponder !== field.currentEditor() {
            window.makeFirstResponder(field)
        }
        if selectingAll { field.currentEditor()?.selectAll(nil) }
    }

    func endEditing() {
        guard let field, let window = field.window, field.currentEditor() != nil else { return }
        window.makeFirstResponder(nil)
    }

    /// ⎋: the text first, then the focus.
    fileprivate func cancel() {
        if text.isEmpty { endEditing() } else { setText("") }
    }

    func clear() {
        setText("")
        focus()
    }

    private func setText(_ value: String) {
        text = value
        highlight = 0
        guard let field else { return }
        // while it edits, the field editor holds the text, and it would write the old one back when editing ends
        if let editor = field.currentEditor() { editor.string = value }
        field.stringValue = value
    }
}

/// The field in the toolbar's centre.
struct TopSearchField: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject var search: TopSearchModel
    var width: CGFloat

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(search.focused ? Color.knodeCyan : Color.secondary)
            TopSearchTextField(search: search, placeholder: L("Search, ask, or research…"))
                .frame(height: 20)
            if search.text.isEmpty {
                Text("⌘K")
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .overlay { RoundedRectangle(cornerRadius: 4).stroke(Color.secondary.opacity(0.35)) }
                    .help(L("⌘K puts the cursor here from anywhere"))
            } else {
                Button { search.clear() } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
                .help(L("Clear"))
            }
        }
        .padding(.leading, 10)
        .padding(.trailing, 8)
        .frame(width: width, height: 30)
        // nearly a capsule: a radius of half the height leaves zero-length
        // sides, which some renderers stroke as stray ticks at the ends
        .background(RoundedRectangle(cornerRadius: 14).fill(Color.primary.opacity(search.focused ? 0.09 : 0.055)))
        // inside the edge: the toolbar item clips anything drawn past its frame
        .overlay { RoundedRectangle(cornerRadius: 14).strokeBorder(search.focused ? Color.knodeCyan.opacity(0.7) : Color.primary.opacity(0.13)) }
        .contentShape(RoundedRectangle(cornerRadius: 14))
        // the padding around the text: a click there is a click in the field
        .onTapGesture { if !search.focused { search.focus(selectingAll: false) } }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L("Search, ask, or research"))
        // names and documents as someone types: substring reads, no model,
        // a moment after the last key, and only the latest answer counts
        .task(id: search.query) {
            let q = search.query
            guard !q.isEmpty else { return }
            try? await Task.sleep(nanoseconds: 150_000_000)
            guard !Task.isCancelled else { return }
            let answer = (try? await model.client().suggest(q, limit: 5)) ?? .empty
            guard !Task.isCancelled else { return }
            search.setSuggestions(answer, for: q)
        }
    }
}

/// The suggestions under the toolbar, over the screen, while the field is
/// focused and holds text. A click anywhere else closes it.
struct TopSearchOverlay: View {
    @ObservedObject var search: TopSearchModel
    var width: CGFloat

    var body: some View {
        if search.showsPanel {
            ZStack(alignment: .top) {
                Color.clear
                    .contentShape(Rectangle())
                    .onTapGesture { search.endEditing() }
                TopSearchPanel(search: search)
                    .frame(width: width)
                    .padding(.top, 8)
            }
            .transition(.opacity)
        }
    }
}

private struct TopSearchPanel: View {
    @ObservedObject var search: TopSearchModel

    var body: some View {
        let items = search.items
        VStack(alignment: .leading, spacing: 1) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                if let heading = heading(before: index, in: items) {
                    Text(heading.uppercased())
                        .font(.system(size: 9.5, weight: .bold, design: .monospaced))
                        .tracking(1.1)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 10)
                        .padding(.top, 9)
                        .padding(.bottom, 3)
                }
                row(item, index: index)
            }
            if search.isLookingUp {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text(L("Looking up names…")).font(.caption).foregroundStyle(.secondary)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
            } else if items.count == 3 {
                Text(L("No entity or document by that name."))
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
            }
        }
        .padding(6)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        .overlay { RoundedRectangle(cornerRadius: 12).stroke(Color.primary.opacity(0.13)) }
        .shadow(color: .black.opacity(0.28), radius: 18, y: 8)
    }

    /// "Entities" over the first name, "Files" over the first document.
    private func heading(before index: Int, in items: [TopSearchItem]) -> String? {
        func group(_ item: TopSearchItem) -> String? {
            switch item {
            case .entity: L("Entities")
            case .file: L("Files")
            default: nil
            }
        }
        guard let mine = group(items[index]) else { return nil }
        return index > 0 && group(items[index - 1]) == mine ? nil : mine
    }

    private func row(_ item: TopSearchItem, index: Int) -> some View {
        Button { search.activate(item) } label: {
            HStack(spacing: 9) {
                label(item)
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 7)
                    .fill(index == search.highlight ? Color.knodeCyan.opacity(0.2) : Color.clear)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { inside in if inside { search.highlight = index } }
    }

    private func quoted(_ q: String) -> String {
        q.count > 48 ? String(q.prefix(48)) + "…" : q
    }

    @ViewBuilder
    private func label(_ item: TopSearchItem) -> some View {
        switch item {
        case .search(let q):
            action(symbol: "magnifyingglass", color: .knodeCyan, title: L("Search “%@”", quoted(q)), hint: L("passages, entities and relations"), key: "↩")
        case .ask(let q):
            action(symbol: "sparkles", color: .knodeViolet, title: L("Ask “%@”", quoted(q)), hint: L("an agent answers from this workspace"), key: "⌘↩")
        case .research(let q):
            action(symbol: "doc.text.magnifyingglass", color: .orange, title: L("Research “%@”", quoted(q)), hint: L("plan a study — you review it before it runs"), key: "⌥↩")
        case .entity(let entity):
            Circle()
                .fill(nodeColor(entity.type))
                .frame(width: 8, height: 8)
                .frame(width: 18)
            HStack(spacing: 5) {
                Text(entity.name).font(.system(size: 12.5, weight: .semibold)).lineLimit(1)
                if let alias = entity.alias {
                    Text("· \(alias)").font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            Text("\(entity.type) · \(entity.mentionCount.formatted())")
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundStyle(.secondary)
                .help(L("Search for its exact name"))
        case .file(let document):
            Image(systemName: "doc.text")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 1) {
                Text(document.title?.isEmpty == false ? document.title! : (document.path as NSString).lastPathComponent)
                    .font(.system(size: 12.5, weight: .medium))
                    .lineLimit(1)
                Text(document.path)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private func action(symbol: String, color: Color, title: String, hint: String, key: String) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(color)
            .frame(width: 18)
        Text(title)
            .font(.system(size: 12.5, weight: .semibold))
            .lineLimit(1)
            .layoutPriority(1)
        Text(hint)
            .font(.system(size: 11.5))
            .foregroundStyle(.secondary)
            .lineLimit(1)
        Spacer(minLength: 8)
        Text(key)
            .font(.system(size: 10.5, weight: .medium))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .overlay { RoundedRectangle(cornerRadius: 4).stroke(Color.secondary.opacity(0.35)) }
    }
}

/// An AppKit text field under the SwiftUI chrome: it says exactly when it
/// has the focus, and its keys arrive as commands after the input method had
/// them — ↑ ↓ ↩ ⎋ never reach the list while Pinyin is still composing.
private struct TopSearchTextField: NSViewRepresentable {
    @ObservedObject var search: TopSearchModel
    var placeholder: String

    func makeCoordinator() -> Coordinator { Coordinator(search: search) }

    func makeNSView(context: Context) -> TopSearchNSField {
        let field = TopSearchNSField()
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.font = .systemFont(ofSize: 13)
        field.lineBreakMode = .byTruncatingTail
        field.usesSingleLineMode = true
        field.cell?.wraps = false
        field.cell?.isScrollable = true
        field.placeholderString = placeholder
        field.stringValue = search.text
        field.delegate = context.coordinator
        field.setContentHuggingPriority(.defaultLow, for: .horizontal)
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        field.onFocus = { [weak search] focused in search?.focusChanged(focused) }
        search.field = field
        context.coordinator.installMonitor(for: field)
        return field
    }

    func updateNSView(_ field: TopSearchNSField, context: Context) {
        if field.placeholderString != placeholder { field.placeholderString = placeholder }
        context.coordinator.search = search
        search.field = field
    }

    static func dismantleNSView(_ field: TopSearchNSField, coordinator: Coordinator) {
        coordinator.removeMonitor()
    }

    @MainActor
    final class Coordinator: NSObject, NSTextFieldDelegate {
        var search: TopSearchModel
        private var monitor: Any?

        init(search: TopSearchModel) {
            self.search = search
        }

        func controlTextDidChange(_ notification: Notification) {
            guard let field = notification.object as? NSTextField else { return }
            search.textDidChange(field.stringValue)
        }

        func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            switch selector {
            case #selector(NSResponder.moveUp(_:)):
                search.move(-1)
                return true
            case #selector(NSResponder.moveDown(_:)):
                search.move(1)
                return true
            case #selector(NSResponder.insertNewline(_:)):
                let flags = NSApp.currentEvent?.modifierFlags.intersection(.deviceIndependentFlagsMask) ?? []
                if flags.contains(.command) {
                    search.activateAction(TopSearchItem.ask)
                } else if flags.contains(.option) {
                    search.activateAction(TopSearchItem.research)
                } else {
                    search.activateHighlighted()
                }
                return true
            case #selector(NSResponder.insertNewlineIgnoringFieldEditor(_:)):
                search.activateAction(TopSearchItem.research)
                return true
            case #selector(NSResponder.cancelOperation(_:)):
                search.cancel()
                return true
            default:
                return false
            }
        }

        /// ⌘↩ and ⌥↩ are taken before any key equivalent can be — Ask's own
        /// ⌘↩ would otherwise send whatever its composer holds.
        func installMonitor(for field: TopSearchNSField) {
            removeMonitor()
            monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self, weak field] event in
                guard let field, event.window === field.window, event.keyCode == 36 || event.keyCode == 76 else { return event }
                let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
                guard flags.contains(.command) || flags.contains(.option) else { return event }
                let handled = MainActor.assumeIsolated { () -> Bool in
                    guard let self, let editor = field.currentEditor() as? NSTextView,
                          field.window?.firstResponder === editor, !editor.hasMarkedText() else { return false }
                    if flags.contains(.command) {
                        self.search.activateAction(TopSearchItem.ask)
                    } else {
                        self.search.activateAction(TopSearchItem.research)
                    }
                    return true
                }
                return handled ? nil : event
            }
        }

        func removeMonitor() {
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
        }
    }
}

/// The text field, telling when it takes the focus and when editing ends.
final class TopSearchNSField: NSTextField {
    var onFocus: (@MainActor (Bool) -> Void)?

    override func becomeFirstResponder() -> Bool {
        let accepted = super.becomeFirstResponder()
        if accepted { onFocus?(true) }
        return accepted
    }

    override func textDidEndEditing(_ notification: Notification) {
        super.textDidEndEditing(notification)
        onFocus?(false)
    }
}
