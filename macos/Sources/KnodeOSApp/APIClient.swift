import Foundation

struct APIError: LocalizedError {
    var message: String
    var errorDescription: String? { message }
}

struct APIClient {
    let baseURL: URL
    let username: String
    let workspace: Workspace

    private var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }

    private var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }

    private enum Identity {
        case none
        case user
        case workspace
    }

    private func url(for path: String) throws -> URL {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw APIError(message: "Invalid service URL")
        }
        return url
    }

    private func userHeaders(_ request: inout URLRequest) {
        request.setValue(username.lowercased(), forHTTPHeaderField: "X-Knode-User")
    }

    private func workspaceHeaders(_ request: inout URLRequest) {
        userHeaders(&request)
        request.setValue(workspace.kind.rawValue, forHTTPHeaderField: "X-Knode-Workspace-Kind")
        request.setValue(workspace.id, forHTTPHeaderField: "X-Knode-Workspace-ID")
        request.setValue(workspace.name, forHTTPHeaderField: "X-Knode-Workspace-Name")
    }

    private func send<T: Decodable>(
        _ path: String,
        method: String = "GET",
        body: Data? = nil,
        identity: Identity = .workspace
    ) async throws -> T {
        var request = URLRequest(url: try url(for: path))
        request.httpMethod = method
        request.timeoutInterval = path == "/api/health" ? 3 : 360
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        switch identity {
        case .none: break
        case .user: userHeaders(&request)
        case .workspace: workspaceHeaders(&request)
        }

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError(message: "The service returned an invalid response")
        }
        guard (200..<300).contains(http.statusCode) else {
            let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let message = payload?["error"] as? String ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
            throw APIError(message: message)
        }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError(message: "Could not read the service response: \(error.localizedDescription)")
        }
    }

    private func encoded<T: Encodable>(_ value: T) throws -> Data {
        try encoder.encode(value)
    }

    private func path(_ endpoint: String, query: [URLQueryItem]) -> String {
        var components = URLComponents()
        components.path = endpoint
        components.queryItems = query
        return components.string ?? endpoint
    }

    func health() async throws -> ServerHealth {
        try await send("/api/health", identity: .none)
    }

    func workspaces() async throws -> [Workspace] {
        try await send("/api/workspaces", identity: .user)
    }

    func createWorkspace(name: String) async throws -> Workspace {
        struct Body: Encodable { var name: String }
        return try await send("/api/workspaces", method: "POST", body: encoded(Body(name: name)), identity: .user)
    }

    func clearWorkspace() async throws -> ActionResponse {
        try await send("/api/workspace", method: "DELETE")
    }

    func stats() async throws -> KnowledgeStats {
        try await send("/api/stats")
    }

    func tree() async throws -> TreeNode {
        try await send("/api/tree")
    }

    func file(at filePath: String) async throws -> FileResponse {
        try await send(path("/api/file", query: [.init(name: "path", value: filePath)]))
    }

    func resolveLink(_ target: String, from sourcePath: String) async throws -> ResolvedLinkResponse {
        try await send(path("/api/link/resolve", query: [
            .init(name: "target", value: target),
            .init(name: "from", value: sourcePath),
        ]))
    }

    func saveFile(path filePath: String, content: String) async throws -> ActionResponse {
        struct Body: Encodable { var path: String; var content: String }
        return try await send("/api/file", method: "PUT", body: encoded(Body(path: filePath, content: content)))
    }

    func deleteFile(path filePath: String) async throws -> ActionResponse {
        try await send(path("/api/file", query: [.init(name: "path", value: filePath)]), method: "DELETE")
    }

    func createDirectory(path directoryPath: String) async throws -> ActionResponse {
        struct Body: Encodable { var path: String }
        return try await send("/api/mkdir", method: "POST", body: encoded(Body(path: directoryPath)))
    }

    func move(from: String, to: String) async throws -> ActionResponse {
        struct Body: Encodable { var from: String; var to: String }
        return try await send("/api/mv", method: "POST", body: encoded(Body(from: from, to: to)))
    }

    func ingest() async throws -> IngestStats {
        try await send("/api/ingest", method: "POST", body: Data("{}".utf8))
    }

    func upload(files: [URL], directory: String = "raw/docs") async throws -> UploadResponse {
        let boundary = "KnodeBoundary-\(UUID().uuidString)"
        var body = Data()

        func append(_ string: String) {
            body.append(Data(string.utf8))
        }

        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"dir\"\r\n\r\n")
        append("\(directory)\r\n")
        for file in files {
            let accessing = file.startAccessingSecurityScopedResource()
            defer { if accessing { file.stopAccessingSecurityScopedResource() } }
            let data = try Data(contentsOf: file)
            append("--\(boundary)\r\n")
            append("Content-Disposition: form-data; name=\"files\"; filename=\"\(file.lastPathComponent)\"\r\n")
            append("Content-Type: application/octet-stream\r\n\r\n")
            body.append(data)
            append("\r\n")
        }
        append("--\(boundary)--\r\n")

        var request = URLRequest(url: try url(for: "/api/upload"))
        request.httpMethod = "POST"
        request.timeoutInterval = 360
        request.httpBody = body
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        workspaceHeaders(&request)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw APIError(message: payload?["error"] as? String ?? "Upload failed")
        }
        return try decoder.decode(UploadResponse.self, from: data)
    }

    func search(_ query: String, mode: SearchMode, limit: Int = 12) async throws -> [SearchResult] {
        try await send(path("/api/search", query: [
            .init(name: "q", value: query),
            .init(name: "mode", value: mode.rawValue),
            .init(name: "k", value: String(limit)),
        ]))
    }

    func ask(_ question: String) async throws -> AskResponse {
        struct Body: Encodable { var question: String }
        return try await send("/api/ask", method: "POST", body: encoded(Body(question: question)))
    }

    func graph(query: String, depth: Int) async throws -> GraphResponse {
        let items: [URLQueryItem] = query.isEmpty ? [] : [
            .init(name: "q", value: query),
            .init(name: "depth", value: String(depth)),
        ]
        return try await send(path("/api/graph", query: items))
    }

    func graphInsights() async throws -> GraphInsights {
        try await send("/api/graph/insights")
    }

    func traces() async throws -> [TraceItem] {
        try await send("/api/traces")
    }

    func syncTraces() async throws -> TraceSyncResponse {
        try await send("/api/traces/sync", method: "POST", body: Data("{}".utf8))
    }

    func suggestions() async throws -> [Suggestion] {
        try await send("/api/suggestions")
    }

    func updateSuggestion(id: String, status: String) async throws -> ActionResponse {
        struct Body: Encodable { var status: String }
        return try await send("/api/suggestions/\(id)/status", method: "POST", body: encoded(Body(status: status)))
    }

    func dream() async throws -> DreamResponse {
        try await send("/api/dream", method: "POST", body: Data("{}".utf8))
    }

    func config() async throws -> KnodeConfig {
        try await send("/api/config")
    }

    func testConfig(_ config: KnodeConfig) async throws -> ConfigTestResponse {
        try await send("/api/config/test", method: "POST", body: encoded(config))
    }

    func saveConfig(_ config: KnodeConfig) async throws -> ConfigSaveResponse {
        try await send("/api/config", method: "PUT", body: encoded(config))
    }
}
