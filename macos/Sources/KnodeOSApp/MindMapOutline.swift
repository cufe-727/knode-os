import Foundation

/**
 * A mind map read from its outline (docs/design/19-mind-maps.md): a page
 * whose frontmatter says `type: MindMap`, with the root as its H1 and every
 * other node a bullet nested under its parent. The Markdown view draws such a
 * page as its tree (MarkdownMindMap.swift) instead of as a nested list.
 *
 * Reading mirrors web/mindmap.js, which mirrors the server's reader
 * (src/mindmap/outline.ts): line-based, not CommonMark. Each item is one node
 * and its text is kept as written, numbering included (`1. 市场整体情绪极弱` is
 * a label, not a nested ordered list); a heading below the H1 is a node too —
 * `## A` a child of the root, `### B` of the last `##` — so the outline an
 * XMind or markmap export writes reads the same.
 */
struct MindMapOutline: Hashable {
    struct Node: Hashable {
        /// The label as written, its Markdown emphasis, links and escapes removed.
        var text: String
        /// Drawn in bold: the label, or a run in it, was wrapped in ** or __.
        var strong: Bool
        var children: [Node]
    }

    var root: Node
    /// Nodes, the root included.
    var size: Int
    /// The deepest level below the root.
    var depth: Int

    /// `type: MindMap` in a page's YAML, spelled any way a person might (mindmap, mind-map, Mind Map).
    static func isMindMap(frontmatter yaml: String) -> Bool {
        for line in yaml.split(separator: "\n", omittingEmptySubsequences: false) {
            guard let match = line.wholeMatch(of: #/type:[ \t]*["']?([^"'\n#]+?)["']?[ \t]*(?:#.*)?/#) else { continue }
            return match.output.1.replacing(#/[\s_\-]+/#, with: "").lowercased() == "mindmap"
        }
        return false
    }

    /**
     * The tree an outline holds, or nil when no node hangs below a root.
     * Without an H1 a lone top-level item is the root; several are children
     * of a root with no label, as on the web.
     */
    static func parse(_ body: String) -> MindMapOutline? {
        let root = Draft("")
        var rootNamed = false
        // headings open sections: headings[d] is the node a heading at depth d opened
        var headings: [Draft] = [root]
        var base = root
        var items: [(indent: Int, node: Draft)] = []
        var inFence = false

        let text = body.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let lead = line.drop(while: { $0 == " " || $0 == "\t" })
            if lead.hasPrefix("```") || lead.hasPrefix("~~~") {
                inFence.toggle()
                continue
            }
            if inFence || line.allSatisfy(\.isWhitespace) { continue }
            if line.hasPrefix("#"), let heading = line.wholeMatch(of: #/(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*/#) {
                let level = heading.output.1.count
                if level == 1 && !rootNamed {
                    root.relabel(String(heading.output.2))
                    rootNamed = true
                    headings = [root]
                    base = root
                } else {
                    let depth = max(1, min(level - 1, headings.count))
                    let node = Draft(String(heading.output.2))
                    headings[depth - 1].children.append(node)
                    headings = Array(headings.prefix(depth)) + [node]
                    base = node
                }
                items = []
                continue
            }
            if let bullet = bulletItem(line) {
                let indent = columns(bullet.indent)
                while let last = items.last, last.indent >= indent { items.removeLast() }
                let parent = items.last?.node ?? base
                // an ordered item keeps its number: it is part of what the map says
                let node = Draft(bullet.number.map { "\($0) \(bullet.label)" } ?? String(bullet.label))
                parent.children.append(node)
                items.append((indent, node))
                continue
            }
            // an indented line under an item continues its label; prose elsewhere is not part of the tree
            if let last = items.last, line.first == " " || line.first == "\t" {
                last.node.text = cleanLabel("\(last.node.text) \(line.trimmingCharacters(in: .whitespacesAndNewlines))").text
            }
        }

        let top = !rootNamed && root.children.count == 1 ? root.children[0] : root
        let tree = top.node
        let size = count(tree)
        guard size >= 2 else { return nil }
        return MindMapOutline(root: tree, size: size, depth: deepest(tree, 0))
    }

    /**
     * A label's numbering, name and note, set apart the way web/mindmap.js
     * draws them: `1.` before the name (trimmed), the trailing parenthetical
     * after it with its brackets (`（高温合金平台类企业）`; an unclosed one runs to
     * the end). A label that is all note keeps it as its name.
     */
    static func labelParts(_ text: String) -> (number: String, name: String, note: String) {
        var number = ""
        var rest = Substring(text)
        if let first = text.first, first.isASCII || "一二三四五六七八九十".contains(first),
           let match = text.prefixMatch(of: #/(?:[0-9]{1,3}|[A-Za-z]|[一二三四五六七八九十]{1,3})[.、．)）]\s*/#) {
            number = match.output.trimmingCharacters(in: .whitespacesAndNewlines)
            rest = text[match.range.upperBound...]
        }
        if rest.contains(where: { $0 == "(" || $0 == "（" }),
           let note = rest.wholeMatch(of: #/(.+?)\s*([（(][^（()）]+[）)]?)\s*/#),
           !note.output.1.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return (number, String(note.output.1), String(note.output.2))
        }
        return (number, String(rest), "")
    }
}

/// A node while the outline is read: its children grow, and a continuation line may still extend its label.
private final class Draft {
    var text: String
    var strong: Bool
    var children: [Draft] = []

    init(_ raw: String) {
        let label = cleanLabel(raw)
        text = label.text
        strong = label.strong
    }

    func relabel(_ raw: String) {
        let label = cleanLabel(raw)
        text = label.text
        strong = label.strong
    }

    var node: MindMapOutline.Node {
        MindMapOutline.Node(text: text, strong: strong, children: children.map(\.node))
    }
}

/// A label without its Markdown: bold, links and escapes read as what they show, runs of space as one.
private func cleanLabel(_ raw: String) -> (text: String, strong: Bool) {
    var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    var strong = false
    if s.contains("**") || s.contains("__") {
        strong = s.contains(#/\*\*[^*]+\*\*|__[^_]+__/#)
        s = s.replacing(#/\*\*([^*]+)\*\*/#) { String($0.output.1) }
        s = s.replacing(#/__([^_]+)__/#) { String($0.output.1) }
    }
    if s.contains("[") {
        // [[target|label]] and [label](url) read as their labels
        s = s.replacing(#/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/#) { String($0.output.2 ?? $0.output.1) }
        s = s.replacing(#/\[([^\]]+)\]\([^)]*\)/#) { String($0.output.1) }
    }
    if s.contains("\\") {
        // Markdown escapes: \. \* \# … stand for the character itself
        s = s.replacing(#/\\([!-\/:-@\[-`{-~])/#) { String($0.output.1) }
    }
    if s.contains(where: { $0.isWhitespace && $0 != " " }) || s.contains("  ") {
        s = s.replacing(#/\s+/#, with: " ")
    }
    return (s.trimmingCharacters(in: .whitespacesAndNewlines), strong)
}

/**
 * A list item: its indent, an ordered item's number (`1.`, `2)`) and its
 * label — what web/mindmap.js's `^([ \t]*)(?:[-*+]|(\d{1,3}[.)]))[ \t]+(.*)$`
 * matches, read without a regex since every line of the outline asks.
 */
private func bulletItem(_ line: Substring) -> (indent: Substring, number: Substring?, label: Substring)? {
    let indent = line.prefix(while: { $0 == " " || $0 == "\t" })
    var rest = line[indent.endIndex...]
    var number: Substring?
    guard let first = rest.first else { return nil }
    if "-*+".contains(first) {
        rest = rest.dropFirst()
    } else {
        let digits = rest.prefix(while: { $0.isASCII && $0.isNumber })
        guard (1...3).contains(digits.count), let mark = rest.dropFirst(digits.count).first, mark == "." || mark == ")" else { return nil }
        number = rest.prefix(digits.count + 1)
        rest = rest.dropFirst(digits.count + 1)
    }
    let space = rest.prefix(while: { $0 == " " || $0 == "\t" })
    guard !space.isEmpty else { return nil }
    return (indent, number, rest[space.endIndex...])
}

/// Leading whitespace in columns, a tab running to the next stop of four.
private func columns(_ indent: Substring) -> Int {
    var n = 0
    for ch in indent { n += ch == "\t" ? 4 - n % 4 : 1 }
    return n
}

private func count(_ node: MindMapOutline.Node) -> Int {
    node.children.reduce(1) { $0 + count($1) }
}

private func deepest(_ node: MindMapOutline.Node, _ depth: Int) -> Int {
    node.children.reduce(depth) { max($0, deepest($1, depth + 1)) }
}
