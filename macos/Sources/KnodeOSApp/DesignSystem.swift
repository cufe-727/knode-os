import AppKit
import SwiftUI

struct KnodeLogo: View {
    var size: CGFloat = 32

    private var image: NSImage? {
        guard let url = Bundle.module.url(forResource: "favicon", withExtension: "svg", subdirectory: "Resources") else { return nil }
        return NSImage(contentsOf: url)
    }

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
            } else {
                Image(systemName: "circle.hexagongrid.fill")
                    .resizable()
                    .foregroundStyle(Color.knodeCyan)
            }
        }
        .frame(width: size, height: size)
        .accessibilityLabel("knode-os")
    }
}

struct Eyebrow: View {
    var text: String
    var color: Color = .knodeCyan

    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 10, weight: .bold, design: .monospaced))
            .tracking(1.4)
            .foregroundStyle(color)
    }
}

struct InitialsBadge: View {
    let value: String
    var team = false
    var size: CGFloat = 30

    var body: some View {
        Text(value.knodeInitials)
            .font(.system(size: size * 0.35, weight: .bold, design: .rounded))
            .foregroundStyle(team ? Color.knodeViolet : Color.knodeCyan)
            .frame(width: size, height: size)
            .background((team ? Color.knodeViolet : Color.knodeCyan).opacity(0.12), in: RoundedRectangle(cornerRadius: size * 0.25))
            .overlay {
                RoundedRectangle(cornerRadius: size * 0.25)
                    .stroke((team ? Color.knodeViolet : Color.knodeCyan).opacity(0.32))
            }
    }
}

struct StatusDot: View {
    var color: Color
    var size: CGFloat = 7

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .shadow(color: color.opacity(0.5), radius: 3)
    }
}

struct EmptyState: View {
    let symbol: String
    let title: String
    let message: String
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.system(size: 32, weight: .light))
                .foregroundStyle(Color.knodeCyan)
            Text(title)
                .font(.title3.weight(.semibold))
            Text(message)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 380)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(.borderedProminent)
                    .tint(.knodeCyan)
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

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
struct MarkdownText: View {
    let markdown: String
    var onOpenKnowledgeLink: ((String) -> Void)?

    /// Documents this short parse inline on the main actor: the work is under a
    /// millisecond and a detached hop would flash an empty answer.
    private static let asyncParseThreshold = 20_000

    @State private var document = MarkdownDocument.empty

    init(markdown: String, onOpenKnowledgeLink: ((String) -> Void)? = nil) {
        self.markdown = markdown
        self.onOpenKnowledgeLink = onOpenKnowledgeLink
    }

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 13) {
            ForEach(document.blocks) { block in
                blockView(block)
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
        .environment(\.openURL, OpenURLAction { url in
            guard let target = inAppTarget(from: url), let onOpenKnowledgeLink else {
                return .systemAction
            }
            onOpenKnowledgeLink(target)
            return .handled
        })
        .task(id: markdown) { await parse() }
    }

    private func parse() async {
        guard document.source != markdown else { return }
        guard markdown.count > Self.asyncParseThreshold else {
            document = MarkdownDocument(source: markdown)
            return
        }
        let source = markdown
        let parsed = await Task.detached(priority: .userInitiated) {
            MarkdownDocument(source: source)
        }.value
        guard !Task.isCancelled else { return }
        document = parsed
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
                        Circle().fill(Color.secondary).frame(width: 5, height: 5)
                        Text(item).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .padding(.leading, 8)
        case .ordered(let items):
            VStack(alignment: .leading, spacing: 7) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: 9) {
                        Text("\(index + 1).")
                            .font(.system(.body, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .frame(width: 24, alignment: .trailing)
                        Text(item).frame(maxWidth: .infinity, alignment: .leading)
                    }
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
        case .frontmatter(let text):
            VStack(alignment: .leading, spacing: 5) {
                Eyebrow(text: L("Metadata"), color: .knodeViolet)
                Text(text)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            .padding(11)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.knodeViolet.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
        case .rule:
            Divider().padding(.vertical, 3)
        }
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
        if url.scheme == "knode-wiki" {
            return URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?
                .first(where: { $0.name == "target" })?
                .value
        }
        if url.scheme == nil {
            return url.relativeString.removingPercentEncoding ?? url.relativeString
        }
        return nil
    }
}

/** Convert Obsidian WikiLinks into Markdown links that SwiftUI can activate. */
private func markdownWithWikiLinks(_ source: String) -> String {
    var output = ""
    var cursor = source.startIndex
    var insideCode = false

    while cursor < source.endIndex {
        if source[cursor] == "`" {
            insideCode.toggle()
            output.append(source[cursor])
            cursor = source.index(after: cursor)
            continue
        }

        let remainder = source[cursor...]
        let markerLength: Int?
        if !insideCode && remainder.hasPrefix("![[") { markerLength = 3 }
        else if !insideCode && remainder.hasPrefix("[[") { markerLength = 2 }
        else { markerLength = nil }

        guard let markerLength else {
            output.append(source[cursor])
            cursor = source.index(after: cursor)
            continue
        }

        let contentStart = source.index(cursor, offsetBy: markerLength)
        guard let close = source.range(of: "]]", range: contentStart..<source.endIndex) else {
            output.append(source[cursor])
            cursor = source.index(after: cursor)
            continue
        }

        let inner = String(source[contentStart..<close.lowerBound])
        let fields = inner.split(separator: "|", maxSplits: 1, omittingEmptySubsequences: false)
        let destination = fields.first.map(String.init)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !destination.isEmpty, let link = wikiMarkdownLink(destination: destination, customLabel: fields.count > 1 ? String(fields[1]) : nil) else {
            output += String(source[cursor..<close.upperBound])
            cursor = close.upperBound
            continue
        }
        output += link
        cursor = close.upperBound
    }

    return output
}

private func wikiMarkdownLink(destination: String, customLabel: String?) -> String? {
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

    var components = URLComponents()
    components.scheme = "knode-wiki"
    components.host = "open"
    components.queryItems = [URLQueryItem(name: "target", value: destination)]
    guard let url = components.string else { return nil }
    let escapedLabel = label
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "[", with: "\\[")
        .replacingOccurrences(of: "]", with: "\\]")
    return "[\(escapedLabel)](\(url))"
}

/// A parsed document, kept whole so a view can tell at a glance whether the
/// blocks it holds still belong to the Markdown it was handed.
private struct MarkdownDocument {
    let source: String
    let blocks: [MarkdownBlock]

    static let empty = MarkdownDocument(source: "", blocks: [])

    init(source: String) {
        self.source = source
        blocks = parseMarkdown(source)
    }

    private init(source: String, blocks: [MarkdownBlock]) {
        self.source = source
        self.blocks = blocks
    }
}

private struct MarkdownBlock: Identifiable {
    /// Inline runs arrive already converted: `AttributedString(markdown:)` is
    /// the costliest step per block, and doing it in `body` meant redoing it
    /// for the whole document on every render.
    enum Kind {
        case heading(Int, AttributedString)
        case paragraph(AttributedString)
        case unordered([AttributedString])
        case ordered([AttributedString])
        case quote(AttributedString)
        case code(String, String?)
        case frontmatter(String)
        case rule
    }

    let id: Int
    let kind: Kind
}

private func inlineMarkdown(_ text: String) -> AttributedString {
    (try? AttributedString(
        markdown: markdownWithWikiLinks(text),
        options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)
    )) ?? AttributedString(text)
}

private func parseMarkdown(_ source: String) -> [MarkdownBlock] {
    let lines = source.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    var blocks: [MarkdownBlock] = []
    var index = 0

    func append(_ kind: MarkdownBlock.Kind) {
        blocks.append(MarkdownBlock(id: blocks.count, kind: kind))
    }

    if lines.first?.trimmingCharacters(in: .whitespaces) == "---",
       let end = lines.dropFirst().firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == "---" }) {
        append(.frontmatter(lines[1..<end].joined(separator: "\n")))
        index = end + 1
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
            append(.code(code.joined(separator: "\n"), language.isEmpty ? nil : language))
            continue
        }

        if ["---", "***", "___"].contains(trimmed) {
            append(.rule)
            index += 1
            continue
        }

        let hashes = trimmed.prefix(while: { $0 == "#" }).count
        if hashes > 0, hashes <= 6, trimmed.dropFirst(hashes).first == " " {
            append(.heading(hashes, inlineMarkdown(String(trimmed.dropFirst(hashes + 1)))))
            index += 1
            continue
        }

        if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") {
            var items: [AttributedString] = []
            while index < lines.count {
                let item = lines[index].trimmingCharacters(in: .whitespaces)
                guard item.hasPrefix("- ") || item.hasPrefix("* ") else { break }
                items.append(inlineMarkdown(String(item.dropFirst(2))))
                index += 1
            }
            append(.unordered(items))
            continue
        }

        if trimmed.range(of: "^[0-9]+[.)] ", options: .regularExpression) != nil {
            var items: [AttributedString] = []
            while index < lines.count {
                let item = lines[index].trimmingCharacters(in: .whitespaces)
                guard let range = item.range(of: "^[0-9]+[.)] ", options: .regularExpression) else { break }
                items.append(inlineMarkdown(String(item[range.upperBound...])))
                index += 1
            }
            append(.ordered(items))
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
            append(.quote(inlineMarkdown(quote.joined(separator: " "))))
            continue
        }

        var paragraph: [String] = [trimmed]
        index += 1
        while index < lines.count {
            let next = lines[index].trimmingCharacters(in: .whitespaces)
            if next.isEmpty || next.hasPrefix("#") || next.hasPrefix("- ") || next.hasPrefix("* ") || next.hasPrefix("> ") || next.hasPrefix("```") || ["---", "***", "___"].contains(next) || next.range(of: "^[0-9]+[.)] ", options: .regularExpression) != nil {
                break
            }
            paragraph.append(next)
            index += 1
        }
        append(.paragraph(inlineMarkdown(paragraph.joined(separator: " "))))
    }

    return blocks
}

struct MetricPill: View {
    let value: Int
    let label: String

    var body: some View {
        HStack(spacing: 4) {
            Text(value.formatted())
                .foregroundStyle(.primary)
            Text(label)
                .foregroundStyle(.secondary)
        }
        .font(.system(size: 10, weight: .medium, design: .monospaced))
    }
}

struct RouteBadge: View {
    let label: String
    var color: Color = .knodeCyan

    var body: some View {
        Text(label.uppercased())
            .font(.system(size: 9, weight: .bold, design: .monospaced))
            .tracking(0.8)
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(color.opacity(0.1), in: Capsule())
            .overlay { Capsule().stroke(color.opacity(0.28)) }
    }
}

extension View {
    func knodeCard(padding: CGFloat = 16) -> some View {
        self
            .padding(padding)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
            .overlay { RoundedRectangle(cornerRadius: 12).stroke(Color.white.opacity(0.08)) }
    }
}
