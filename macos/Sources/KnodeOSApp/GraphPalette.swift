import SwiftUI

/// An sRGB colour that can be mixed, for colours derived from the palette (a brighter ring, a tinted disc).
struct GraphRGB: Hashable {
    var r: Double
    var g: Double
    var b: Double

    init(r: Double, g: Double, b: Double) {
        self.r = r
        self.g = g
        self.b = b
    }

    init(_ hex: UInt32) {
        r = Double((hex >> 16) & 0xff) / 255
        g = Double((hex >> 8) & 0xff) / 255
        b = Double(hex & 0xff) / 255
    }

    static let white = GraphRGB(0xffffff)

    /// This colour moved toward `other` by `t`.
    func mix(_ other: GraphRGB, _ t: Double) -> GraphRGB {
        GraphRGB(r: r + (other.r - r) * t, g: g + (other.g - g) * t, b: b + (other.b - b) * t)
    }

    func lighter(_ t: Double) -> GraphRGB { mix(.white, t) }

    func color(_ opacity: Double = 1) -> Color {
        Color(.sRGB, red: r, green: g, blue: b, opacity: opacity)
    }
}

/**
 * The graph's colours and marks, the same as the web UI's (web/app.js
 * `ENTITY_COLORS`, web/graph.js `KnodeGraph.FAMILIES`): one colour and one SF
 * Symbol per entity type, and the relation families, which fold the
 * ontology's predicates into five coloured groups, a neutral "other typed"
 * for the generic, rare and unknown ones, and the derived co-occurrence. Each
 * family has a line pattern as well, so a relation reads without its colour.
 * The four common core types, the finance pack's common types (market, index,
 * sector, theme, fund) and the five family hues were checked to stay apart
 * under red-green colour blindness on the dark canvas; the rarer finance types
 * are distinct in normal vision and lean on their icons there.
 */
enum GraphPalette {
    struct Family: Identifiable, Hashable {
        let id: String
        /// English; the legend localizes it.
        let label: String
        let rgb: GraphRGB
        /// Evens out how strongly the hues read at rest: cyan is bright, the green dark.
        let boost: Double
        let dash: [CGFloat]
        let types: [String]

        var color: Color { rgb.color() }
    }

    static func typeRGB(_ type: String) -> GraphRGB {
        switch type.lowercased() {
        case "organization": GraphRGB(0xba7f02)
        case "product": GraphRGB(0xe5657b)
        case "concept": GraphRGB(0x9581ef)
        case "person": GraphRGB(0x09a0a0)
        case "location": GraphRGB(0x4b99d7)
        case "event": GraphRGB(0xc158ae)
        case "technology": GraphRGB(0x3db6cf)
        case "project": GraphRGB(0xd76549)
        case "component": GraphRGB(0x627ace)
        case "datasource": GraphRGB(0x7d8ea1)
        case "dataset": GraphRGB(0x8ca2ae)
        // the finance ontology pack
        case "market": GraphRGB(0x4170e9)
        case "index": GraphRGB(0xd6b529)
        case "security": GraphRGB(0xa6a266)
        case "fund": GraphRGB(0xcba1fa)
        case "sector": GraphRGB(0x148a53)
        case "theme": GraphRGB(0xe29f81)
        case "indicator": GraphRGB(0xc1ccd7)
        case "currency": GraphRGB(0x56d0af)
        case "commodity": GraphRGB(0xca564b)
        case "policy": GraphRGB(0xeda6c1)
        default: GraphRGB(0x7c8088)
        }
    }

    static func typeColor(_ type: String) -> Color { typeRGB(type).color() }

    /// The icon inside a node; the web draws matching vector icons.
    static func symbol(for type: String) -> String {
        switch type.lowercased() {
        case "organization": "building.2"
        case "product": "shippingbox"
        case "concept": "sparkle"
        case "person": "person"
        case "location": "mappin"
        case "event": "calendar"
        case "technology": "cpu"
        case "project": "flag"
        case "component": "puzzlepiece"
        case "datasource": "cylinder"
        case "dataset": "tablecells"
        // the finance ontology pack (all available since macOS 14)
        case "market": "building.columns"
        case "index": "chart.line.uptrend.xyaxis"
        case "security": "ticket"
        case "fund": "chart.pie"
        case "sector": "square.grid.2x2"
        case "theme": "tag"
        case "indicator": "gauge.with.needle"
        case "currency": "banknote"
        case "commodity": "drop"
        case "policy": "scroll"
        default: "ellipsis"
        }
    }

    static let families: [Family] = [
        Family(id: "structure", label: "Structure", rgb: GraphRGB(0x019aeb), boost: 1, dash: [],
               types: ["part_of", "member_of", "subsidiary_of", "located_in", "regulated_by"]),
        Family(id: "capital", label: "Capital", rgb: GraphRGB(0xbfaa03), boost: 1, dash: [7, 3],
               types: ["owns", "invested_in", "acquired"]),
        Family(id: "value", label: "Value chain", rgb: GraphRGB(0x08d7ee), boost: 0.85, dash: [],
               types: ["produces", "supplies_to", "uses", "depends_on"]),
        Family(id: "competition", label: "Competition", rgb: GraphRGB(0xfe9f9d), boost: 0.95, dash: [2.5, 2.5],
               types: ["competes_with", "contradicts"]),
        Family(id: "cooperation", label: "Cooperation & people", rgb: GraphRGB(0x1a9951), boost: 1.3, dash: [6, 2.5, 1.5, 2.5],
               types: ["partner_of", "works_at", "reports_to", "authored", "founded"]),
        Family(id: "other", label: "Other typed", rgb: GraphRGB(0x8a93a6), boost: 1, dash: [],
               types: ["related_to", "caused", "succeeded_by"]),
        Family(id: "cooccur", label: "Co-occurrence", rgb: GraphRGB(0x8a93a6), boost: 1, dash: [1.2, 3.2],
               types: ["co_occurs"]),
    ]

    static let otherTyped = families[5]
    static let cooccurrence = families[6]

    private static let byType: [String: Family] = Dictionary(
        families.flatMap { family in family.types.map { ($0, family) } },
        uniquingKeysWith: { first, _ in first }
    )

    /// The family a relation type draws as; anything the table does not name is "other typed".
    static func family(of type: String) -> Family {
        byType[type] ?? otherTyped
    }

    /// No direction to show: the relation reads the same both ways, or says nothing about direction.
    static let undirected: Set<String> = ["competes_with", "contradicts", "partner_of", "co_occurs", "related_to"]
}
