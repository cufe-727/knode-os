import AppKit
import SwiftUI

/// Where a graph read came from: the overview, or the local graph around a name.
private enum GraphMode: Equatable {
    case overview
    case search(String)
}

/**
 * Knowledge → Graph: the knowledge graph the way Obsidian draws one. A force
 * layout (`GraphSimulation`, d3-force's integrator) settles and sleeps; nodes
 * are sized by their links and coloured by type; hovering isolates a
 * neighbourhood; the view zooms, pans and lets nodes be dragged; labels fade
 * in with zoom. An empty search is the overview — the top entities by
 * mentions — and a name is the local graph around it, ranked by relevance.
 */
struct KnowledgeGraphView: View {
    @EnvironmentObject private var model: AppModel
    @AppStorage(GraphSettings.storageKey) private var settingsJSON = ""
    @State private var settings: GraphSettings
    @State private var query = ""
    @State private var depth = 2
    @State private var mode = GraphMode.overview
    @State private var response: GraphResponse?
    @State private var scene = GraphScene()
    @State private var sim = GraphSimulation()
    @State private var selectedNodeID: String?
    @State private var insights: GraphInsights?
    @State private var isLoading = true
    @State private var showingInsights = false
    @State private var showingSettings = false
    /// Bumped on every reply: the canvas returns to the origin at scale 1.
    @State private var generation = 0
    /// Bumped whenever the layout is warmed up again: the canvas resumes ticking.
    @State private var heat = 0

    init() {
        _settings = State(initialValue: GraphSettings(json: UserDefaults.standard.string(forKey: GraphSettings.storageKey)))
    }

    private var selectedNode: GraphNode? {
        selectedNodeID.flatMap { scene.byID[$0] }
    }

    private var isSearch: Bool {
        if case .search = mode { return true }
        return false
    }

    var body: some View {
        VStack(spacing: 0) {
            graphBar
            Divider()
            if isLoading && response == nil {
                ProgressView(L("Building graph view…"))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let response, !response.nodes.isEmpty {
                HSplitView {
                    ZStack(alignment: .topLeading) {
                        GraphCanvas(scene: scene, sim: sim, settings: settings, generation: generation, heat: heat, selectedID: $selectedNodeID) { node in
                            query = node.name
                            Task { await loadGraph() }
                        }
                        legend
                            .padding(12)
                        caption
                            .padding(12)
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                    }
                    .frame(minWidth: 500, maxWidth: .infinity, maxHeight: .infinity)
                    sidePanel(response)
                        .frame(minWidth: 330, idealWidth: 390, maxWidth: 480)
                }
            } else {
                EmptyState(
                    symbol: "point.3.connected.trianglepath.dotted",
                    title: L("The graph is empty"),
                    message: L("Index documents with wikilinks or configure entity extraction to create nodes and relations."),
                    actionTitle: L("Go to Files"),
                    action: { model.select(.files) }
                )
            }
        }
        .background(Color(nsColor: .textBackgroundColor).opacity(0.22))
        .task {
            // Entities → Explore in graph hands the name over through the model
            if let pending = model.consumePendingGraphQuery() { query = pending }
            await loadGraph()
        }
        .onChange(of: settings) { old, new in apply(old, new) }
        .sheet(isPresented: $showingInsights) {
            InsightsSheet(insights: insights)
        }
    }

    /* -------------------------------- bars -------------------------------- */

    private var graphBar: some View {
        HStack(spacing: 10) {
            Image(systemName: "point.3.connected.trianglepath.dotted")
                .foregroundStyle(Color.knodeViolet)
            TextField(L("Graph search — entity, product, concept…"), text: $query)
                .textFieldStyle(.plain)
                .font(.title3)
                .onSubmit { Task { await loadGraph() } }
            Picker(L("Depth"), selection: $depth) {
                Text(L("1 hop")).tag(1)
                Text(L("2 hops")).tag(2)
                Text(L("3 hops")).tag(3)
            }
            .frame(width: 110)
            Button(L("Explore")) { Task { await loadGraph() } }
                .buttonStyle(.borderedProminent)
                .tint(.knodeViolet)
                .disabled(isLoading)
            if isSearch {
                Button(L("Overview")) {
                    query = ""
                    Task { await loadGraph() }
                }
                .disabled(isLoading)
            }
            Button("Insights", systemImage: "chart.bar.xaxis") { Task { await loadInsights() } }
                .disabled(isLoading)
            Button(L("Settings"), systemImage: "slider.horizontal.3") { showingSettings.toggle() }
                .popover(isPresented: $showingSettings, arrowEdge: .bottom) {
                    GraphSettingsPanel(settings: $settings)
                }
            if isLoading { ProgressView().controlSize(.small) }
        }
        .padding(.horizontal, 18)
        .frame(height: 60)
        .background(.bar)
    }

    /// One chip per type in the reply, with its count; a click hides or shows that type.
    private var legend: some View {
        HStack(spacing: 6) {
            ForEach(scene.typeCounts, id: \.type) { item in
                let hidden = settings.hiddenTypes.contains(item.type)
                Button { toggle(type: item.type) } label: {
                    HStack(spacing: 5) {
                        Circle()
                            .fill(nodeColor(item.type))
                            .frame(width: 7, height: 7)
                        Text("\(item.type) · \(item.count.formatted())")
                            .font(.caption2)
                            .strikethrough(hidden)
                    }
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(.thickMaterial, in: Capsule())
                    .opacity(hidden ? 0.5 : 1)
                }
                .buttonStyle(.plain)
                .help(L("Hide or show this type"))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .clipped()
    }

    /// What the canvas shows and how big it is.
    private var caption: some View {
        let hops = depth == 1 ? L("1 hop") : L("%@ hops", String(depth))
        let what: String = switch mode {
        case .overview: L("overview · top %@ by mentions", String(settings.limit))
        case .search(let name): L("local graph · “%@” · %@ · ranked by relevance", name, hops)
        }
        return Text(L("%@ · %@ nodes · %@ edges", what, scene.nodes.count.formatted(), scene.edges.count.formatted()))
            .font(.caption2.monospaced())
            .foregroundStyle(.secondary)
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(.thickMaterial, in: Capsule())
    }

    private func toggle(type: String) {
        if let i = settings.hiddenTypes.firstIndex(of: type) {
            settings.hiddenTypes.remove(at: i)
        } else {
            settings.hiddenTypes.append(type)
        }
    }

    /* ------------------------------ side panel ----------------------------- */

    private func sidePanel(_ response: GraphResponse) -> some View {
        VStack(spacing: 0) {
            if let node = selectedNode {
                selectedCard(node)
                Divider()
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if let node = selectedNode {
                        neighbourList(node)
                        claimList(node)
                    } else {
                        topList(response)
                    }
                    if !response.chunks.isEmpty {
                        chunkList(response.chunks)
                    }
                }
                .padding(14)
            }
        }
        .background(.ultraThinMaterial)
    }

    private func selectedCard(_ node: GraphNode) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                RouteBadge(label: node.type, color: nodeColor(node.type))
                Spacer()
                Button { selectedNodeID = nil } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .help(L("Clear selection"))
            }
            Text(node.name).font(.title2.bold())
            if !node.description.isEmpty {
                Text(node.description).font(.callout).foregroundStyle(.secondary)
            }
            Text(numbers(node))
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
            HStack(spacing: 8) {
                Button(L("Local graph"), systemImage: "arrow.triangle.branch") {
                    query = node.name
                    Task { await loadGraph() }
                }
                .buttonStyle(.borderedProminent)
                .tint(.knodeViolet)
                Button(L("Open wiki page"), systemImage: "book.closed") {
                    if let path = node.wikiPath { model.openFile(path) }
                }
                .disabled(node.wikiPath == nil)
                .help(node.wikiPath.map { L("Open %@", $0) } ?? L("No wiki page yet"))
            }
            .controlSize(.small)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.knodeViolet.opacity(0.07))
    }

    /// Mentions in an overview; in a search also the relevance to the query, which is what ranked the node.
    private func numbers(_ node: GraphNode) -> String {
        var parts = [L("%@ mentions", String(node.mentionCount)), L("degree %@", String(scene.degree(of: node)))]
        if isSearch { parts.insert(L("relevance %@", String(format: "%.2f", node.score)), at: 0) }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder
    private func neighbourList(_ node: GraphNode) -> some View {
        let neighbours = scene.neighbours[node.id] ?? []
        Text(neighbours.isEmpty ? L("No neighbours in view") : L("%@ neighbours in view", String(neighbours.count)))
            .font(.headline)
        ForEach(Array(neighbours.prefix(40).enumerated()), id: \.offset) { _, item in
            Button { selectedNodeID = item.node.id } label: {
                HStack(spacing: 8) {
                    RouteBadge(label: item.node.type, color: nodeColor(item.node.type))
                    Text(item.node.name)
                        .font(.callout)
                        .lineLimit(1)
                    Spacer()
                    Text(String(format: "%@ %.1f", item.edge.type == "co_occurs" ? L("co-occurs") : item.edge.type, item.edge.weight))
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                }
                .padding(9)
                .contentShape(Rectangle())
                .background(Color.white.opacity(0.025), in: RoundedRectangle(cornerRadius: 9))
                .overlay { RoundedRectangle(cornerRadius: 9).stroke(Color.white.opacity(0.07)) }
            }
            .buttonStyle(.plain)
        }
    }

    @ViewBuilder
    private func claimList(_ node: GraphNode) -> some View {
        let claims = claims(for: node).prefix(5)
        if !claims.isEmpty {
            Divider().padding(.vertical, 8)
            Text(L("Claims")).font(.headline)
            ForEach(Array(claims)) { claim in
                Label(claim.statement, systemImage: "seal")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }
        }
    }

    @ViewBuilder
    private func topList(_ response: GraphResponse) -> some View {
        HStack {
            Text(L("Entities")).font(.headline)
            Spacer()
            Text(L("%@ nodes · %@ relations", String(scene.nodes.count), String(scene.edges.count)))
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
        }
        ForEach(scene.nodes.prefix(40)) { node in
            Button { selectedNodeID = node.id } label: {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        RouteBadge(label: node.type, color: nodeColor(node.type))
                        Text(node.name).font(.callout.weight(.semibold)).lineLimit(1)
                        Spacer()
                    }
                    Text(numbers(node))
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                    if !node.description.isEmpty {
                        Text(node.description).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                    ForEach(claims(for: node).prefix(2)) { claim in
                        Label(claim.statement, systemImage: "seal")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
                .padding(11)
                .contentShape(Rectangle())
                .background(Color.white.opacity(0.025), in: RoundedRectangle(cornerRadius: 9))
                .overlay { RoundedRectangle(cornerRadius: 9).stroke(Color.white.opacity(0.07)) }
            }
            .buttonStyle(.plain)
        }
    }

    @ViewBuilder
    private func chunkList(_ chunks: [SearchResult]) -> some View {
        var seen = Set<String>()
        let paths = chunks.map(\.path).filter { seen.insert($0).inserted }
        Divider().padding(.vertical, 8)
        Text(L("Grounded in")).font(.headline)
        ForEach(paths, id: \.self) { path in
            Button { model.openFile(path) } label: {
                Label(path, systemImage: "doc.text")
                    .font(.caption.monospaced())
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.knodeCyan)
        }
    }

    private func claims(for node: GraphNode) -> [Claim] {
        (response?.claims ?? []).filter { $0.subject == node.name }
    }

    /* -------------------------------- data -------------------------------- */

    /// A preference changed: keep it, then do the least that shows it.
    private func apply(_ old: GraphSettings, _ new: GraphSettings) {
        settingsJSON = new.json
        guard response != nil else { return }
        if new.needsRefetch(from: old, overview: !isSearch) {
            Task { await loadGraph() }
            return
        }
        if new.filtersDiffer(from: old) {
            rebuildScene(alpha: 0.3)
        } else if new.nodeSize != old.nodeSize {
            let scene = scene
            sim.resize { node in scene.byID[node.id].map { scene.radius(of: $0, nodeSize: new.nodeSize) } ?? node.r }
            sim.reheat(0.2)
            heat += 1
        }
        if new.forces != old.forces {
            sim.forces = new.forces
            sim.reheat(0.6)
            heat += 1
        }
    }

    /// The visible subset under the current filters; positions carry over, so a toggle does not scatter the view.
    private func rebuildScene(alpha: Double) {
        guard let response else { return }
        scene = GraphScene(response: response, settings: settings)
        sim.load(nodes: scene.nodeSpecs(nodeSize: settings.nodeSize), links: scene.linkSpecs, alpha: alpha)
        if let selectedNodeID, scene.byID[selectedNodeID] == nil { self.selectedNodeID = nil }
        heat += 1
    }

    private func loadGraph() async {
        isLoading = true
        defer { isLoading = false }
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            // the co-occurrence join is the slow part of an overview: skip it when it will not be drawn
            let reply = try await model.client().graph(
                query: text,
                depth: depth,
                limit: settings.limit,
                edges: text.isEmpty && !settings.cooccur ? "typed" : nil
            )
            mode = text.isEmpty ? .overview : .search(text)
            response = reply
            selectedNodeID = nil
            sim.reset()
            rebuildScene(alpha: 1)
            // a local graph opens on the entity it was asked for
            if !text.isEmpty {
                selectedNodeID = scene.nodes.first { $0.name.caseInsensitiveCompare(text) == .orderedSame }?.id ?? scene.nodes.first?.id
            }
            generation += 1
            await model.refreshStats()
        } catch {
            response = nil
            selectedNodeID = nil
            model.showError(error, prefix: "Graph failed")
        }
    }

    private func loadInsights() async {
        isLoading = true
        defer { isLoading = false }
        do {
            insights = try await model.client().graphInsights()
            showingInsights = true
        } catch {
            model.showError(error, prefix: "Insights failed")
        }
    }
}

/* ================================ canvas ================================ */

/**
 * The drawing and the pointer. A `TimelineView` drives the simulation one
 * tick a frame until it settles, then pauses, so a still graph costs nothing;
 * a drag, a filter or a slider resumes it. Everything is drawn under one
 * translate-and-scale, except labels, which are drawn in screen space at a
 * fixed 11 pt — the same as 11 / scale in world space, without re-laying the
 * text out for every zoom step.
 */
private struct GraphCanvas: View {
    let scene: GraphScene
    let sim: GraphSimulation
    let settings: GraphSettings
    let generation: Int
    let heat: Int
    @Binding var selectedID: String?
    /// A double-click on a node: open the local graph around it.
    let onOpen: (GraphNode) -> Void

    @State private var scale: CGFloat = 1
    /// Where the world's origin sits, relative to the canvas centre.
    @State private var pan = CGSize.zero
    @State private var hoveredID: String?
    @State private var paused = false
    @State private var drag: DragState?
    @State private var magnifyStart: CGFloat?
    @State private var lastTap: (id: String, at: Date)?

    private enum DragState {
        case node(String)
        case pan(CGSize)
    }

    private static let background = Color(red: 0.045, green: 0.052, blue: 0.066)
    private static let edgeColor = Color(red: 140 / 255, green: 150 / 255, blue: 170 / 255)
    private static let labelColor = Color(white: 0.86)
    /// What everything outside a hovered neighbourhood fades to.
    private static let dim = 0.12
    /// How far from a node's centre, in screen points, a pointer still counts as on it.
    private static let hitPoints: CGFloat = 18
    private static let zoomRange: ClosedRange<CGFloat> = 0.15...8

    var body: some View {
        GeometryReader { geometry in
            let size = geometry.size
            TimelineView(.animation(paused: paused)) { _ in
                Canvas(rendersAsynchronously: false) { context, size in
                    step()
                    draw(in: context, size: size)
                }
            }
            .background(ScrollWheelCatcher { event in handleScroll(event, size: size) })
            .contentShape(Rectangle())
            .gesture(dragGesture(size: size))
            .simultaneousGesture(magnifyGesture(size: size))
            .onContinuousHover(coordinateSpace: .local) { phase in
                switch phase {
                case .active(let point):
                    let id = sim.node(at: world(point, size), hit: Self.hitPoints / scale)?.id
                    if id != hoveredID { hoveredID = id }
                case .ended:
                    hoveredID = nil
                }
            }
        }
        .background(Self.background)
        .onChange(of: generation) {
            scale = 1
            pan = .zero
            hoveredID = nil
            paused = false
        }
        .onChange(of: heat) { paused = false }
    }

    /// One tick a frame while there is heat; the frame after it settles, pause.
    private func step() {
        guard !paused else { return }
        if sim.settled {
            DispatchQueue.main.async { paused = true }
        } else {
            sim.tick()
        }
    }

    /* ------------------------------- drawing ------------------------------ */

    private func draw(in context: GraphicsContext, size: CGSize) {
        let nodes = sim.nodes
        guard !nodes.isEmpty else { return }
        let k = scale
        let origin = CGPoint(x: size.width / 2 + pan.width, y: size.height / 2 + pan.height)
        var g = context
        g.translateBy(x: origin.x, y: origin.y)
        g.scaleBy(x: k, y: k)

        // the viewport in world units, so what is off screen costs nothing
        let x0 = -origin.x / k
        let y0 = -origin.y / k
        let x1 = (size.width - origin.x) / k
        let y1 = (size.height - origin.y) / k
        func inView(_ n: GraphSimulation.Node) -> Bool {
            n.x + n.r >= x0 && n.x - n.r <= x1 && n.y + n.r >= y0 && n.y - n.r <= y1
        }

        // what stands out: a hovered or selected node with its neighbours
        let focus = hoveredID ?? selectedID
        let highlight = focus.map { scene.highlight(around: $0) }
        func lit(_ link: GraphSimulation.Link) -> Bool {
            guard let focus else { return false }
            return nodes[link.a].id == focus || nodes[link.b].id == focus
        }

        // edges, one stroke per style: a few dozen strokes a frame instead of thousands
        struct Style: Hashable {
            let co: Bool
            let lit: Bool
            let alpha: Int
            let width: Int
        }
        var buckets: [Style: Path] = [:]
        for link in sim.links {
            let a = nodes[link.a]
            let b = nodes[link.b]
            if !inView(a) && !inView(b) { continue }
            var alpha = link.coOccurs ? 0.07 + 0.2 * min(1, link.weight / 3) : 0.18 + 0.4 * min(1, link.weight / 4)
            let isLit = highlight != nil && lit(link)
            if highlight != nil { alpha = isLit ? max(alpha, 0.55) : alpha * Self.dim }
            let width = settings.linkWidth * (0.6 + min(2, 0.3 * link.weight)) / Double(k).squareRoot()
            let style = Style(co: link.coOccurs, lit: isLit, alpha: Int((alpha * 20).rounded()), width: Int((width * 4).rounded()))
            buckets[style, default: Path()].move(to: a.point)
            buckets[style, default: Path()].addLine(to: b.point)
        }
        for (style, path) in buckets.sorted(by: { ($0.key.co ? 0 : 1) < ($1.key.co ? 0 : 1) }) {
            let alpha = Double(style.alpha) / 20
            guard alpha > 0 else { continue }
            let color = (style.lit ? Color.knodeCyan : Self.edgeColor).opacity(alpha)
            let width = Double(style.width) / 4
            g.stroke(path, with: .color(color), style: StrokeStyle(lineWidth: width, dash: style.co ? [4 / k, 4 / k] : []))
        }

        if settings.arrows && k >= 0.7 {
            var arrows = Path()
            let s = 6 / Double(k)
            for link in sim.links where !link.coOccurs {
                let a = nodes[link.a]
                let b = nodes[link.b]
                guard inView(b), highlight == nil || lit(link) else { continue }
                let dx = b.x - a.x
                let dy = b.y - a.y
                let d = max(hypot(dx, dy), 1)
                let ux = dx / d
                let uy = dy / d
                let tx = b.x - ux * (b.r + 1)
                let ty = b.y - uy * (b.r + 1)
                arrows.move(to: CGPoint(x: tx, y: ty))
                arrows.addLine(to: CGPoint(x: tx - ux * s - uy * s * 0.5, y: ty - uy * s + ux * s * 0.5))
                arrows.addLine(to: CGPoint(x: tx - ux * s + uy * s * 0.5, y: ty - uy * s - ux * s * 0.5))
                arrows.closeSubpath()
            }
            g.fill(arrows, with: .color(Self.edgeColor.opacity(0.7)))
        }

        for n in nodes where inView(n) {
            let dimmed = highlight.map { !$0.contains(n.id) } ?? false
            let color = nodeColor(scene.byID[n.id]?.type ?? "").opacity(dimmed ? Self.dim : 1)
            let circle = Path(ellipseIn: CGRect(x: n.x - n.r, y: n.y - n.r, width: n.r * 2, height: n.r * 2))
            g.fill(circle, with: .color(color))
            if n.id == selectedID {
                g.stroke(circle, with: .color(.white), lineWidth: 2 / k)
            } else if n.pinned != nil {
                g.stroke(circle, with: .color(Self.labelColor.opacity(0.6)), lineWidth: 1.5 / k)
            }
        }

        // labels fade in with zoom; far out, only the largest nodes and the highlight keep theirs
        let labelAlpha = max(0, min(1, (Double(k) - settings.textFade) / 0.35))
        context.drawLayer { layer in
            layer.addFilter(.shadow(color: Self.background.opacity(0.95), radius: 2))
            for n in nodes where inView(n) {
                let forced = highlight?.contains(n.id) == true || n.id == selectedID
                if highlight != nil && !forced { continue }
                let alpha = forced ? 1 : labelAlpha >= 0.05 ? labelAlpha : (scene.largest.contains(n.id) ? 0.9 : 0)
                guard alpha > 0, let node = scene.byID[n.id] else { continue }
                let name = node.name.count > 28 ? String(node.name.prefix(27)) + "…" : node.name
                let at = CGPoint(x: origin.x + (n.x + n.r) * k + 4, y: origin.y + n.y * k)
                layer.opacity = alpha
                layer.draw(Text(name).font(.system(size: 11)).foregroundColor(Self.labelColor), at: at, anchor: .leading)
            }
        }
    }

    /* ------------------------------- pointer ------------------------------ */

    private func world(_ point: CGPoint, _ size: CGSize) -> CGPoint {
        CGPoint(x: (point.x - size.width / 2 - pan.width) / scale, y: (point.y - size.height / 2 - pan.height) / scale)
    }

    /// A press on a node drags it (pinned, with the layout kept warm); a press elsewhere pans. A press that did not move is a click.
    private func dragGesture(size: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .local)
            .onChanged { value in
                if drag == nil {
                    let start = world(value.startLocation, size)
                    if let node = sim.node(at: start, hit: Self.hitPoints / scale) {
                        drag = .node(node.id)
                        sim.pin(node.id, at: start)
                        sim.alphaTarget = 0.3
                        paused = false
                    } else {
                        drag = .pan(pan)
                    }
                }
                switch drag {
                case .node(let id):
                    sim.pin(id, at: world(value.location, size))
                case .pan(let start):
                    pan = CGSize(width: start.width + value.translation.width, height: start.height + value.translation.height)
                case nil:
                    break
                }
            }
            .onEnded { value in
                let moved = hypot(value.translation.width, value.translation.height)
                switch drag {
                case .node(let id):
                    sim.alphaTarget = 0
                    if !settings.pin { sim.unpin(id) }
                    if moved < 3 { tap(id) }
                case .pan:
                    if moved < 3 { tap(nil) }
                case nil:
                    break
                }
                drag = nil
            }
    }

    /// A click selects; a second one on the same node within 0.4 s opens its local graph; a click on nothing clears.
    private func tap(_ id: String?) {
        guard let id else {
            selectedID = nil
            lastTap = nil
            return
        }
        if let last = lastTap, last.id == id, Date().timeIntervalSince(last.at) < 0.4 {
            lastTap = nil
            if let node = scene.byID[id] { onOpen(node) }
            return
        }
        lastTap = (id, Date())
        selectedID = id
    }

    private func magnifyGesture(size: CGSize) -> some Gesture {
        MagnifyGesture()
            .onChanged { value in
                let start = magnifyStart ?? scale
                magnifyStart = start
                zoom(to: start * value.magnification, about: value.startLocation, size: size)
            }
            .onEnded { _ in magnifyStart = nil }
    }

    /// Change the scale while the world point under `anchor` stays put.
    private func zoom(to target: CGFloat, about anchor: CGPoint, size: CGSize) {
        let next = min(max(target, Self.zoomRange.lowerBound), Self.zoomRange.upperBound)
        let fixed = world(anchor, size)
        scale = next
        pan = CGSize(width: anchor.x - size.width / 2 - fixed.x * next, height: anchor.y - size.height / 2 - fixed.y * next)
    }

    /// Plain scrolling pans; ⌘-scrolling zooms about the pointer.
    private func handleScroll(_ event: ScrollWheelEvent, size: CGSize) {
        if event.command {
            zoom(to: scale * pow(2, event.deltaY * (event.precise ? 0.01 : 0.1)), about: event.location, size: size)
        } else {
            let unit: CGFloat = event.precise ? 1 : 12
            pan = CGSize(width: pan.width + event.deltaX * unit, height: pan.height + event.deltaY * unit)
        }
    }
}

/* ============================= scroll wheel ============================= */

struct ScrollWheelEvent {
    var deltaX: CGFloat
    var deltaY: CGFloat
    /// Trackpad deltas are in points; a mouse wheel's are in lines.
    var precise: Bool
    var command: Bool
    /// Where the pointer is, from the catcher's top-left corner.
    var location: CGPoint
}

/**
 * Takes the scroll wheel over the view it backs: SwiftUI has no scroll
 * gesture of its own on the Mac, so a local event monitor — the way the model
 * picker watches for clicks outside its list — hands over the wheel events
 * that land inside this view's frame, consumed. It never takes a click.
 */
private struct ScrollWheelCatcher: NSViewRepresentable {
    let onScroll: (ScrollWheelEvent) -> Void

    func makeNSView(context: Context) -> CatcherView {
        let view = CatcherView()
        view.onScroll = onScroll
        view.install()
        return view
    }

    func updateNSView(_ view: CatcherView, context: Context) {
        view.onScroll = onScroll
    }

    static func dismantleNSView(_ view: CatcherView, coordinator: ()) {
        view.uninstall()
    }

    final class CatcherView: NSView {
        var onScroll: ((ScrollWheelEvent) -> Void)?
        private var monitor: Any?

        override var isFlipped: Bool { true }

        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        func install() {
            monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
                let taken = MainActor.assumeIsolated { self?.take(event) ?? false }
                return taken ? nil : event
            }
        }

        func uninstall() {
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
        }

        /// Whether the event landed on this view and was handed over.
        private func take(_ event: NSEvent) -> Bool {
            guard let window, event.window === window else { return false }
            let point = convert(event.locationInWindow, from: nil)
            guard bounds.contains(point) else { return false }
            onScroll?(ScrollWheelEvent(
                deltaX: event.scrollingDeltaX,
                deltaY: event.scrollingDeltaY,
                precise: event.hasPreciseScrollingDeltas,
                command: event.modifierFlags.contains(.command),
                location: point
            ))
            return true
        }
    }
}

/* =============================== settings =============================== */

/// The popover behind the toolbar's Settings button: filters, display and the forces, each a live control.
private struct GraphSettingsPanel: View {
    @Binding var settings: GraphSettings

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Eyebrow(text: L("Filters"), color: .knodeViolet)
            Picker(L("Nodes"), selection: $settings.limit) {
                ForEach(GraphSettings.nodeCounts, id: \.self) { n in Text(String(n)).tag(n) }
            }
            Toggle(L("Co-occurrence edges"), isOn: $settings.cooccur)
            Toggle(L("Hide orphans"), isOn: $settings.hideOrphans)
            SettingSlider(label: L("Min edge weight"), value: $settings.minWeight, range: 0...5, step: 0.1, digits: 1)
            Divider()
            Eyebrow(text: L("Display"), color: .knodeViolet)
            SettingSlider(label: L("Node size"), value: $settings.nodeSize, range: 0.5...2, step: 0.05, digits: 2)
            SettingSlider(label: L("Link thickness"), value: $settings.linkWidth, range: 0.5...3, step: 0.1, digits: 1)
            SettingSlider(label: L("Text fade"), value: $settings.textFade, range: 0.4...2.5, step: 0.05, digits: 2)
            Toggle(L("Arrows on typed edges"), isOn: $settings.arrows)
            Toggle(L("Keep dragged nodes where dropped"), isOn: $settings.pin)
            Divider()
            Eyebrow(text: L("Forces"), color: .knodeViolet)
            SettingSlider(label: L("Center"), value: $settings.center, range: 0...0.3, step: 0.01, digits: 2)
            SettingSlider(label: L("Repel"), value: $settings.repel, range: 50...600, step: 10, digits: 0)
            SettingSlider(label: L("Link distance"), value: $settings.linkDistance, range: 30...250, step: 5, digits: 0)
            HStack {
                Spacer()
                Button(L("Reset")) { settings = GraphSettings() }
            }
        }
        .padding(16)
        .frame(width: 300)
    }
}

private struct SettingSlider: View {
    let label: String
    @Binding var value: Double
    let range: ClosedRange<Double>
    let step: Double
    let digits: Int

    var body: some View {
        VStack(spacing: 2) {
            HStack {
                Text(label).font(.caption)
                Spacer()
                Text(value.formatted(.number.precision(.fractionLength(digits))))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            Slider(value: $value, in: range, step: step)
        }
    }
}

/* =============================== insights =============================== */

private struct InsightsSheet: View {
    let insights: GraphInsights?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Eyebrow(text: L("Graph health"), color: .knodeViolet)
                    Text(L("Knowledge graph insights")).font(.title.bold())
                }
                Spacer()
                Button(L("Done")) { dismiss() }.keyboardShortcut(.defaultAction)
            }
            if let insights {
                HStack(spacing: 12) {
                    InsightMetric(value: insights.totals.entities, label: L("Entities"))
                    InsightMetric(value: insights.totals.relations, label: L("Relations"))
                    InsightMetric(value: insights.totals.mentions, label: L("Mentions"))
                }
                HStack(alignment: .top, spacing: 18) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(L("Hubs")).font(.headline)
                        ForEach(insights.hubs) { hub in
                            HStack { Text(hub.name); Spacer(); Text(L("degree %@", String(hub.degree))).font(.caption.monospaced()).foregroundStyle(.secondary) }
                        }
                    }
                    .knodeCard()
                    VStack(alignment: .leading, spacing: 8) {
                        Text(L("Entity types")).font(.headline)
                        ForEach(insights.typeCounts) { item in
                            HStack { RouteBadge(label: item.type, color: nodeColor(item.type)); Spacer(); Text(item.n.formatted()).monospacedDigit() }
                        }
                    }
                    .knodeCard()
                }
                if !insights.isolated.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(L("Isolated entities")).font(.headline)
                        Text(insights.isolated.map(\.name).joined(separator: " · "))
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    .knodeCard()
                }
            } else {
                ProgressView()
            }
        }
        .padding(26)
        .frame(width: 720)
    }
}

private struct InsightMetric: View {
    let value: Int
    let label: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(value.formatted()).font(.system(size: 28, weight: .bold, design: .rounded))
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .knodeCard()
    }
}
