import Foundation
import XCTest
@testable import KnodeOSApp

/// The service's JSON through the decoder the app uses — snake_case keys are
/// rewritten, dictionary keys included, which is why the source families carry none.
final class EntityModelsTests: XCTestCase {
    private var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }

    func testAnEntityPageDecodesWithItsSourcesAndCounts() throws {
        let json = """
        {"items":[{"id":"e1","name":"Acme","type":"organization","description":"A company","aliases":["ACME","Acme Corp"],
          "wikiPath":"wiki/entities/acme.md","mentions":12,"documents":3,"relations":4,"evidence":5,
          "sources":{"llm":3,"wikilink":2},"canonicalId":null,"createdAt":"2026-10-01T00:00:00.000Z","updatedAt":"2026-10-19T09:00:00.000Z"},
         {"id":"e2","name":"Bob","type":"person","description":"","aliases":[],"wikiPath":null,"mentions":1,"documents":1,"relations":0,"evidence":1,
          "sources":{},"canonicalId":"e9","createdAt":null,"updatedAt":null}],
         "total":45474,"offset":50,"limit":50,"sort":"mentions","order":"desc","typeCounts":[{"type":"organization","n":30000},{"type":"person","n":15474}]}
        """
        let page = try decoder.decode(EntityPage.self, from: Data(json.utf8))
        XCTAssertEqual(page.total, 45474)
        XCTAssertEqual(page.offset, 50)
        XCTAssertEqual(page.typeCounts.map(\.n), [30000, 15474])
        let acme = page.items[0]
        XCTAssertEqual(acme.sources["llm"], 3)
        XCTAssertEqual(acme.sources["wikilink"], 2)
        XCTAssertEqual(acme.aliases, ["ACME", "Acme Corp"])
        XCTAssertEqual(acme.wikiPath, "wiki/entities/acme.md")
        XCTAssertEqual(acme.updatedKey, "2026-10-19T09:00:00.000Z")
        let bob = page.items[1]
        XCTAssertNil(bob.wikiPath)
        XCTAssertEqual(bob.canonicalId, "e9")
        XCTAssertEqual(bob.updatedKey, "")
        XCTAssertTrue(bob.sources.isEmpty)
    }

    func testGraphNodesCarryDegreeAndWikiPathWhenTheServiceSendsThem() throws {
        let json = """
        {"nodes":[{"id":"a","name":"A","type":"person","description":"","score":9850,"mentionCount":9850,"degree":12,"wikiPath":"wiki/a.md"},
                  {"id":"b","name":"B","type":"concept","description":"","score":0.5,"mentionCount":3}],
         "edges":[{"source":"a","target":"b","type":"co_occurs","description":"","weight":0.3}],"chunks":[]}
        """
        let reply = try decoder.decode(GraphResponse.self, from: Data(json.utf8))
        XCTAssertEqual(reply.nodes[0].degree, 12)
        XCTAssertEqual(reply.nodes[0].wikiPath, "wiki/a.md")
        XCTAssertNil(reply.nodes[1].degree)
        XCTAssertNil(reply.nodes[1].wikiPath)
        XCTAssertNil(reply.claims)
        XCTAssertEqual(reply.edges[0].type, "co_occurs")
    }
}
