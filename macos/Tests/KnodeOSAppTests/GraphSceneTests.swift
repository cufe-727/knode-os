import Foundation
import XCTest
@testable import KnodeOSApp

final class GraphSceneTests: XCTestCase {
    private func node(_ id: String, _ type: String, degree: Int? = nil) -> GraphNode {
        GraphNode(id: id, name: id.uppercased(), type: type, description: "", score: 1, mentionCount: 3, degree: degree, wikiPath: nil)
    }

    private func edge(_ a: String, _ b: String, _ type: String = "works_at", weight: Double = 1) -> GraphEdge {
        GraphEdge(source: a, target: b, type: type, description: "", weight: weight)
    }

    private var reply: GraphResponse {
        GraphResponse(
            nodes: [node("a", "person", degree: 9), node("b", "organization"), node("c", "concept"), node("d", "concept"), node("lone", "person")],
            edges: [edge("a", "b", weight: 2), edge("b", "c", "co_occurs", weight: 0.5), edge("a", "c", weight: 0.2), edge("c", "d", weight: 1)],
            chunks: [],
            claims: nil
        )
    }

    func testTheWholeReplyWithTheLegendAndAdjacency() {
        let scene = GraphScene(response: reply, settings: GraphSettings())
        XCTAssertEqual(scene.nodes.map(\.id), ["a", "b", "c", "d", "lone"])
        XCTAssertEqual(scene.edges.count, 4)
        XCTAssertEqual(scene.typeCounts.map(\.type), ["concept", "person", "organization"])
        XCTAssertEqual(scene.typeCounts.map(\.count), [2, 2, 1])
        // strongest neighbour first; the edge's own direction is kept
        XCTAssertEqual(scene.neighbours["a"]?.map(\.node.id), ["b", "c"])
        XCTAssertEqual(scene.neighbours["c"]?.map(\.node.id), ["d", "b", "a"])
        XCTAssertEqual(scene.neighbours["c"]?.map(\.outgoing), [true, false, false])
        XCTAssertEqual(scene.highlight(around: "b"), ["b", "a", "c"])
        XCTAssertEqual(scene.nodeSpecs(nodeSize: 1).map(\.rank), [0, 1, 2, 3, 4])
    }

    func testSizesFollowTheGlobalDegreeOrWhatIsInView() {
        let scene = GraphScene(response: reply, settings: GraphSettings())
        // a: the service's degree 9 → 3 + 2.2·3; b: no degree sent, two edges in view
        XCTAssertEqual(scene.radius(of: scene.byID["a"]!, nodeSize: 1), 9.6, accuracy: 0.001)
        XCTAssertEqual(scene.radius(of: scene.byID["b"]!, nodeSize: 1), 3 + 2.2 * 2.0.squareRoot(), accuracy: 0.001)
        XCTAssertEqual(scene.radius(of: scene.byID["lone"]!, nodeSize: 2), 6, accuracy: 0.001)
        XCTAssertEqual(scene.radius(of: node("hub", "person", degree: 400), nodeSize: 1), 22)
        XCTAssertTrue(scene.largest.contains("a"))
    }

    func testFiltersNarrowNodesAndEdgesTogether() {
        var settings = GraphSettings()
        settings.hiddenTypes = ["organization"]
        var scene = GraphScene(response: reply, settings: settings)
        XCTAssertEqual(scene.nodes.map(\.id), ["a", "c", "d", "lone"])
        XCTAssertEqual(scene.edges.count, 2)
        // the legend still lists the hidden type, so it can be shown again
        XCTAssertEqual(scene.typeCounts.map(\.type), ["concept", "person", "organization"])

        settings = GraphSettings()
        settings.cooccur = false
        settings.minWeight = 0.5
        settings.hideOrphans = true
        scene = GraphScene(response: reply, settings: settings)
        XCTAssertEqual(scene.edges.map { "\($0.source)-\($0.target)" }, ["a-b", "c-d"])
        XCTAssertEqual(scene.nodes.map(\.id), ["a", "b", "c", "d"])
        XCTAssertEqual(scene.linkSpecs.map(\.coOccurs), [false, false])
    }

    func testSettingsPersistAsJSONAndMissingKeysTakeDefaults() throws {
        var settings = GraphSettings()
        settings.limit = 300
        settings.hiddenTypes = ["event"]
        settings.repel = 420
        let restored = GraphSettings(json: settings.json)
        XCTAssertEqual(restored, settings)
        let partial = GraphSettings(json: #"{"limit":50,"arrows":true}"#)
        XCTAssertEqual(partial.limit, 50)
        XCTAssertTrue(partial.arrows)
        XCTAssertEqual(partial.linkDistance, 90)
        XCTAssertEqual(GraphSettings(json: "not json"), GraphSettings())
        XCTAssertEqual(GraphSettings(json: nil), GraphSettings())
        XCTAssertEqual(settings.forces, .init(center: 0.06, repel: 420, linkDistance: 90))
    }

    func testOnlyTheNodeCountAndAnOverviewsCoOccurrenceAskTheServiceAgain() {
        let old = GraphSettings()
        var new = old
        new.cooccur = false
        XCTAssertTrue(new.needsRefetch(from: old, overview: true))
        XCTAssertFalse(new.needsRefetch(from: old, overview: false))
        XCTAssertTrue(new.filtersDiffer(from: old))
        new = old
        new.limit = 400
        XCTAssertTrue(new.needsRefetch(from: old, overview: false))
        new = old
        new.nodeSize = 1.5
        new.center = 0.2
        XCTAssertFalse(new.needsRefetch(from: old, overview: true))
        XCTAssertFalse(new.filtersDiffer(from: old))
        XCTAssertNotEqual(new.forces, old.forces)
    }
}
