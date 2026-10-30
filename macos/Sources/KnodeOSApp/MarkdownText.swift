import SwiftUI

/// Renders Markdown as native views.
///
/// Three things keep a large document from stalling the window, and all three
/// matter — a 260 KB preview parses into ~2,000 blocks:
///
///   * The parse (and the `AttributedString` conversion of every inline run)
///     happens once per document in `.task`, not on every body pass. It used to
///     sit inside `body`, so each unrelated state change — an upload's progress
///     ticking, expanding a tree row, a toast — paid ~40 ms to redo it.
///   * Big documents parse off the main actor, so the window keeps drawing.
///   * `LazyVStack` lays out only what the viewport shows. A plain `VStack`
///     inside a `ScrollView` is eager: it forced Core Text through all ~2,000
///     blocks (~230 ms, a 43,000 pt tall stack) before the first frame, and
///     again on every rebuild.
///
/// A page's own parts are read as well. The YAML frontmatter folds into a
/// metadata panel with a one-line summary. GFM footnotes — `[^1]` in the text,
/// `[^1]: …` below — become superscript markers that jump to a list of notes,
/// one per line, each with a way back. An export's `<a id="…"></a>` lines are
/// places a link can land on, and a workspace path written as code (`raw/…`)
/// opens its file. A page whose frontmatter says `type: MindMap` is drawn as
/// the tree its outline holds (MarkdownMindMap.swift). The entity names the
/// service found in the text (`mentions`) are marked in their type's colour
/// and open the entity panel.
struct MarkdownText: View {
    let markdown: String
    var mentions: [EntityMention]
    /// A place to bring into view, cleared once shown.
    @Binding var scrollTarget: MarkdownScrollTarget?
    /// The picture the page was read from, by workspace path: a mind map shows it under itself.
    var picture: String?
    /// An entity id, and the block whose text named it.
    var onOpenEntity: ((String, Int?) -> Void)?
    /// A wikilink or workspace path to follow, and the block it sits in: where a way back returns to.
    var onOpenKnowledgeLink: ((String, Int?) -> Void)?

    /// Documents this short parse inline on the main actor: the work is under a
    /// millisecond and a detached hop would flash an empty answer.
    private static let asyncParseThreshold = 20_000

    @AppStorage("knode-os.markdown.metadataExpanded") private var metadataExpanded = false
    @State private var document = MarkdownDocument.empty
    /// The parse with the mentions marked: what the view draws.
    @State private var blocks: [MarkdownBlock] = []
    @State private var markedWith: [EntityMention] = []
    /// Blocks lit up after a jump, and which jump lit them.
    @State private var flashed: Set<Int> = []
    @State private var flashGeneration = 0

    init(
        markdown: String,
        mentions: [EntityMention] = [],
        scrollTarget: Binding<MarkdownScrollTarget?> = .constant(nil),
        picture: String? = nil,
        onOpenEntity: ((String, Int?) -> Void)? = nil,
        onOpenKnowledgeLink: ((String, Int?) -> Void)? = nil
    ) {
        self.markdown = markdown
        self.mentions = mentions
        _scrollTarget = scrollTarget
        self.picture = picture
        self.onOpenEntity = onOpenEntity
        self.onOpenKnowledgeLink = onOpenKnowledgeLink
    }

    private struct RenderKey: Equatable {
        let markdown: String
        let mentions: [EntityMention]
    }

    var body: some View {
        ScrollViewReader { proxy in
            LazyVStack(alignment: .leading, spacing: 13) {
                ForEach(blocks) { block in
                    blockView(block)
                        .background {
                            RoundedRectangle(cornerRadius: 6)
                                .fill(Color.knodeCyan.opacity(flashed.contains(block.id) ? 0.16 : 0))
                                .padding(-5)
                        }
                        .id(block.id)
                }
            }
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .environment(\.openURL, OpenURLAction { url in open(url, proxy) })
            .task(id: RenderKey(markdown: markdown, mentions: mentions)) {
                await render()
                reveal(scrollTarget, proxy)
            }
            .onChange(of: scrollTarget) { _, target in reveal(target, proxy) }
        }
    }

    private func render() async {
        let source = markdown
        let marks = mentions
        guard document.source != source || markedWith != marks || blocks.count != document.blocks.count else { return }
        let reparse = document.source != source
        if source.count <= Self.asyncParseThreshold {
            if reparse { document = MarkdownDocument(source: source) }
            blocks = document.marking(marks)
        } else {
            let current = document
            let (parsed, marked) = await Task.detached(priority: .userInitiated) {
                let parsed = reparse ? MarkdownDocument(source: source) : current
                return (parsed, parsed.marking(marks))
            }.value
            guard !Task.isCancelled else { return }
            document = parsed
            blocks = marked
        }
        markedWith = marks
    }

    /// The links the view answers itself — a note, the way back from one, an entity — and the in-app ones it hands up.
    private func open(_ url: URL, _ proxy: ScrollViewProxy) -> OpenURLAction.Result {
        switch url.scheme {
        case MarkdownLink.note:
            guard let label = MarkdownLink.value(url, "label"), let id = document.noteBlocks[label] else { return .discarded }
            jump(to: [id], proxy, anchor: .center)
            return .handled
        case MarkdownLink.noteBack:
            guard let label = MarkdownLink.value(url, "label"), let id = document.citingBlocks[label] else { return .discarded }
            jump(to: [id], proxy, anchor: .center)
            return .handled
        case MarkdownLink.entity:
            guard let id = MarkdownLink.value(url, "id"), let onOpenEntity else { return .discarded }
            onOpenEntity(id, MarkdownLink.value(url, "from").flatMap { Int($0) })
            return .handled
        default:
            guard let target = inAppTarget(from: url), let onOpenKnowledgeLink else { return .systemAction }
            onOpenKnowledgeLink(target, MarkdownLink.value(url, "from").flatMap { Int($0) })
            return .handled
        }
    }

    /// Bring a place into view and light it up: an export's entry up to the next one, a heading, or a block a way back returns to.
    private func reveal(_ target: MarkdownScrollTarget?, _ proxy: ScrollViewProxy) {
        guard let target, document.source == markdown, blocks.count == document.blocks.count else { return }
        switch target {
        case .fragment(let fragment):
            if let entry = document.entry(at: fragment) {
                jump(to: entry, proxy, anchor: .top)
            } else if let heading = document.heading(named: fragment) {
                jump(to: [heading], proxy, anchor: .top)
            }
        case .block(let id):
            if blocks.indices.contains(id) { jump(to: [id], proxy, anchor: .center) }
        }
        scrollTarget = nil
    }

    private func jump(to ids: [Int], _ proxy: ScrollViewProxy, anchor: UnitPoint) {
        guard let first = ids.first else { return }
        proxy.scrollTo(first, anchor: anchor)
        flashGeneration += 1
        let generation = flashGeneration
        flashed = Set(ids)
        Task {
            try? await Task.sleep(for: .seconds(1.3))
            guard flashGeneration == generation else { return }
            withAnimation(.easeOut(duration: 0.6)) { flashed = [] }
        }
    }

    @ViewBuilder
    private func blockView(_ block: MarkdownBlock) -> some View {
        switch block.kind {
        case .heading(let level, let text):
            Text(text)
                .font(headingFont(level))
                .padding(.top, level <= 2 ? 8 : 3)
        case .paragraph(let text):
            Text(text)
                .lineSpacing(4)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .unordered(let items):
            VStack(alignment: .leading, spacing: 7) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 9) {
                        // a nested item's bullet is hollow, as a printed list's second level
                        if item.level == 0 {
                            Circle().fill(Color.secondary).frame(width: 5, height: 5)
                        } else {
                            Circle().stroke(Color.secondary, lineWidth: 1).frame(width: 5, height: 5)
                        }
                        Text(item.text).frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(.leading, CGFloat(item.level) * 20)
                }
            }
            .padding(.leading, 8)
        case .ordered(let items):
            VStack(alignment: .leading, spacing: 7) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 9) {
                        Text("\(item.number).")
                            .font(.system(.body, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .frame(width: 24, alignment: .trailing)
                        Text(item.text).frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(.leading, CGFloat(item.level) * 20)
                }
            }
        case .quote(let text):
            Text(text)
                .foregroundStyle(.secondary)
                .italic()
                .padding(.leading, 12)
                .overlay(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 1).fill(Color.knodeViolet.opacity(0.7)).frame(width: 3)
                }
        case .table(let table):
            MarkdownTableView(table: table)
        case .code(let code, let language) where language?.lowercased() == "chart" && ChartSpec.parse(code) != nil:
            // a research page's chart: data in the page, drawn here (MarkdownChart.swift)
            MarkdownChart(spec: ChartSpec.parse(code)!)
        case .mindMap(let map):
            // its folds and modes belong to this outline: another page starts afresh
            MarkdownMindMap(map: map, picture: picture)
                .id(map.signature)
        case .code(let code, let language):
            ScrollView(.horizontal) {
                Text(code)
                    .font(.system(size: 12, design: .monospaced))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
            }
            .background(Color.black.opacity(0.28), in: RoundedRectangle(cornerRadius: 8))
            .overlay(alignment: .topTrailing) {
                if let language, !language.isEmpty {
                    Text(language.uppercased())
                        .font(.system(size: 8, weight: .bold, design: .monospaced))
                        .foregroundStyle(.tertiary)
                        .padding(8)
                }
            }
        case .frontmatter(let meta):
            frontmatterView(meta)
        case .note(let note):
            HStack(alignment: .firstTextBaseline, spacing: 9) {
                Text("[\(note.number)]")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(Color.knodeCyan)
                    .frame(width: 36, alignment: .leading)
                Text(note.text)
                    .font(.system(size: 12.5))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            // the list reads as one block: the stack's spacing is for paragraphs
            .padding(.vertical, -4)
        case .anchor:
            Color.clear
                .frame(height: 0)
                .padding(.bottom, -13)
        case .rule:
            Divider().padding(.vertical, 3)
        }
    }

    /// Folded unless asked: a page's metadata can run to a hundred lines before its first sentence.
    private func frontmatterView(_ meta: MarkdownBlock.Frontmatter) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeOut(duration: 0.15)) { metadataExpanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(Color.knodeViolet)
                        .rotationEffect(.degrees(metadataExpanded ? 90 : 0))
                    Eyebrow(text: L("Metadata"), color: .knodeViolet)
                    Text(meta.summary)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 11)
                .padding(.vertical, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(metadataExpanded ? L("Fold the metadata") : L("Show the metadata"))
            if metadataExpanded {
                Divider().opacity(0.6)
                Text(meta.body)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineSpacing(2)
                    .padding(11)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.knodeViolet.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: .system(size: 28, weight: .bold)
        case 2: .system(size: 22, weight: .bold)
        case 3: .system(size: 18, weight: .semibold)
        default: .system(size: 15, weight: .semibold)
        }
    }

    private func inAppTarget(from url: URL) -> String? {
        if url.scheme == MarkdownLink.wiki { return MarkdownLink.value(url, "target") }
        if url.scheme == nil {
            return url.relativeString.removingPercentEncoding ?? url.relativeString
        }
        return nil
    }
}

/**
 * A GFM table: a header, then the rows, in a grid whose columns size to their
 * widest cell. A cell of a sentence or more wraps at a fixed width instead of
 * widening its column; a table wider than the page scrolls sideways. Numbers
 * line up on the right, as in a printed table, unless the delimiter row says
 * otherwise.
 */
private struct MarkdownTableView: View {
    let table: MarkdownBlock.Table

    /// Past this many characters a cell wraps: a column of short labels stays one line each.
    private static let wrapAfter = 48
    private static let wrapWidth: CGFloat = 300

    var body: some View {
        ScrollView(.horizontal) {
            Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(Array(table.header.enumerated()), id: \.offset) { column, text in
                        cell(text, column: column)
                            .font(.system(size: 12.5, weight: .semibold))
                            .gridColumnAlignment(table.alignments[column].horizontal)
                    }
                }
                Rectangle().fill(Color.primary.opacity(0.22)).frame(height: 1)
                ForEach(Array(table.rows.enumerated()), id: \.offset) { index, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { column, text in
                            cell(text, column: column).font(.system(size: 12.5))
                        }
                    }
                    if index < table.rows.count - 1 {
                        Rectangle().fill(Color.primary.opacity(0.08)).frame(height: 1)
                    }
                }
            }
            .padding(.vertical, 2)
        }
        .scrollIndicators(.automatic, axes: .horizontal)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L("Table, %@ columns, %@ rows", String(table.header.count), String(table.rows.count)))
    }

    @ViewBuilder
    private func cell(_ text: AttributedString, column: Int) -> some View {
        let alignment = table.alignments[column]
        Group {
            if text.characters.count > Self.wrapAfter {
                Text(text)
                    .multilineTextAlignment(alignment.text)
                    .frame(width: Self.wrapWidth, alignment: alignment.frame)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text(text).fixedSize()
            }
        }
        .monospacedDigit()
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }
}

/// How a table column lines up its cells.
enum CellAlignment {
    case leading, center, trailing

    var horizontal: HorizontalAlignment {
        switch self {
        case .leading: .leading
        case .center: .center
        case .trailing: .trailing
        }
    }

    var frame: Alignment {
        switch self {
        case .leading: .leading
        case .center: .center
        case .trailing: .trailing
        }
    }

    var text: TextAlignment {
        switch self {
        case .leading: .leading
        case .center: .center
        case .trailing: .trailing
        }
    }
}

/// A place in a Markdown view to bring into view.
enum MarkdownScrollTarget: Equatable {
    /// A link's #fragment: an export's entry anchor, or a heading's text.
    case fragment(String)
    /// A block of the document, by id: where a way back returns to.
    case block(Int)
}

/* ------------------------------ links ------------------------------ */

/// The app's own links a Markdown view writes into its text and answers itself.
private enum MarkdownLink {
    /// A wikilink or a workspace path: the file view resolves it.
    static let wiki = "knode-wiki"
    /// A footnote marker: jumps to its note.
    static let note = "knode-note"
    /// A note's ↩: back to the first place the text cites it.
    static let noteBack = "knode-noteback"
    /// A marked entity name: opens the entity panel.
    static let entity = "knode-entity"

    /// The link with its query; an item without a value is left out.
    static func url(_ scheme: String, _ items: (name: String, value: String?)...) -> URL? {
        var components = URLComponents()
        components.scheme = scheme
        components.host = "open"
        components.queryItems = items.compactMap { item in item.value.map { URLQueryItem(name: item.name, value: $0) } }
        return components.url
    }

    static func value(_ url: URL, _ name: String) -> String? {
        URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == name })?.value
    }

    /// `[label](<url>)` as Markdown source: the label's brackets escaped, the
    /// destination in angle brackets so parentheses in a name cannot end it.
    static func markdown(label: String, url: URL?) -> String? {
        guard let url else { return nil }
        let escaped = label
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "[", with: "\\[")
            .replacingOccurrences(of: "]", with: "\\]")
        return "[\(escaped)](<\(url.absoluteString)>)"
    }
}

/// A file in the workspace as a page names it: a path under raw/ or wiki/, maybe with an #anchor.
private func isWorkspacePath(_ text: String) -> Bool {
    text.range(of: #"^(?:raw|wiki)/[^\s`"'<>]+$"#, options: .regularExpression) != nil
}

/// A long path shows its last two parts; the link still carries all of it.
private func shortPath(_ path: String) -> String {
    let parts = path.split(separator: "/", omittingEmptySubsequences: false)
    return parts.count > 3 ? "…/" + parts.suffix(2).joined(separator: "/") : path
}

/// An Obsidian wikilink as a Markdown link SwiftUI can activate.
private func wikiMarkdownLink(destination: String, customLabel: String?, block: Int?) -> String? {
    let label: String
    if let customLabel, !customLabel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        label = customLabel.trimmingCharacters(in: .whitespacesAndNewlines)
    } else {
        let parts = destination.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false)
        let note = String(parts[0]).replacingOccurrences(of: "\\", with: "/")
        let filename = note.split(separator: "/").last.map(String.init) ?? ""
        let noteName: String
        if filename.lowercased().hasSuffix(".markdown") { noteName = String(filename.dropLast(9)) }
        else if filename.lowercased().hasSuffix(".md") { noteName = String(filename.dropLast(3)) }
        else { noteName = filename }
        label = noteName.isEmpty && parts.count > 1 ? String(parts[1]) : noteName
    }
    return MarkdownLink.markdown(label: label, url: MarkdownLink.url(MarkdownLink.wiki, ("target", destination), ("from", block.map(String.init))))
}

/**
 * One run of inline text as the Markdown SwiftUI parses, with the app's links
 * written in: wikilinks, footnote markers (numbered by `notes`, label →
 * number; a marker without a note stays as written) and workspace paths in
 * code spans. Other code spans are copied untouched. A link that leaves the
 * file carries `block`, the block it sits in, for the way back.
 */
private func inlineSource(_ source: String, notes: [String: Int], block: Int?) -> String {
    var output = ""
    var cursor = source.startIndex

    while cursor < source.endIndex {
        let rest = source[cursor...]

        if rest.hasPrefix("`") {
            let ticks = String(rest.prefix(while: { $0 == "`" }))
            let contentStart = source.index(cursor, offsetBy: ticks.count)
            guard let close = source.range(of: ticks, range: contentStart..<source.endIndex) else {
                output += ticks
                cursor = contentStart
                continue
            }
            let code = source[contentStart..<close.lowerBound].trimmingCharacters(in: .whitespaces)
            if isWorkspacePath(code), let link = MarkdownLink.markdown(label: "`\(shortPath(code))`", url: MarkdownLink.url(MarkdownLink.wiki, ("target", code), ("from", block.map(String.init)))) {
                output += link
            } else {
                output += source[cursor..<close.upperBound]
            }
            cursor = close.upperBound
            continue
        }

        if rest.hasPrefix("[^"), let close = rest.firstIndex(of: "]") {
            let label = String(rest[rest.index(rest.startIndex, offsetBy: 2)..<close])
            if !label.isEmpty, !label.contains(where: \.isWhitespace), let number = notes[label],
               let link = MarkdownLink.markdown(label: "[\(number)]", url: MarkdownLink.url(MarkdownLink.note, ("label", label))) {
                output += link
                cursor = source.index(after: close)
                continue
            }
        }

        let markerLength = rest.hasPrefix("![[") ? 3 : rest.hasPrefix("[[") ? 2 : 0
        if markerLength > 0 {
            let contentStart = source.index(cursor, offsetBy: markerLength)
            if let close = source.range(of: "]]", range: contentStart..<source.endIndex) {
                let inner = String(source[contentStart..<close.lowerBound])
                let fields = inner.split(separator: "|", maxSplits: 1, omittingEmptySubsequences: false)
                let destination = fields.first.map(String.init)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if !destination.isEmpty, let link = wikiMarkdownLink(destination: destination, customLabel: fields.count > 1 ? String(fields[1]) : nil, block: block) {
                    output += link
                } else {
                    output += source[cursor..<close.upperBound]
                }
                cursor = close.upperBound
                continue
            }
        }

        output.append(source[cursor])
        cursor = source.index(after: cursor)
    }

    return output
}

/// The labels a run of text cites, in order, outside code spans.
private func noteLabels(in text: String) -> [String] {
    guard text.contains("[^") else { return [] }
    let prose = text.replacingOccurrences(of: #"`+[^`]*`+"#, with: "", options: .regularExpression)
    return prose.matches(of: #/\[\^([^\]\s]+)\]/#).map { String($0.output.1) }
}

private func inlineMarkdown(_ text: String, notes: [String: Int] = [:], block: Int? = nil) -> AttributedString {
    var attributed = (try? AttributedString(
        markdown: inlineSource(text, notes: notes, block: block),
        options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)
    )) ?? AttributedString(text)
    // a footnote marker sits above the line, small, like a printed one
    let markers = attributed.runs.filter { $0.link?.scheme == MarkdownLink.note }.map(\.range)
    for range in markers {
        attributed[range].font = .system(size: 10, weight: .medium, design: .monospaced)
        attributed[range].baselineOffset = 5
    }
    return attributed
}

/* --------------------------- the document --------------------------- */

/// A parsed document, kept whole so a view can tell at a glance whether the
/// blocks it holds still belong to the Markdown it was handed, with where its
/// notes, the text citing them and its anchors sit, for the jumps between them.
private struct MarkdownDocument {
    let source: String
    let blocks: [MarkdownBlock]
    /// Note label → the block showing it in the list of notes.
    let noteBlocks: [String: Int]
    /// Note label → the first block whose text cites it.
    let citingBlocks: [String: Int]
    /// Anchor name → its block.
    let anchors: [String: Int]

    static let empty = MarkdownDocument(source: "", parsed: ParsedMarkdown())

    init(source: String) {
        self.init(source: source, parsed: parseMarkdown(source))
    }

    private init(source: String, parsed: ParsedMarkdown) {
        self.source = source
        blocks = parsed.blocks
        noteBlocks = parsed.noteBlocks
        citingBlocks = parsed.citingBlocks
        anchors = parsed.anchors
    }

    /// The blocks of the entry an anchor starts, up to the next anchor or rule — one post of an export.
    func entry(at name: String) -> [Int]? {
        guard let start = anchors[name] else { return nil }
        var ids: [Int] = []
        for block in blocks[(start + 1)...] {
            if case .anchor = block.kind { break }
            if case .rule = block.kind { break }
            ids.append(block.id)
        }
        return ids.isEmpty ? [start] : ids
    }

    /// A heading whose text, or its text with dashes for spaces, is the fragment.
    func heading(named fragment: String) -> Int? {
        let wanted = fragment.trimmingCharacters(in: .whitespaces).lowercased()
        return blocks.first { block in
            guard case .heading(_, let text) = block.kind else { return false }
            let plain = String(text.characters).trimmingCharacters(in: .whitespaces).lowercased()
            return plain == wanted || plain.replacingOccurrences(of: " ", with: "-") == wanted
        }?.id
    }

    /**
     * The blocks with the entities' names made links to the entity panel, in
     * their type's colour: the first mention of each per section, and only in
     * running text — headings, links, code, notes and metadata stay as they are.
     */
    func marking(_ mentions: [EntityMention]) -> [MarkdownBlock] {
        let matcher = MentionMatcher(mentions)
        guard !matcher.isEmpty else { return blocks }
        var seen: [Int: Set<String>] = [:]
        return blocks.map { block in
            guard block.markable else { return block }
            var section = seen[block.section] ?? []
            let kind: MarkdownBlock.Kind
            switch block.kind {
            case .paragraph(let text): kind = .paragraph(matcher.mark(text, in: block.id, seen: &section))
            case .quote(let text): kind = .quote(matcher.mark(text, in: block.id, seen: &section))
            case .unordered(let items): kind = .unordered(items.map { $0.with(matcher.mark($0.text, in: block.id, seen: &section)) })
            case .ordered(let items): kind = .ordered(items.map { $0.with(matcher.mark($0.text, in: block.id, seen: &section)) })
            case .mindMap(let map): kind = .mindMap(map.marking { matcher.mark($0, in: block.id, seen: &section) })
            default: kind = block.kind
            }
            seen[block.section] = section
            return MarkdownBlock(id: block.id, kind: kind, section: block.section, markable: true)
        }
    }
}

private struct MarkdownBlock: Identifiable {
    /// Inline runs arrive already converted: `AttributedString(markdown:)` is
    /// the costliest step per block, and doing it in `body` meant redoing it
    /// for the whole document on every render.
    enum Kind {
        case heading(Int, AttributedString)
        case paragraph(AttributedString)
        case unordered([ListItem])
        case ordered([ListItem])
        case quote(AttributedString)
        case code(String, String?)
        case table(Table)
        case frontmatter(Frontmatter)
        /// A `type: MindMap` page's outline, drawn as its tree.
        case mindMap(MindMapFigure)
        case note(Note)
        /// An export's `<a id="…"></a>`: nothing to see, somewhere to land.
        case anchor(String)
        case rule
    }

    struct Frontmatter {
        /// `person · claims 5 · sources 87`, or how many lines there are.
        let summary: String
        /// The YAML as written, its wikilinks and workspace paths made links.
        let body: AttributedString
    }

    struct Table {
        let header: [AttributedString]
        /// Every row as wide as the header: a short one padded, a long one cut.
        let rows: [[AttributedString]]
        /// Per column: as the delimiter row says, else trailing for a column of numbers.
        let alignments: [CellAlignment]
    }

    struct Note {
        let number: Int
        let label: String
        /// The note, ending in a ↩ back to the text when the text cites it.
        let text: AttributedString
    }

    struct ListItem {
        /// 0 for a top-level item, 1 for one nested under it, and so on.
        let level: Int
        /// An ordered item's number, counted among its siblings.
        let number: Int
        let text: AttributedString

        func with(_ text: AttributedString) -> ListItem {
            ListItem(level: level, number: number, text: text)
        }
    }

    let id: Int
    let kind: Kind
    /// Headings down to level 3 start a new one: an entity is marked once per section.
    let section: Int
    /// Running text, where entity names are marked.
    let markable: Bool
}

/// What one parse produces: the blocks and the places the view jumps between.
private struct ParsedMarkdown {
    var blocks: [MarkdownBlock] = []
    var noteBlocks: [String: Int] = [:]
    var citingBlocks: [String: Int] = [:]
    var anchors: [String: Int] = [:]
}

/// A block before its inline text is converted: the notes have to be numbered first.
private enum RawBlock {
    case heading(Int, String)
    case paragraph(String)
    case unordered([RawListItem])
    case ordered([RawListItem])
    case quote(String)
    case code(String, String?)
    case table(RawTable)
    case anchor(String)
    case note(label: String, text: String)
    case rule
}

/// A table before its cells are converted.
private struct RawTable {
    let header: [String]
    let rows: [[String]]
    /// What the delimiter row asks of each column; nil where it names no alignment.
    let alignments: [CellAlignment?]
}

/// A list item before its text is converted.
private struct RawListItem {
    let level: Int
    let number: Int
    let text: String
}

/// Leading spaces, a tab counting four.
private func indentation(of line: String) -> Int {
    line.prefix(while: { $0 == " " || $0 == "\t" }).reduce(0) { $0 + ($1 == "\t" ? 4 : 1) }
}

/// A list's items with their nesting levels: the distinct indents, ranked, so
/// two-space and four-space lists nest the same. An ordered item is numbered
/// among the siblings since its parent.
private func nested(_ items: [(indent: Int, text: String)]) -> [RawListItem] {
    let indents = Array(Set(items.map(\.indent))).sorted()
    var counts: [Int] = []
    return items.map { item in
        let level = min(indents.firstIndex(of: item.indent) ?? 0, 3)
        if counts.count > level + 1 { counts.removeLast(counts.count - level - 1) }
        while counts.count < level + 1 { counts.append(0) }
        counts[level] += 1
        return RawListItem(level: level, number: counts[level], text: item.text)
    }
}

/// `<a id="e-1f2e"></a>` alone on a line: where links into an export land.
private func anchorName(_ line: String) -> String? {
    guard let match = line.wholeMatch(of: #/<a\s+(?:id|name)\s*=\s*"([\w.:-]+)"\s*>\s*</a>/#.ignoresCase()) else { return nil }
    return String(match.output.1)
}

/// `[^label]: text`, starting a note.
private func noteStart(_ line: String) -> (label: String, text: String)? {
    guard let match = line.wholeMatch(of: #/\[\^([^\]\s]+)\]:[ \t]*(.*)/#) else { return nil }
    return (String(match.output.1), String(match.output.2))
}

/**
 * A table row's cells, GFM's way: split on `|` outside code spans, `\|` a
 * bar of the cell's own, the pipes at either end optional. A backtick run
 * opens a code span only when the same run closes it later on the line.
 */
private func tableCells(_ line: String) -> [String] {
    let text = Array(line.trimmingCharacters(in: .whitespaces))
    var cells: [String] = []
    var current = ""
    var open = 0 // the backtick run of the open code span; 0 outside one
    var i = 0
    while i < text.count {
        let ch = text[i]
        if ch == "\\", i + 1 < text.count, text[i + 1] == "|" {
            current.append("|")
            i += 2
            continue
        }
        if ch == "`" {
            var run = 0
            while i + run < text.count, text[i + run] == "`" { run += 1 }
            let fence = String(repeating: "`", count: run)
            if open == run {
                open = 0
            } else if open == 0, String(text[(i + run)...]).contains(fence) {
                open = run
            }
            current += fence
            i += run
            continue
        }
        if ch == "|", open == 0 {
            cells.append(current)
            current = ""
        } else {
            current.append(ch)
        }
        i += 1
    }
    cells.append(current)
    if text.first == "|", !cells.isEmpty { cells.removeFirst() }
    if text.last == "|", text.count > 1, text[text.count - 2] != "\\", !cells.isEmpty { cells.removeLast() }
    return cells.map { $0.trimmingCharacters(in: .whitespaces) }
}

/// `| --- | :---: | ---: |`: each column's alignment (nil where it names none), or nil when the line is no delimiter row.
private func tableDelimiter(_ line: String) -> [CellAlignment?]? {
    guard line.contains("-") else { return nil }
    let cells = tableCells(line)
    guard !cells.isEmpty else { return nil }
    var out: [CellAlignment?] = []
    for cell in cells {
        guard cell.range(of: "^:?-+:?$", options: .regularExpression) != nil else { return nil }
        let left = cell.hasPrefix(":")
        let right = cell.hasSuffix(":")
        out.append(left && right ? .center : right ? .trailing : left ? .leading : nil)
    }
    return out
}

/// The alignments of the table that starts at `index`: a row with a bar, then a delimiter row with as many cells.
private func tableStart(_ lines: [String], _ index: Int) -> [CellAlignment?]? {
    guard index + 1 < lines.count, lines[index].contains("|"), let alignments = tableDelimiter(lines[index + 1]) else { return nil }
    return tableCells(lines[index]).count == alignments.count ? alignments : nil
}

/// A cell that reads as a number: 1,234.5 · −3% · $4.5bn · (12) · 7.5× · 36 pp · 4.2 万亿 — or a dash for none.
private func isNumericCell(_ cell: String) -> Bool {
    let text = cell.replacingOccurrences(of: #"[*_`]"#, with: "", options: .regularExpression).trimmingCharacters(in: .whitespaces)
    return text.range(
        of: #"^[(\[]?[+\-−±~≈<>≤≥]?\s?(?:[$€£¥₩]|US\$|HK\$|USD|RMB|CNY|KRW|JPY)?\s?\d[\d,.\s]*(?:\.\d+)?\s?(?:%|‰|pp|bps?|x|×|[KMBT]|bn|mn|m|k|万亿|万|亿|千|元|美元|倍|个百分点)?[)\]]?$"#,
        options: .regularExpression
    ) != nil
}

/// A column of numbers, a dash or two among them: what a printed table aligns on the right.
private func isNumericColumn(_ cells: [String]) -> Bool {
    let filled = cells.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty && !["—", "–", "-", "n/a", "N/A", "…"].contains($0) }
    return !filled.isEmpty && filled.allSatisfy(isNumericCell)
}

private func parseMarkdown(_ source: String) -> ParsedMarkdown {
    let lines = source.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    var index = 0
    var frontmatter: String?
    if lines.first?.trimmingCharacters(in: .whitespaces) == "---",
       let end = lines.dropFirst().firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == "---" }) {
        frontmatter = lines[1..<end].joined(separator: "\n")
        index = end + 1
    }

    // a `type: MindMap` page is an outline drawn as its tree, as on the web; one that holds no tree reads as text
    if let frontmatter, MindMapOutline.isMindMap(frontmatter: frontmatter),
       let outline = MindMapOutline.parse(lines[index...].joined(separator: "\n")) {
        var out = ParsedMarkdown()
        out.blocks = [
            MarkdownBlock(id: 0, kind: .frontmatter(frontmatterBlock(frontmatter, block: 0)), section: 0, markable: false),
            MarkdownBlock(id: 1, kind: .mindMap(MindMapFigure(outline)), section: 0, markable: true),
        ]
        return out
    }

    let raw = rawBlocks(lines, from: index)

    // notes are numbered the way GitHub numbers them: by the text's first citation
    var definitions: [String: String] = [:]
    var definitionOrder: [String] = []
    for case .note(let label, let text) in raw where definitions[label] == nil {
        definitions[label] = text
        definitionOrder.append(label)
    }
    var numbers: [String: Int] = [:]
    var citing: [String: Int] = [:]
    func cite(_ text: String, from rawIndex: Int?) {
        for label in noteLabels(in: text) where definitions[label] != nil {
            if numbers[label] == nil { numbers[label] = numbers.count + 1 }
            if let rawIndex, citing[label] == nil { citing[label] = rawIndex }
        }
    }
    for (rawIndex, block) in raw.enumerated() {
        switch block {
        case .heading(_, let text), .paragraph(let text), .quote(let text): cite(text, from: rawIndex)
        case .unordered(let items), .ordered(let items): items.forEach { cite($0.text, from: rawIndex) }
        case .table(let table): (table.header + table.rows.flatMap { $0 }).forEach { cite($0, from: rawIndex) }
        default: break
        }
    }
    for case .note(_, let text) in raw { cite(text, from: nil) }
    // a note nothing cites is still listed, last: it is part of what the author wrote
    for label in definitionOrder where numbers[label] == nil { numbers[label] = numbers.count + 1 }

    // the list stands where the notes were written when they form one run (under a "Sources" heading, say), else at the end
    let noteIndices = raw.indices.filter { if case .note = raw[$0] { return true } else { return false } }
    let inPlace = !noteIndices.isEmpty && noteIndices.last! - noteIndices.first! == noteIndices.count - 1

    var out = ParsedMarkdown()
    var section = 0
    var rawToBlock: [Int: Int] = [:]
    func append(_ kind: MarkdownBlock.Kind, markable: Bool = false) {
        out.blocks.append(MarkdownBlock(id: out.blocks.count, kind: kind, section: section, markable: markable))
    }
    func appendNotes() {
        for label in numbers.sorted(by: { $0.value < $1.value }).map(\.key) {
            var text = inlineMarkdown(definitions[label] ?? "", notes: numbers, block: out.blocks.count)
            if citing[label] != nil, let back = MarkdownLink.url(MarkdownLink.noteBack, ("label", label)) {
                var arrow = AttributedString("  ↩")
                arrow.link = back
                text.append(arrow)
            }
            out.noteBlocks[label] = out.blocks.count
            append(.note(MarkdownBlock.Note(number: numbers[label] ?? 0, label: label, text: text)))
        }
    }

    if let frontmatter { append(.frontmatter(frontmatterBlock(frontmatter, block: out.blocks.count))) }
    for (rawIndex, block) in raw.enumerated() {
        rawToBlock[rawIndex] = out.blocks.count
        switch block {
        case .note:
            if inPlace && rawIndex == noteIndices.first { appendNotes() }
        case .heading(let level, let text):
            if level <= 3 { section += 1 }
            append(.heading(level, inlineMarkdown(text, notes: numbers, block: out.blocks.count)))
        case .paragraph(let text):
            append(.paragraph(inlineMarkdown(text, notes: numbers, block: out.blocks.count)), markable: true)
        case .unordered(let items):
            let id = out.blocks.count
            append(.unordered(items.map { MarkdownBlock.ListItem(level: $0.level, number: $0.number, text: inlineMarkdown($0.text, notes: numbers, block: id)) }), markable: true)
        case .ordered(let items):
            let id = out.blocks.count
            append(.ordered(items.map { MarkdownBlock.ListItem(level: $0.level, number: $0.number, text: inlineMarkdown($0.text, notes: numbers, block: id)) }), markable: true)
        case .quote(let text):
            append(.quote(inlineMarkdown(text, notes: numbers, block: out.blocks.count)), markable: true)
        case .code(let code, let language):
            append(.code(code, language))
        case .table(let table):
            let id = out.blocks.count
            let cell = { (text: String) in inlineMarkdown(text, notes: numbers, block: id) }
            append(.table(MarkdownBlock.Table(
                header: table.header.map(cell),
                rows: table.rows.map { $0.map(cell) },
                alignments: table.alignments.enumerated().map { column, given in
                    given ?? (isNumericColumn(table.rows.map { $0[column] }) ? .trailing : .leading)
                }
            )))
        case .anchor(let name):
            if out.anchors[name] == nil { out.anchors[name] = out.blocks.count }
            append(.anchor(name))
        case .rule:
            append(.rule)
        }
    }
    if !inPlace { appendNotes() }
    out.citingBlocks = citing.compactMapValues { rawToBlock[$0] }
    return out
}

private func rawBlocks(_ lines: [String], from start: Int) -> [RawBlock] {
    var blocks: [RawBlock] = []
    var index = start

    func startsBlock(_ line: String) -> Bool {
        let next = line.trimmingCharacters(in: .whitespaces)
        return next.isEmpty || next.hasPrefix("#") || next.hasPrefix("- ") || next.hasPrefix("* ") || next.hasPrefix("> ") || next.hasPrefix("```")
            || ["---", "***", "___"].contains(next) || next.range(of: "^[0-9]+[.)] ", options: .regularExpression) != nil
            || anchorName(next) != nil || noteStart(line) != nil
    }

    while index < lines.count {
        let line = lines[index]
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { index += 1; continue }

        if trimmed.hasPrefix("```") {
            let language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
            var code: [String] = []
            index += 1
            while index < lines.count && !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                code.append(lines[index])
                index += 1
            }
            if index < lines.count { index += 1 }
            blocks.append(.code(code.joined(separator: "\n"), language.isEmpty ? nil : language))
            continue
        }

        if ["---", "***", "___"].contains(trimmed) {
            blocks.append(.rule)
            index += 1
            continue
        }

        if let name = anchorName(trimmed) {
            blocks.append(.anchor(name))
            index += 1
            continue
        }

        // a note runs on over indented lines
        if let note = noteStart(line) {
            var text = [note.text]
            index += 1
            while index < lines.count, lines[index].hasPrefix("  ") || lines[index].hasPrefix("\t"),
                  !lines[index].trimmingCharacters(in: .whitespaces).isEmpty {
                text.append(lines[index].trimmingCharacters(in: .whitespaces))
                index += 1
            }
            blocks.append(.note(label: note.label, text: text.joined(separator: " ").trimmingCharacters(in: .whitespaces)))
            continue
        }

        let hashes = trimmed.prefix(while: { $0 == "#" }).count
        if hashes > 0, hashes <= 6, trimmed.dropFirst(hashes).first == " " {
            blocks.append(.heading(hashes, String(trimmed.dropFirst(hashes + 1))))
            index += 1
            continue
        }

        if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") {
            var items: [(indent: Int, text: String)] = []
            while index < lines.count {
                let item = lines[index].trimmingCharacters(in: .whitespaces)
                guard item.hasPrefix("- ") || item.hasPrefix("* ") else { break }
                items.append((indentation(of: lines[index]), String(item.dropFirst(2))))
                index += 1
            }
            blocks.append(.unordered(nested(items)))
            continue
        }

        if trimmed.range(of: "^[0-9]+[.)] ", options: .regularExpression) != nil {
            var items: [(indent: Int, text: String)] = []
            while index < lines.count {
                let item = lines[index].trimmingCharacters(in: .whitespaces)
                guard let range = item.range(of: "^[0-9]+[.)] ", options: .regularExpression) else { break }
                items.append((indentation(of: lines[index]), String(item[range.upperBound...])))
                index += 1
            }
            blocks.append(.ordered(nested(items)))
            continue
        }

        if trimmed.hasPrefix("> ") {
            var quote: [String] = []
            while index < lines.count {
                let item = lines[index].trimmingCharacters(in: .whitespaces)
                guard item.hasPrefix("> ") else { break }
                quote.append(String(item.dropFirst(2)))
                index += 1
            }
            blocks.append(.quote(quote.joined(separator: " ")))
            continue
        }

        if let alignments = tableStart(lines, index) {
            let width = alignments.count
            let fit = { (cells: [String]) in Array((cells + Array(repeating: "", count: max(0, width - cells.count))).prefix(width)) }
            let header = tableCells(line)
            var rows: [[String]] = []
            index += 2
            while index < lines.count, !startsBlock(lines[index]) {
                rows.append(fit(tableCells(lines[index])))
                index += 1
            }
            blocks.append(.table(RawTable(header: header, rows: rows, alignments: alignments)))
            continue
        }

        var paragraph: [String] = [trimmed]
        index += 1
        while index < lines.count, !startsBlock(lines[index]), tableStart(lines, index) == nil {
            paragraph.append(lines[index].trimmingCharacters(in: .whitespaces))
            index += 1
        }
        blocks.append(.paragraph(paragraph.joined(separator: " ")))
    }

    return blocks
}

/* ---------------------------- frontmatter ---------------------------- */

private func frontmatterBlock(_ yaml: String, block: Int) -> MarkdownBlock.Frontmatter {
    let parts = frontmatterSummary(yaml)
    let lines = yaml.split(separator: "\n", omittingEmptySubsequences: false).count
    return MarkdownBlock.Frontmatter(
        summary: parts.isEmpty ? (lines == 1 ? "1 line" : "\(lines) lines") : parts.joined(separator: " · "),
        body: frontmatterBody(yaml, block: block)
    )
}

/**
 * What the metadata holds, in one line: the `type`, then how many entries
 * each list has (`sources 87`). Read line by line, not parsed: a summary
 * should never fail on YAML a person is halfway through writing. The web
 * UI's `frontmatterSummary` (web/markdown.js) reads it the same way.
 */
func frontmatterSummary(_ yaml: String) -> [String] {
    var fields: [(key: String, value: String, block: [String])] = []
    for line in yaml.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
        if let match = line.wholeMatch(of: #/([^\s#:-][^:]*):(?:[ \t]+(.*))?/#) {
            fields.append((String(match.output.1).trimmingCharacters(in: .whitespaces), String(match.output.2 ?? "").trimmingCharacters(in: .whitespaces), []))
        } else if !fields.isEmpty, !line.trimmingCharacters(in: .whitespaces).isEmpty {
            fields[fields.count - 1].block.append(line)
        }
    }
    var parts: [String] = []
    for field in fields {
        if field.key == "type", !field.value.isEmpty {
            parts.insert(field.value.trimmingCharacters(in: CharacterSet(charactersIn: "\"'")), at: 0)
            continue
        }
        var count = 0
        if field.value.hasPrefix("[") {
            count = flowCount(field.value)
        } else if field.value.isEmpty, !field.block.isEmpty {
            let indent = { (line: String) in line.prefix(while: { $0 == " " || $0 == "\t" }).count }
            let items = field.block.filter { $0.range(of: #"^\s*-(\s|$)"#, options: .regularExpression) != nil }
            if let shallowest = items.map(indent).min() {
                count = items.filter { indent($0) == shallowest }.count
            } else {
                // a map of lists, such as relations by predicate: count what it points at
                let links = field.block.joined(separator: "\n").matches(of: #/\[\[[^\]\n]+\]\]/#).count
                count = links > 0 ? links : field.block.filter { $0.range(of: #"^\s+[^\s:#-][^:]*:"#, options: .regularExpression) != nil }.count
            }
        }
        if count > 0 { parts.append("\(field.key) \(count)") }
    }
    return parts
}

/// Items of a YAML flow list, `[a, "b, c", [d]]`, counted at its top level.
private func flowCount(_ value: String) -> Int {
    var depth = 0
    var quote: Character?
    var commas = 0
    var content = false
    for character in value {
        if let open = quote {
            if character == open { quote = nil }
            continue
        }
        switch character {
        case "\"", "'":
            quote = character
            content = true
        case "[", "{":
            if depth > 0 { content = true }
            depth += 1
        case "]", "}":
            depth -= 1
        case "," where depth == 1:
            commas += 1
        default:
            if depth > 0 && !character.isWhitespace { content = true }
        }
    }
    return content ? commas + 1 : 0
}

/// The YAML as written, with its wikilinks and workspace paths made links.
private func frontmatterBody(_ yaml: String, block: Int) -> AttributedString {
    var out = AttributedString()
    var cursor = yaml.startIndex
    for match in yaml.matches(of: #/\[\[([^\]\n]+)\]\]|((?:raw|wiki)\/[^\s"'<>\[\]{},|]+)/#) {
        let destination: String
        if let target = match.output.1 {
            destination = target.split(separator: "|", maxSplits: 1).first.map { String($0).trimmingCharacters(in: .whitespaces) } ?? ""
        } else if let path = match.output.2 {
            // a path starts the value or follows a space, a quote or a bracket — not the middle of another word
            if match.range.lowerBound > yaml.startIndex {
                let before = yaml[yaml.index(before: match.range.lowerBound)]
                if before.isLetter || before.isNumber || "_/.-".contains(before) { continue }
            }
            destination = String(path)
        } else {
            continue
        }
        out.append(AttributedString(String(yaml[cursor..<match.range.lowerBound])))
        var link = AttributedString(String(yaml[match.range]))
        link.link = MarkdownLink.url(MarkdownLink.wiki, ("target", destination), ("from", String(block)))
        out.append(link)
        cursor = match.range.upperBound
    }
    out.append(AttributedString(String(yaml[cursor...])))
    return out
}

/* ----------------------------- mentions ----------------------------- */

/// Finds the entity names a view was told about in its runs of text: the
/// longest name wins where several start at one place, and a Latin name
/// counts only as a whole word, the way the service found them in the source.
private struct MentionMatcher {
    private struct Candidate {
        let surface: [Character]
        let mention: EntityMention
    }

    private let byFirst: [Character: [Candidate]]

    init(_ mentions: [EntityMention]) {
        var byFirst: [Character: [Candidate]] = [:]
        for mention in mentions {
            for surface in mention.surfaces where !surface.isEmpty {
                let characters = Array(surface)
                byFirst[characters[0], default: []].append(Candidate(surface: characters, mention: mention))
            }
        }
        self.byFirst = byFirst.mapValues { $0.sorted { $0.surface.count > $1.surface.count } }
    }

    var isEmpty: Bool { byFirst.isEmpty }

    /// `text` with the mentions not yet `seen` in this section made links to the entity panel.
    func mark(_ text: AttributedString, in block: Int, seen: inout Set<String>) -> AttributedString {
        var hits: [(offset: Int, length: Int, mention: EntityMention)] = []
        for run in text.runs where run.link == nil && !(run.inlinePresentationIntent?.contains(.code) ?? false) {
            let characters = Array(text[run.range].characters)
            let base = text.characters.distance(from: text.startIndex, to: run.range.lowerBound)
            var i = 0
            while i < characters.count {
                guard let candidate = match(characters, at: i) else {
                    i += 1
                    continue
                }
                if seen.insert(candidate.mention.id).inserted {
                    hits.append((base + i, candidate.surface.count, candidate.mention))
                }
                i += candidate.surface.count
            }
        }
        guard !hits.isEmpty else { return text }
        var marked = text
        for hit in hits {
            let start = marked.characters.index(marked.startIndex, offsetBy: hit.offset)
            let range = start..<marked.characters.index(start, offsetBy: hit.length)
            marked[range].link = MarkdownLink.url(MarkdownLink.entity, ("id", hit.mention.id), ("from", String(block)))
            marked[range].foregroundColor = .primary
            marked[range].underlineStyle = Text.LineStyle(pattern: .dot, color: nodeColor(hit.mention.type))
        }
        return marked
    }

    private func match(_ characters: [Character], at i: Int) -> Candidate? {
        for candidate in byFirst[characters[i]] ?? [] {
            let end = i + candidate.surface.count
            guard end <= characters.count, characters[i..<end].elementsEqual(candidate.surface) else { continue }
            if isLatin(candidate.surface[0]), i > 0, isLatin(characters[i - 1]) { continue }
            if isLatin(candidate.surface[candidate.surface.count - 1]), end < characters.count, isLatin(characters[end]) { continue }
            return candidate
        }
        return nil
    }

    private func isLatin(_ character: Character) -> Bool {
        character.isASCII && (character.isLetter || character.isNumber)
    }
}
