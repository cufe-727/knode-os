import Foundation
import XCTest
@testable import KnodeOSApp

final class ConnectionStateTests: XCTestCase {
    @MainActor
    func testSwitchingToUnavailableServiceClearsAdministratorSetup() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        ProbeProtocol.reply = { request in
            if request.url?.host == "new.invalid" { return .failure(URLError(.cannotConnectToHost)) }
            return .json(request.url?.path == "/api/health" ? "{\"ok\":true}" : "{\"auth\":true,\"setupRequired\":true,\"canSetup\":true}")
        }
        await fixture.model.checkConnection()
        XCTAssertEqual(fixture.model.authInfo?.canSetup, true)

        fixture.model.applyConnection(Self.settings("new.invalid"))
        XCTAssertNil(fixture.model.authInfo)
        XCTAssertEqual(fixture.model.connectionState, .checking)
        try await waitFor { if case .unavailable = fixture.model.connectionState { return true }; return false }
        XCTAssertNil(fixture.model.authInfo)
        let message = await fixture.model.createAdministrator(username: "admin", password: "unused-test", confirmation: "unused-test")
        XCTAssertNotNil(message)
    }

    @MainActor
    func testLateAuthResponseCannotReplaceNewServicesState() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        let oldAuthStarted = expectation(description: "Old service auth request is in flight")
        ProbeProtocol.reply = { request in
            let old = request.url?.host == "old.invalid"
            if request.url?.path == "/api/health" {
                return .json("{\"ok\":true,\"dataRoot\":\"\(old ? "old" : "new")\"}")
            }
            if old {
                oldAuthStarted.fulfill()
                return .json("{\"auth\":true,\"setupRequired\":true,\"canSetup\":true}", delay: 0.25)
            }
            return .json("{\"auth\":true,\"setupRequired\":false,\"canSetup\":false}")
        }
        let oldCheck = Task { await fixture.model.checkConnection() }
        await fulfillment(of: [oldAuthStarted], timeout: 2)
        fixture.model.applyConnection(Self.settings("new.invalid"))
        try await waitFor { fixture.model.connectionState == .connected("new") }
        await oldCheck.value
        XCTAssertEqual(fixture.model.connectionState, .connected("new"))
        XCTAssertEqual(fixture.model.authInfo?.setupRequired, false)
        XCTAssertEqual(fixture.model.authInfo?.canSetup, false)
    }

    private static func settings(_ host: String) -> ConnectionSettings {
        var value = ConnectionSettings()
        value.mode = .remote
        value.remoteURL = "https://\(host)"
        return value
    }

    @MainActor
    private func waitFor(_ condition: () -> Bool) async throws {
        for _ in 0..<100 {
            if condition() { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("Connection state did not settle")
    }

    @MainActor
    private struct Fixture {
        let suite = "knode-connection-test-\(UUID().uuidString)"
        let defaults: UserDefaults
        let session: URLSession
        let model: AppModel

        init() throws {
            defaults = UserDefaults(suiteName: suite)!
            defaults.set(try JSONEncoder().encode(ConnectionStateTests.settings("old.invalid")), forKey: "knode-os.macos.connection.v1")
            let config = URLSessionConfiguration.ephemeral
            config.protocolClasses = [ProbeProtocol.self]
            session = URLSession(configuration: config)
            model = AppModel(defaults: defaults, connectsOnLaunch: false, probeSession: session)
        }

        func close() {
            model.shutdown()
            session.invalidateAndCancel()
            defaults.removePersistentDomain(forName: suite)
        }
    }
}

private final class ProbeProtocol: URLProtocol {
    enum Reply {
        case json(String, delay: TimeInterval = 0)
        case failure(Error)
    }

    nonisolated(unsafe) static var reply: ((URLRequest) -> Reply)!

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        switch Self.reply(request) {
        case .failure(let error): client?.urlProtocol(self, didFailWithError: error)
        case .json(let json, let delay):
            DispatchQueue.global().asyncAfter(deadline: .now() + delay) {
                let response = HTTPURLResponse(url: self.request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
                self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                self.client?.urlProtocol(self, didLoad: Data(json.utf8))
                self.client?.urlProtocolDidFinishLoading(self)
            }
        }
    }

    override func stopLoading() {}
}
