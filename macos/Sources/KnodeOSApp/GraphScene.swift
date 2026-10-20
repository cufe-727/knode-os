import Foundation

/**
 * The graph view's preferences: the same keys and defaults as the web graph's
 * `KnodeGraph.DEFAULTS`, so a layout settles alike on both. Persisted as JSON
 * under `knode.graph.settings.v1`; a key the stored copy lacks takes its
 * default, so a preference added later never breaks an older copy.
 */
struct GraphSettings: Codable, Equatable {
    /// Nodes to ask the service for: the top entities by mentions in an overview, the cap in a local graph.
    var limit = 150
    var hiddenTypes: [String] = []
    /// Relation families (`GraphPalette.Family.id`) left out; co-occurrence has its own switch, `cooccur`.
    var hiddenRelations: [String] = []
    var hideOrphans = false
    /// Draw the derived co-occurrence edges; in an overview, off also spares the service the join.
    var cooccur = true
    var minWeight = 0.0
    var nodeSize = 1.0
    var linkWidth = 1.0
    /// The zoom at which labels start to appear; below it only the largest nodes and the highlight keep theirs.
    var textFade = 1.0
    var arrows = false
    /// Keep a dragged node where it was dropped instead of letting the forces take it back.
    var pin = false
    /// Coronas round the nodes, light-blended relations and particles along a focused node's relations.
    var glow = true
    var center = 0.06
    var repel = 180.0
    var linkDistance = 90.0

    static let storageKey = "knode.graph.settings.v1"
    static let nodeCounts = [50, 100, 150, 200, 300, 400]

    enum CodingKeys: String, CodingKey {
        case limit, hiddenTypes, hiddenRelations, hideOrphans, cooccur, minWeight, nodeSize, linkWidth, textFade, arrows, pin, glow, center, repel, linkDistance
    }

    init() {}

    /// The stored copy, or the defaults when there is none or it does not parse.
    init(json: String?) {
        guard let json, let data = json.data(using: .utf8),
              let stored = try? JSONDecoder().decode(GraphSettings.self, from: data) else { return }
        self = stored
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let defaults = GraphSettings()
        limit = try c.decodeIfPresent(Int.self, forKey: .limit) ?? defaults.limit
        hiddenTypes = try c.decodeIfPresent([String].self, forKey: .hiddenTypes) ?? defaults.hiddenTypes
        hiddenRelations = try c.decodeIfPresent([String].self, forKey: .hiddenRelations) ?? defaults.hiddenRelations
        hideOrphans = try c.decodeIfPresent(Bool.self, forKey: .hideOrphans) ?? defaults.hideOrphans
        cooccur = try c.decodeIfPresent(Bool.self, forKey: .cooccur) ?? defaults.cooccur
        minWeight = try c.decodeIfPresent(Double.self, forKey: .minWeight) ?? defaults.minWeight
        nodeSize = try c.decodeIfPresent(Double.self, forKey: .nodeSize) ?? defaults.nodeSize
        linkWidth = try c.decodeIfPresent(Double.self, forKey: .linkWidth) ?? defaults.linkWidth
        textFade = try c.decodeIfPresent(Double.self, forKey: .textFade) ?? defaults.textFade
        arrows = try c.decodeIfPresent(Bool.self, forKey: .arrows) ?? defaults.arrows
        pin = try c.decodeIfPresent(Bool.self, forKey: .pin) ?? defaults.pin
        glow = try c.decodeIfPresent(Bool.self, forKey: .glow) ?? defaults.glow
        center = try c.decodeIfPresent(Double.self, forKey: .center) ?? defaults.center
        repel = try c.decodeIfPresent(Double.self, forKey: .repel) ?? defaults.repel
        linkDistance = try c.decodeIfPresent(Double.self, forKey: .linkDistance) ?? defaults.linkDistance
    }

    var json: String {
        guard let data = try? JSONEncoder().encode(self) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }

    var forces: GraphSimulation.Forces {
        .init(center: center, repel: repel, linkDistance: linkDistance)
    }

    /// Changes only the service can answer: the node count, and co-occurrence in an overview, which it computes.
    func needsRefetch(from old: GraphSettings, overview: Bool) -> Bool {
        limit != old.limit || (overview && cooccur != old.cooccur)
    }

    /// Changes to which nodes and edges the reply shows.
    func filtersDiffer(from old: GraphSettings) -> Bool {
        hiddenTypes != old.hiddenTypes || hiddenRelations != old.hiddenRelations || hideOrphans != old.hideOrphans
            || cooccur != old.cooccur || minWeight != old.minWeight
    }
}

/**
 * What the canvas shows: the service's reply under the current filters, with
 * the adjacency that hover and the side panel read. Node sizes follow links
 * the way Obsidian's do: the global typed degree when the service sent it,
 * else what is in view. Each node has two sizes: `radius` is what the layout
 * keeps apart, `displayRadius` what is drawn. The relations between a pair of
 * nodes fold into one `Bundle`: one line on the canvas, one edge to click,
 * one neighbour in the side panel; the layout still pulls along every
 * relation (`linkSpecs`).
 */
struct GraphScene {
    struct Neighbour {
        let node: GraphNode
        /// The primary relation between them.
        let edge: GraphEdge
        /// The primary relation leaves the node this neighbour belongs to.
        let outgoing: Bool
        /// Every distinct relation between them.
        let bundle: Bundle
    }

    /**
     * The relations between one pair of nodes. They are the distinct ones (a
     * type once per direction, at its strongest reading), most specific first:
     * the five coloured families, then other typed, then co-occurrence, each by
     * weight. The first, the primary, gives the line its family and its ends.
     */
    struct Bundle: Identifiable {
        /// The pair's ids in order, the same whichever way its relations run.
        let id: String
        /// The primary relation's source and target.
        let a: String
        let b: String
        let relations: [GraphEdge]
        /// The strongest relation's weight.
        let weight: Double
        /// A directed relation runs a → b.
        let forward: Bool
        /// A directed relation runs b → a.
        let backward: Bool

        var primary: GraphEdge { relations[0] }

        static func id(_ x: String, _ y: String) -> String { x < y ? "\(x)|\(y)" : "\(y)|\(x)" }
    }

    private(set) var nodes: [GraphNode] = []
    private(set) var edges: [GraphEdge] = []
    private(set) var byID: [String: GraphNode] = [:]
    /// Position in the service's ranking, what seeds the layout.
    private(set) var rank: [String: Int] = [:]
    /// One per neighbour, strongest first.
    private(set) var neighbours: [String: [Neighbour]] = [:]
    /// One per pair of nodes in view, in the order their first relation came.
    private(set) var bundles: [Bundle] = []
    private var bundleIndex: [String: Int] = [:]
    private(set) var inViewDegree: [String: Int] = [:]
    /// Types in the reply with how many nodes each has, most first: the legend, before any type is hidden.
    private(set) var typeCounts: [(type: String, count: Int)] = []
    /// Relation families in the reply with how many edges each has, in the palette's order: the legend's
    /// second row. Co-occurrence is always listed, since an overview without it does not fetch it.
    private(set) var familyCounts: [(family: GraphPalette.Family, count: Int)] = []
    /// The twelve largest nodes keep their label however far out the view is.
    private(set) var largest: Set<String> = []
    /// log(1 + degree) across the nodes in view, what `displayRadius` spreads over.
    private var logDegrees: ClosedRange<Double> = 0...0

    init() {}

    init(response: GraphResponse, settings: GraphSettings) {
        var counts: [String: Int] = [:]
        for node in response.nodes { counts[node.type, default: 0] += 1 }
        typeCounts = counts
            .sorted { $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value }
            .map { (type: $0.key, count: $0.value) }
        var perFamily: [String: Int] = [:]
        for edge in response.edges { perFamily[GraphPalette.family(of: edge.type).id, default: 0] += 1 }
        familyCounts = GraphPalette.families
            .map { (family: $0, count: perFamily[$0.id] ?? 0) }
            .filter { $0.count > 0 || $0.family.id == GraphPalette.cooccurrence.id }
        for (i, node) in response.nodes.enumerated() where rank[node.id] == nil { rank[node.id] = i }

        let hidden = Set(settings.hiddenTypes)
        let hiddenFamilies = Set(settings.hiddenRelations)
        let kept = response.nodes.filter { !hidden.contains($0.type) }
        let ids = Set(kept.map(\.id))
        let shownEdges = response.edges.filter { edge in
            ids.contains(edge.source) && ids.contains(edge.target) && edge.source != edge.target
                && (settings.cooccur || edge.type != "co_occurs") && edge.weight >= settings.minWeight
                && !hiddenFamilies.contains(GraphPalette.family(of: edge.type).id)
        }
        var linked = Set<String>()
        for edge in shownEdges {
            linked.insert(edge.source)
            linked.insert(edge.target)
        }
        nodes = settings.hideOrphans ? kept.filter { linked.contains($0.id) } : kept
        edges = shownEdges
        byID = Dictionary(nodes.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for edge in edges {
            inViewDegree[edge.source, default: 0] += 1
            inViewDegree[edge.target, default: 0] += 1
        }
        bundles = Self.bundle(edges)
        bundleIndex = Dictionary(bundles.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first })
        for bundle in bundles {
            guard let a = byID[bundle.a], let b = byID[bundle.b] else { continue }
            neighbours[bundle.a, default: []].append(Neighbour(node: b, edge: bundle.primary, outgoing: true, bundle: bundle))
            neighbours[bundle.b, default: []].append(Neighbour(node: a, edge: bundle.primary, outgoing: false, bundle: bundle))
        }
        for key in neighbours.keys { neighbours[key]?.sort { $0.bundle.weight > $1.bundle.weight } }
        largest = Set(nodes.sorted { degree(of: $0) > degree(of: $1) }.prefix(12).map(\.id))
        let logs = nodes.map { log1p(Double(degree(of: $0))) }
        if let lo = logs.min(), let hi = logs.max() { logDegrees = lo...hi }
    }

    func degree(of node: GraphNode) -> Int {
        node.degree ?? inViewDegree[node.id] ?? 0
    }

    func degree(ofID id: String) -> Int {
        byID[id].map { degree(of: $0) } ?? 0
    }

    /// The layout's radius, from links: nodeSize × (3 + 2.2·√degree), capped at nodeSize × 22. Nodes used to be drawn at it.
    func radius(of node: GraphNode, nodeSize: Double) -> Double {
        nodeSize * min(22, 3 + 2.2 * Double(degree(of: node)).squareRoot())
    }

    /**
     * The drawn radius: log(1 + degree) spread across the nodes in view onto
     * 4–18, times nodeSize. A top-150 overview has hundreds of links per
     * node, so `radius` caps almost all of them at the same 22; this keeps
     * hubs apart from the rest, and drawn smaller than the layout keeps them
     * apart, nodes have room between them.
     */
    func displayRadius(of node: GraphNode, nodeSize: Double) -> Double {
        let span = logDegrees.upperBound - logDegrees.lowerBound
        let t = span > 0 ? (log1p(Double(degree(of: node))) - logDegrees.lowerBound) / span : 0.5
        return nodeSize * (4 + 14 * min(1, max(0, t)))
    }

    /// A node with its neighbours in view: what hover and selection light up.
    func highlight(around id: String) -> Set<String> {
        Set([id] + (neighbours[id]?.map(\.node.id) ?? []))
    }

    func bundle(_ id: String) -> Bundle? {
        bundleIndex[id].map { bundles[$0] }
    }

    /// Fold relations into one bundle per pair of nodes, in the order each pair first appears.
    static func bundle(_ edges: [GraphEdge]) -> [Bundle] {
        func rank(_ edge: GraphEdge) -> Int {
            edge.type == "co_occurs" ? 2 : GraphPalette.family(of: edge.type).id == GraphPalette.otherTyped.id ? 1 : 0
        }
        var order: [String] = []
        var distinct: [String: [String: GraphEdge]] = [:]
        for edge in edges {
            let pair = Bundle.id(edge.source, edge.target)
            // an undirected type is one relation whichever end it was written from
            let key = GraphPalette.undirected.contains(edge.type) ? edge.type : "\(edge.type)|\(edge.source)"
            if distinct[pair] == nil { order.append(pair) }
            if let seen = distinct[pair]?[key], seen.weight >= edge.weight { continue }
            distinct[pair, default: [:]][key] = edge
        }
        return order.map { pair in
            let relations = distinct[pair]!.values.sorted { m, n in
                rank(m) != rank(n) ? rank(m) < rank(n) : m.weight != n.weight ? m.weight > n.weight : m.type < n.type
            }
            let primary = relations[0]
            let directed = relations.filter { !GraphPalette.undirected.contains($0.type) }
            return Bundle(
                id: pair, a: primary.source, b: primary.target, relations: relations,
                weight: relations.map(\.weight).max() ?? 0,
                forward: directed.contains { $0.source == primary.source },
                backward: directed.contains { $0.source == primary.target }
            )
        }
    }

    /**
     * The node under a point on screen: on its drawn disc or within 5 points
     * of it, and always within 10 points of its centre; the nearest when
     * several reach. Kept that tight so the edges between nodes stay easy to
     * click. `position` says where a node is drawn.
     */
    func node(near point: CGPoint, scale: CGFloat, nodeSize: Double, position: (String) -> CGPoint?) -> GraphNode? {
        var best: GraphNode?
        var bestDistance = CGFloat.infinity
        for node in nodes {
            guard let p = position(node.id) else { continue }
            let d = hypot(p.x - point.x, p.y - point.y)
            let reach = max(10, max(displayRadius(of: node, nodeSize: nodeSize) * scale, 3) + 5)
            if d <= reach && d < bestDistance {
                best = node
                bestDistance = d
            }
        }
        return best
    }

    /// The bundle whose line passes nearest a point on screen, within `reach` points. `position` says where a node is drawn.
    func bundle(near point: CGPoint, reach: CGFloat = 6, position: (String) -> CGPoint?) -> Bundle? {
        var best: Bundle?
        var bestDistance = reach
        for bundle in bundles {
            guard let a = position(bundle.a), let b = position(bundle.b) else { continue }
            let dx = b.x - a.x
            let dy = b.y - a.y
            let length2 = dx * dx + dy * dy
            guard length2 > 0 else { continue }
            let u = max(0, min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length2))
            let d = hypot(point.x - (a.x + u * dx), point.y - (a.y + u * dy))
            if d < bestDistance {
                best = bundle
                bestDistance = d
            }
        }
        return best
    }

    func nodeSpecs(nodeSize: Double) -> [GraphSimulation.NodeSpec] {
        nodes.map { node in
            .init(id: node.id, rank: rank[node.id] ?? 0, degree: degree(of: node), radius: radius(of: node, nodeSize: nodeSize))
        }
    }

    var linkSpecs: [GraphSimulation.LinkSpec] {
        edges.map { .init(source: $0.source, target: $0.target, weight: $0.weight, coOccurs: $0.type == "co_occurs", type: $0.type) }
    }
}
