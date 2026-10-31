import AppKit
import SwiftUI

/// A mind map as a Markdown view holds it: the outline (MindMapOutline.swift)
/// with each label set as text — its numbering and its note in a quieter ink
/// than its name, as web/mindmap.js sets them apart — so the entity names the
/// page mentions are marked in the labels as they are in prose.
struct MindMapFigure {
    struct Node: Identifiable {
        /// Where the node sits: "" for the root, then "1", "1.2", … by position among siblings.
        let id: String
        let label: AttributedString
        let strong: Bool
        let children: [Node]
        /// Every node below it: what its fold button counts.
        let descendants: Int
    }

    let root: Node
    let size: Int
    let depth: Int
    /// Tells one outline from another: another page, or this one changed, starts unfolded.
    let signature: Int

    init(_ outline: MindMapOutline) {
        root = Self.node(outline.root, id: "")
        size = outline.size
        depth = outline.depth
        signature = outline.hashValue
    }

    private init(root: Node, size: Int, depth: Int, signature: Int) {
        self.root = root
        self.size = size
        self.depth = depth
        self.signature = signature
    }

    /// The figure with `mark` run over every label in reading order — a node, then the branches under it — so a name is marked where it first appears.
    func marking(_ mark: (AttributedString) -> AttributedString) -> MindMapFigure {
        func marked(_ node: Node) -> Node {
            let label = mark(node.label)
            return Node(id: node.id, label: label, strong: node.strong, children: node.children.map { marked($0) }, descendants: node.descendants)
        }
        return MindMapFigure(root: marked(root), size: size, depth: depth, signature: signature)
    }

    private static func node(_ source: MindMapOutline.Node, id: String) -> Node {
        let children = source.children.enumerated().map { index, child in
            node(child, id: id.isEmpty ? String(index + 1) : "\(id).\(index + 1)")
        }
        return Node(
            id: id,
            label: label(source.text, onRoot: id.isEmpty),
            strong: source.strong,
            children: children,
            descendants: children.reduce(0) { $0 + 1 + $1.descendants }
        )
    }

    /// `1.` before the name and `（…）` after it in a quieter ink; on the root, drawn light on blue, a dimmed light.
    private static func label(_ text: String, onRoot: Bool) -> AttributedString {
        let parts = MindMapOutline.labelParts(text)
        let quiet: Color = onRoot ? MindMapStyle.rootInk.opacity(0.8) : .secondary
        var label = AttributedString()
        if !parts.number.isEmpty {
            var number = AttributedString(parts.number + " ")
            number.foregroundColor = quiet
            label.append(number)
        }
        label.append(AttributedString(parts.name))
        if !parts.note.isEmpty {
            var note = AttributedString(parts.note)
            note.foregroundColor = quiet
            label.append(note)
        }
        return label
    }
}

/**
 * A `type: MindMap` page drawn as its tree — the native counterpart of
 * web/mindmap.js and web/mindmap.css (docs/design/19-mind-maps.md D9): the
 * root on the left, each branch to the right of its parent, joined to it by a
 * bracket. Branches fold (the button on the line says how many nodes are
 * behind it), a wide map fits the pane, the same tree reads as an indented
 * outline, and a map read off a picture — or the transcript beside one — shows
 * that picture under itself, to check the reading against. The labels' entity
 * links answer through the Markdown view's own link handling.
 */
struct MarkdownMindMap: View {
    let map: MindMapFigure
    /// The picture the map was read from, by its workspace path: a button shows it under the map.
    var picture: String?

    @State private var folded: Set<String> = []
    @State private var asOutline = false
    @State private var fitted = false
    @State private var showsPicture = false
    /// The tree at full size, and the width the pane gives it: what fitting scales by.
    @State private var treeSize: CGSize = .zero
    @State private var paneWidth: CGFloat = 0

    var body: some View {
        ScrollViewReader { proxy in
            VStack(alignment: .leading, spacing: 0) {
                bar
                Divider().opacity(0.6)
                if asOutline {
                    MindMapOutlineRow(node: map.root, depth: 0, folded: $folded)
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    tree
                }
                if showsPicture, let picture {
                    Divider().opacity(0.6)
                    MindMapPicture(path: picture)
                        .id(MindMapStyle.pictureAnchor)
                        .onAppear {
                            // under a tall map the picture opens out of sight: bring it in, as the web view does
                            DispatchQueue.main.async {
                                withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo(MindMapStyle.pictureAnchor, anchor: .top) }
                            }
                        }
                }
            }
            .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
            .overlay { RoundedRectangle(cornerRadius: 10).stroke(Color.primary.opacity(0.1)) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L("Mind map: %@", String(map.root.label.characters)))
    }

    private var bar: some View {
        HStack(spacing: 6) {
            Text(L("Mind map · %@ nodes · %@ levels", String(map.size), String(map.depth)))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer(minLength: 10)
            if let picture {
                Toggle(L("Picture"), isOn: $showsPicture)
                    .help(L("Show %@, the picture this map was read from, under the map", (picture as NSString).lastPathComponent))
            }
            Toggle(L("Fit"), isOn: $fitted)
                .disabled(asOutline)
                .help(L("Fit the map to the pane"))
            Button(L("Unfold all")) { folded = [] }
                .disabled(folded.isEmpty)
                .help(L("Unfold every branch"))
            Toggle(L("Outline"), isOn: $asOutline)
                .help(L("Read it as an indented outline"))
        }
        .toggleStyle(.button)
        .controlSize(.small)
        .font(.system(size: 11))
        .textSelection(.disabled)
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
    }

    /// The map at full size, scrolling sideways when it is wider than the pane — or, fitted, scaled down to the pane's width.
    private var tree: some View {
        let scale = fitScale
        return ScrollView(.horizontal) {
            MindMapBranch(node: map.root, depth: 0, folded: $folded)
                .fixedSize()
                .onGeometryChange(for: CGSize.self) { $0.size } action: { treeSize = $0 }
                .scaleEffect(scale, anchor: .topLeading)
                .frame(width: scale < 1 ? treeSize.width * scale : nil, height: scale < 1 ? treeSize.height * scale : nil, alignment: .topLeading)
                .padding(16)
        }
        .scrollIndicators(.automatic, axes: .horizontal)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { paneWidth = $0 }
    }

    /// 1, or while fitting what brings the tree to the pane's width — never under 0.35, as on the web.
    private var fitScale: CGFloat {
        guard fitted, treeSize.width > 0, paneWidth > 32 else { return 1 }
        return max(0.35, min(1, (paneWidth - 32) / treeSize.width))
    }
}

/* ------------------------------ the tree ------------------------------ */

/**
 * A node and its branches to the right of it, the node centred on them — a
 * row of [node][branches] as in web/mindmap.css. The bracket is drawn by the
 * branches themselves: each its stub and its share of the bar, the first and
 * the last turning the corner, so nothing is measured.
 */
private struct MindMapBranch: View {
    let node: MindMapFigure.Node
    let depth: Int
    @Binding var folded: Set<String>
    @State private var hovering = false

    var body: some View {
        HStack(alignment: .center, spacing: 0) {
            MindMapLabel(node: node, depth: depth, outline: false)
            if !node.children.isEmpty {
                if depth > 0 {
                    MindMapFoldButton(node: node, folded: $folded, emphasized: hovering)
                        .padding(.leading, 4)
                }
                if !folded.contains(node.id) {
                    // from the node to the bar
                    MindMapStyle.line
                        .frame(width: MindMapStyle.gap, height: MindMapStyle.lineWidth)
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(node.children.enumerated()), id: \.element.id) { index, child in
                            MindMapBranch(node: child, depth: depth + 1, folded: $folded)
                                .padding(.leading, MindMapStyle.stub)
                                .padding(.vertical, 3)
                                .background(alignment: .leading) {
                                    MindMapBracket(index: index, count: node.children.count)
                                        .stroke(MindMapStyle.line, lineWidth: MindMapStyle.lineWidth)
                                        .frame(width: MindMapStyle.stub)
                                }
                        }
                    }
                }
            }
        }
        // a branch under the pointer shows its fold button at full strength, as the web view's :hover does
        .onHover { inside in
            if depth > 0, !node.children.isEmpty { hovering = inside }
        }
    }
}

/// One branch's share of the bracket joining a node to its branches: its stub, and the bar beside it — turning the corner on the first and the last, one straight line for an only child.
private struct MindMapBracket: Shape {
    let index: Int
    let count: Int

    func path(in rect: CGRect) -> Path {
        var path = Path()
        let bar = rect.minX + MindMapStyle.lineWidth / 2
        let stubEnd = CGPoint(x: rect.maxX, y: rect.midY)
        let corner = min(MindMapStyle.corner, rect.height / 2, rect.width)
        if count == 1 {
            path.move(to: CGPoint(x: rect.minX, y: rect.midY))
            path.addLine(to: stubEnd)
        } else if index == 0 {
            path.move(to: stubEnd)
            path.addArc(tangent1End: CGPoint(x: bar, y: rect.midY), tangent2End: CGPoint(x: bar, y: rect.maxY), radius: corner)
            path.addLine(to: CGPoint(x: bar, y: rect.maxY))
        } else if index == count - 1 {
            path.move(to: CGPoint(x: bar, y: rect.minY))
            path.addArc(tangent1End: CGPoint(x: bar, y: rect.midY), tangent2End: stubEnd, radius: corner)
            path.addLine(to: stubEnd)
        } else {
            path.move(to: CGPoint(x: bar, y: rect.minY))
            path.addLine(to: CGPoint(x: bar, y: rect.maxY))
            path.move(to: CGPoint(x: bar, y: rect.midY))
            path.addLine(to: stubEnd)
        }
        return path
    }
}

/// A node's label: the root light on blue, the first level semibold, a bold label bold. On the map a long one wraps; in the outline it runs to the pane's edge.
private struct MindMapLabel: View {
    let node: MindMapFigure.Node
    let depth: Int
    let outline: Bool

    var body: some View {
        if depth == 0 {
            text(size: 15, weight: node.strong ? .bold : .semibold)
                .foregroundStyle(MindMapStyle.rootInk)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(MindMapStyle.root, in: RoundedRectangle(cornerRadius: 8))
        } else {
            text(size: 14, weight: node.strong ? .bold : depth == 1 ? .semibold : .regular)
                .padding(.horizontal, outline ? 4 : 8)
                .padding(.vertical, outline ? 1 : 3)
        }
    }

    @ViewBuilder
    private func text(size: CGFloat, weight: Font.Weight) -> some View {
        let label = Text(node.label).font(.system(size: size, weight: weight)).lineSpacing(2)
        if outline {
            label.fixedSize(horizontal: false, vertical: true)
        } else {
            WrapPast(width: MindMapStyle.labelWidth) { label }
        }
    }
}

/// The button on the line after a node: how many nodes are behind it, folding them away or bringing them back.
private struct MindMapFoldButton: View {
    let node: MindMapFigure.Node
    @Binding var folded: Set<String>
    /// The branch is under the pointer.
    let emphasized: Bool
    @State private var hovering = false

    var body: some View {
        let isFolded = folded.contains(node.id)
        Button {
            if isFolded { folded.remove(node.id) } else { folded.insert(node.id) }
        } label: {
            Text(String(node.descendants))
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .foregroundStyle(isFolded ? Color.primary : Color.secondary)
                // a stack short of a fraction of a point takes it from the most compressible text: never this count's
                .fixedSize()
                .padding(.horizontal, 4)
                .frame(minWidth: 18, minHeight: 18)
                .background(isFolded ? Color.primary.opacity(0.12) : Color.clear, in: Capsule())
                .overlay { Capsule().stroke(MindMapStyle.line, lineWidth: 1) }
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .textSelection(.disabled)
        // quiet until the branch is pointed at, and while folded: the map is the labels, not the buttons
        .opacity(isFolded || emphasized || hovering ? 1 : 0.45)
        .onHover { hovering = $0 }
        .help(isFolded ? L("Unfold this branch") : L("Fold this branch"))
        .accessibilityLabel(isFolded ? L("Unfold this branch") : L("Fold this branch"))
        .accessibilityValue(L("%@ nodes", String(node.descendants)))
    }
}

/// The same tree as an indented outline, foldable as the map is: a node, and its branches under it behind a rule.
private struct MindMapOutlineRow: View {
    let node: MindMapFigure.Node
    let depth: Int
    @Binding var folded: Set<String>
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                MindMapLabel(node: node, depth: depth, outline: true)
                if depth > 0, !node.children.isEmpty {
                    MindMapFoldButton(node: node, folded: $folded, emphasized: hovering)
                }
            }
            .onHover { hovering = $0 }
            .padding(.bottom, depth == 0 ? 4 : 0)
            if !node.children.isEmpty, !folded.contains(node.id) {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(node.children) { child in
                        MindMapOutlineRow(node: child, depth: depth + 1, folded: $folded)
                    }
                }
                .padding(.leading, 14)
                .overlay(alignment: .leading) {
                    Rectangle().fill(Color.primary.opacity(0.16)).frame(width: 1)
                }
                .padding(.leading, 8)
            }
        }
    }
}

/**
 * Its one view at its own width up to `width`, wrapped at `width` past it: a
 * short label as wide as its text, a long one in lines. It is placed with the
 * proposal it was measured with, never its bounds, which rounding can leave a
 * hair narrower than the text and so truncate it.
 */
private struct WrapPast: Layout {
    let width: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let view = subviews.first else { return .zero }
        return view.sizeThatFits(measure(view))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let view = subviews.first else { return }
        view.place(at: bounds.origin, proposal: measure(view))
    }

    private func measure(_ view: LayoutSubview) -> ProposedViewSize {
        view.sizeThatFits(.unspecified).width <= width ? .unspecified : ProposedViewSize(width: width, height: nil)
    }
}

/* ----------------------------- the picture ----------------------------- */

/// The picture a map was read from, fetched from the service and shown under the map: what its reading is checked against.
private struct MindMapPicture: View {
    let path: String
    @EnvironmentObject private var model: AppModel
    @State private var image: NSImage?
    @State private var failure: String?

    private var name: String { (path as NSString).lastPathComponent }

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: image.size.width)
                    // a transparent picture reads on white, as it was drawn
                    .background(Color.white)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                    .accessibilityLabel(L("%@, the picture this map was read from", name))
            } else if let failure {
                Label(failure, systemImage: "exclamationmark.triangle")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            } else {
                ProgressView().controlSize(.small)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(12)
        .task(id: path) { await load() }
    }

    private func load() async {
        image = nil
        failure = nil
        do {
            let data = try await model.client().originalFile(at: path)
            guard !Task.isCancelled else { return }
            if let picture = NSImage(data: data) { image = picture } else { failure = L("This Mac cannot read %@", name) }
        } catch {
            guard !Task.isCancelled else { return }
            failure = error.localizedDescription
        }
    }
}

private enum MindMapStyle {
    static let line = Color(red: 0x4F / 255, green: 0x7C / 255, blue: 0xC4 / 255)
    static let root = Color(red: 0x3F / 255, green: 0x6F / 255, blue: 0xBF / 255)
    static let rootInk = Color(red: 0xF4 / 255, green: 0xF7 / 255, blue: 0xFB / 255)
    static let lineWidth: CGFloat = 1.5
    /// The line from a node to its branches' bar, and each branch's stub off the bar.
    static let gap: CGFloat = 18
    static let stub: CGFloat = 16
    static let corner: CGFloat = 8
    /// Past this a label wraps: some 26 characters, web/mindmap.css's 26em.
    static let labelWidth: CGFloat = 364
    static let pictureAnchor = "knode-mind-map-picture"
}
