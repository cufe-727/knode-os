import Foundation

struct APIError: LocalizedError {
    var message: String
    /// The machine-readable `reason` a route sends alongside `error`, when it
    /// sends one — a screen can then act on the cause rather than the prose.
    var reason: String?
    var status: Int?
    var errorDescription: String? { message }

    init(message: String, reason: String? = nil, status: Int? = nil) {
        self.message = message
        self.reason = reason
        self.status = status
    }

    /// The session is over: expired, ended elsewhere, or the password changed.
    var sessionEnded: Bool { status == 401 && reason == "auth" }
}

struct APIClient {
    let baseURL: URL
    let username: String
    let workspace: Workspace
    /// The session token (`knu_…`) sent as a bearer token; nil before signing in.
    var token: String? = nil
    /// The shared session, or one that trusts a pinned self-signed certificate.
    var urlSession: URLSession = .shared

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
        // the service acts for the signed-in account; the name only matters to one with sign-in off
        request.setValue(username.lowercased(), forHTTPHeaderField: "X-Knode-User")
    }

    private func authorize(_ request: inout URLRequest) {
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    }

    private func failure(_ data: Data, _ http: HTTPURLResponse, fallback: String? = nil) -> APIError {
        let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let message = payload?["error"] as? String ?? fallback ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
        return APIError(message: message, reason: payload?["reason"] as? String, status: http.statusCode)
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
        authorize(&request)

        let (data, response) = try await urlSession.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError(message: "The service returned an invalid response")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw failure(data, http)
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

    /// A quote or line break in a multipart filename would end the header
    /// early, so neither ever reaches the wire.
    private func headerSafe(_ name: String) -> String {
        name
            .replacingOccurrences(of: "\r", with: "")
            .replacingOccurrences(of: "\n", with: "")
            .replacingOccurrences(of: "\"", with: "%22")
    }

    private func path(_ endpoint: String, query: [URLQueryItem]) -> String {
        var components = URLComponents()
        components.path = endpoint
        components.queryItems = query.isEmpty ? nil : query
        return components.string ?? endpoint
    }

    func health() async throws -> ServerHealth {
        try await send("/api/health", identity: .none)
    }

    /* ----------------------------- processing ----------------------------- */

    func labelingStatus() async throws -> LabelingStatusResponse {
        try await send("/api/labeling/status")
    }

    /// Start or stop extraction, reviews and summaries — an administrator's call.
    func setProcessing(_ running: Bool) async throws -> ProcessingSwitchResponse {
        try await send(running ? "/api/labeling/start" : "/api/labeling/stop", method: "POST", body: Data("{}".utf8))
    }

    /// What starting the processing would take: calls, tokens, time, transfer, cost, each plan's share.
    func processingEstimate() async throws -> TaskEstimate {
        try await send("/api/labeling/estimate")
    }

    /* ------------------------------ sign-in ------------------------------ */

    func authState() async throws -> AuthState {
        try await send("/api/auth/state", identity: .none)
    }

    /// Signs in for a bearer token (`client: app`); the service never sets a cookie for it.
    func login(username: String, password: String, label: String) async throws -> AuthSnapshot {
        struct Body: Encodable { var username: String; var password: String; var client = "app"; var label: String }
        return try await send("/api/auth/login", method: "POST", body: encoded(Body(username: username, password: password, label: label)), identity: .none)
    }

    /// The first account, which only a client on the service's own machine may create.
    func setup(username: String, password: String, label: String) async throws -> AuthSnapshot {
        struct Body: Encodable { var username: String; var password: String; var client = "app"; var label: String }
        return try await send("/api/auth/setup", method: "POST", body: encoded(Body(username: username, password: password, label: label)), identity: .none)
    }

    func logout() async throws -> ActionResponse {
        try await send("/api/auth/logout", method: "POST", body: Data("{}".utf8), identity: .none)
    }

    func me() async throws -> AuthSnapshot {
        try await send("/api/auth/me", identity: .none)
    }

    /// Answers a fresh token: every other session of the account ends.
    func changePassword(current: String, new password: String) async throws -> AuthRenewal {
        struct Body: Encodable { var current: String; var password: String }
        return try await send("/api/auth/password", method: "POST", body: encoded(Body(current: current, password: password)), identity: .none)
    }

    func authSessions() async throws -> [AuthSessionRow] {
        try await send("/api/auth/sessions", identity: .none)
    }

    func endSession(id: String) async throws -> ActionResponse {
        try await send("/api/auth/sessions/\(segment(id))", method: "DELETE", identity: .none)
    }

    func signOutOthers() async throws -> AuthRenewal {
        try await send("/api/auth/signout-others", method: "POST", body: Data("{}".utf8), identity: .none)
    }

    func adminUsers() async throws -> AdminUsersResponse {
        try await send("/api/auth/users", identity: .none)
    }

    func createUser(_ draft: AdminUserDraft) async throws -> AuthAccount {
        try await send("/api/auth/users", method: "POST", body: encoded(draft), identity: .none)
    }

    func updateUser(_ username: String, _ draft: AdminUserDraft) async throws -> AuthAccount {
        try await send("/api/auth/users/\(segment(username))", method: "PATCH", body: encoded(draft), identity: .none)
    }

    func removeUser(_ username: String) async throws -> ActionResponse {
        try await send("/api/auth/users/\(segment(username))", method: "DELETE", identity: .none)
    }

    func signOutUser(_ username: String) async throws -> ActionResponse {
        try await send("/api/auth/users/\(segment(username))/signout", method: "POST", body: Data("{}".utf8), identity: .none)
    }

    func gateways() async throws -> [GatewayRecord] {
        try await send("/api/auth/gateways", identity: .none)
    }

    func addGateway(id: String, target: String, description: String, sandbox: Bool) async throws -> GatewayRecord {
        struct Body: Encodable { var id: String; var target: String; var description: String; var sandbox: Bool }
        return try await send("/api/auth/gateways", method: "POST", body: encoded(Body(id: id, target: target, description: description, sandbox: sandbox)), identity: .none)
    }

    func removeGateway(id: String) async throws -> ActionResponse {
        try await send("/api/auth/gateways/\(segment(id))", method: "DELETE", identity: .none)
    }

    private func segment(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? value
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

    /// A folder `depth` levels down — 1 for its own entries, the way the file
    /// browser opens folders — or its whole subtree without one.
    /// `directoriesOnly` leaves the files out.
    func tree(path folder: String = ".", depth: Int? = nil, directoriesOnly: Bool = false) async throws -> TreeNode {
        var query = [URLQueryItem(name: "path", value: folder.isEmpty ? "." : folder)]
        if let depth { query.append(.init(name: "depth", value: String(depth))) }
        if directoriesOnly { query.append(.init(name: "dirs", value: "1")) }
        return try await send(path("/api/tree", query: query))
    }

    /// Reads a file. Without `maxBytes` the service caps the read at its preview
    /// limit and answers `truncated`; pass a cap to pull the whole file for editing.
    /// `lang` asks for a document in a reading language: its translation when
    /// there is one, else the original, with `languages.shown` saying which.
    /// An older service ignores it.
    func file(at filePath: String, maxBytes: Int? = nil, lang: String? = nil) async throws -> FileResponse {
        var query = [URLQueryItem(name: "path", value: filePath)]
        if let maxBytes { query.append(.init(name: "maxBytes", value: String(maxBytes))) }
        if let lang, !lang.isEmpty { query.append(.init(name: "lang", value: lang)) }
        return try await send(path("/api/file", query: query))
    }

    /// Asks for a document in another of the workspace's languages — the
    /// Translate stage takes it next — or, with `cancel`, withdraws the request.
    func requestTranslation(path filePath: String, lang: String, cancel: Bool = false) async throws -> TranslationRequestResponse {
        struct Body: Encodable { var path: String; var lang: String; var cancel: Bool? }
        return try await send("/api/file/translate", method: "POST", body: encoded(Body(path: filePath, lang: lang, cancel: cancel ? true : nil)))
    }

    /// The languages knode-os knows and the workspace's content languages. An
    /// older service answers 404.
    func languages() async throws -> LanguagesResponse {
        try await send("/api/languages")
    }

    /// The file itself, as bytes: a PDF or a picture as it is, a web page with
    /// its script turned off and its links pointing back at its site. An older
    /// service answers 404.
    func originalFile(at filePath: String) async throws -> Data {
        var request = URLRequest(url: try url(for: path("/api/file/original", query: [.init(name: "path", value: filePath)])))
        request.timeoutInterval = 360
        workspaceHeaders(&request)
        authorize(&request)
        let (data, response) = try await urlSession.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError(message: "The service returned an invalid response")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw failure(data, http, fallback: http.statusCode == 404 ? "This service cannot open originals yet — update it" : nil)
        }
        return data
    }

    /// A study as one HTML file — the report, then the pages, its charts as
    /// numbered figures — to read, save or print. An older service answers 404.
    func studyExport(id: String) async throws -> Data {
        let study = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        var request = URLRequest(url: try url(for: "/api/research/studies/\(study)/export"))
        request.timeoutInterval = 120
        workspaceHeaders(&request)
        authorize(&request)
        let (data, response) = try await urlSession.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError(message: "The service returned an invalid response")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw failure(data, http, fallback: http.statusCode == 404 ? "This service cannot export studies yet — update it" : nil)
        }
        return data
    }

    /// The wiki pages citing a raw/docs file. An older service answers 404.
    func fileCitations(at filePath: String) async throws -> FileCitationsResponse {
        try await send(path("/api/file/citations", query: [.init(name: "path", value: filePath)]))
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
        try await upload(items: files.map { UploadItem(name: $0.lastPathComponent, url: $0) }, directory: directory)
    }

    /// Multipart upload. Each item's `name` is sent as the multipart filename,
    /// which the service joins onto `directory` — that is how a folder upload
    /// recreates its subtree instead of flattening it.
    func upload(items: [UploadItem], directory: String = "raw/docs") async throws -> UploadResponse {
        let boundary = "KnodeBoundary-\(UUID().uuidString)"
        var body = Data()

        func append(_ string: String) {
            body.append(Data(string.utf8))
        }

        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"dir\"\r\n\r\n")
        append("\(directory)\r\n")
        for item in items {
            let accessing = item.url.startAccessingSecurityScopedResource()
            defer { if accessing { item.url.stopAccessingSecurityScopedResource() } }
            let data = try Data(contentsOf: item.url)
            append("--\(boundary)\r\n")
            append("Content-Disposition: form-data; name=\"files\"; filename=\"\(headerSafe(item.name))\"\r\n")
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
        authorize(&request)

        let (data, response) = try await urlSession.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError(message: "Upload failed") }
        guard (200..<300).contains(http.statusCode) else { throw failure(data, http, fallback: "Upload failed") }
        return try decoder.decode(UploadResponse.self, from: data)
    }

    /// `sources` is a path prefix, e.g. `raw/docs/reports` — the same vocabulary
    /// the file tree speaks, which is what lets Search scope to a picked folder.
    func search(_ query: String, mode: SearchMode, limit: Int = 12, sources: String? = nil) async throws -> [SearchResult] {
        var items: [URLQueryItem] = [
            .init(name: "q", value: query),
            .init(name: "mode", value: mode.rawValue),
            .init(name: "k", value: String(limit)),
        ]
        if let sources, !sources.isEmpty { items.append(.init(name: "sources", value: sources)) }
        return try await send(path("/api/search", query: items))
    }

    /// Explore → Search: the retrieval the agents use, asked to explain itself
    /// (docs/design/20 §2). `mode` is hybrid, sag (multi-hop), vector or
    /// keyword; `sources` a path prefix, as for `search`.
    func explore(_ query: String, mode: String, limit: Int = 20, sources: String? = nil) async throws -> ExploreResponse {
        var items: [URLQueryItem] = [
            .init(name: "q", value: query),
            .init(name: "mode", value: mode),
            .init(name: "k", value: String(limit)),
        ]
        if let sources, !sources.isEmpty { items.append(.init(name: "sources", value: sources)) }
        return try await send(path("/api/search/explore", query: items))
    }

    /// Entities and documents whose names hold `query`, for the search field.
    func suggest(_ query: String, limit: Int = 5) async throws -> SuggestResponse {
        try await send(path("/api/search/suggest", query: [
            .init(name: "q", value: query),
            .init(name: "limit", value: String(limit)),
        ]))
    }

    /// Tasks → Queue: the pipeline, the calls out now, workers, jobs, background work and the schedule.
    func tasks() async throws -> TasksSnapshot {
        try await send("/api/tasks")
    }

    /// What linking (or importing) `source` — a folder on the service's machine — into `dest` would carry.
    func previewFolder(source: String, dest: String) async throws -> FolderImportPlan {
        struct Body: Encodable { var source: String; var dest: String }
        return try await send("/api/folders/preview", method: "POST", body: encoded(Body(source: source, dest: dest)))
    }

    /// Mirror a folder of the service's machine under raw/docs: `link` keeps it in sync, `copy` copies it once.
    func importFolder(source: String, dest: String, mode: String, replace: Bool) async throws -> FolderImportResult {
        struct Body: Encodable { var source: String; var dest: String; var mode: String; var replace: Bool }
        return try await send("/api/folders/import", method: "POST", body: encoded(Body(source: source, dest: dest, mode: mode, replace: replace)))
    }

    /// Ask Feishu now which linked documents (and wiki pages) were edited, and
    /// fetch those: every link in the background, or the one mirrored at
    /// `dest` before answering; `force` fetches regardless of edits.
    func checkFeishu(dest: String? = nil, force: Bool = false) async throws -> FeishuCheck {
        struct Body: Encodable { var dest: String?; var force: Bool }
        return try await send("/api/feishu/sync", method: "POST", body: encoded(Body(dest: dest, force: force)))
    }

    /* -------------------------- code repositories -------------------------- */

    /// The repositories kept under raw/codebase, and what is fetching (docs/design/25).
    func codebases() async throws -> CodebaseListing {
        try await send("/api/codebases")
    }

    /// Fetch a repository onto the service's machine and index it, in the background.
    func addCodebase(_ draft: CodebaseDraft) async throws -> CodebaseStarted {
        try await send("/api/codebases/add", method: "POST", body: encoded(draft))
    }

    /// Fetch one repository's tracked ref again and index what changed, in the background.
    func updateCodebase(name: String, reindex: Bool = false) async throws -> CodebaseStarted {
        struct Body: Encodable { var name: String; var reindex: Bool; var wait: Bool }
        return try await send("/api/codebases/update", method: "POST", body: encoded(Body(name: name, reindex: reindex, wait: false)))
    }

    /// Tasks → Code repositories → Check now: every followed repository, fetched again in the background.
    func checkCodebases() async throws -> CodebaseStarted {
        struct Body: Encodable { var followed: Bool; var wait: Bool }
        return try await send("/api/codebases/update", method: "POST", body: encoded(Body(followed: true, wait: false)))
    }

    /// Change what a repository tracks; the next update applies it.
    func editCodebase(_ patch: CodebasePatch) async throws -> ActionResponse {
        try await send("/api/codebases", method: "PATCH", body: encoded(patch))
    }

    /// Forget a repository: its files, card and docs copy go too unless `keepFiles`.
    func removeCodebase(name: String, keepFiles: Bool) async throws -> CodebaseRemoval {
        try await send(path("/api/codebases", query: [
            .init(name: "name", value: name),
            .init(name: "keepFiles", value: keepFiles ? "1" : "0"),
        ]), method: "DELETE")
    }

    /// Add the new exchanges of every followed agent conversation now, in the
    /// background, without waiting for them to go quiet (docs/design/24).
    func checkConversations() async throws -> ConversationCheck {
        struct Body: Encodable {}
        return try await send("/api/conversations/sync", method: "POST", body: encoded(Body()))
    }

    /// An empty query is the overview — the top entities by mentions, `limit`
    /// of them, `types` only, with (`edges` = all) or without (`typed`) the
    /// derived co-occurrence edges. A name is the local graph `depth` hops
    /// around it, where `limit` caps the nodes and the other two do not apply.
    func graph(query: String, depth: Int, limit: Int? = nil, types: [String] = [], edges: String? = nil) async throws -> GraphResponse {
        var items: [URLQueryItem] = []
        if query.isEmpty {
            if !types.isEmpty { items.append(.init(name: "types", value: types.joined(separator: ","))) }
            if let edges { items.append(.init(name: "edges", value: edges)) }
        } else {
            items.append(.init(name: "q", value: query))
            items.append(.init(name: "depth", value: String(depth)))
        }
        if let limit { items.append(.init(name: "limit", value: String(limit))) }
        return try await send(path("/api/graph", query: items))
    }

    /// One page of Knowledge → Entities, filtered, sorted and counted by the
    /// service. `order` left nil takes the order the sort reads best in:
    /// counts and dates largest first, names and types A to Z.
    func entities(
        q: String = "",
        types: [String] = [],
        sort: String = "mentions",
        order: String? = nil,
        offset: Int = 0,
        limit: Int = 50,
        merged: Bool = false
    ) async throws -> EntityPage {
        var items: [URLQueryItem] = []
        if !q.isEmpty { items.append(.init(name: "q", value: q)) }
        if !types.isEmpty { items.append(.init(name: "type", value: types.joined(separator: ","))) }
        items.append(.init(name: "sort", value: sort))
        if let order { items.append(.init(name: "order", value: order)) }
        items.append(.init(name: "offset", value: String(offset)))
        items.append(.init(name: "limit", value: String(limit)))
        if merged { items.append(.init(name: "merged", value: "1")) }
        return try await send(path("/api/entities", query: items))
    }

    /// The known entities a text names, for a Markdown view to mark; `path` adds what that file was indexed with.
    func entityMentions(text: String, path filePath: String?) async throws -> EntityMentionsResponse {
        struct Body: Encodable { var text: String; var path: String? }
        return try await send("/api/entities/mentions", method: "POST", body: encoded(Body(text: text, path: filePath)))
    }

    /// One entity with its relations, co-mentions, claims and documents: the panel a marked name opens.
    func entityDetail(id: String) async throws -> EntityDetail {
        try await send(path("/api/entities/detail", query: [.init(name: "id", value: id)]))
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

    /// What a person should know about the workspace: lint findings, trace collection, purpose, initialization, datasources.
    func notices() async throws -> NoticesResponse {
        try await send("/api/notices")
    }

    func syncDatasources() async throws -> DatasourceSyncResponse {
        try await send("/api/datasources/sync", method: "POST", body: Data("{}".utf8))
    }

    func suggestions() async throws -> [Suggestion] {
        try await send("/api/suggestions")
    }

    func updateSuggestion(id: String, status: String) async throws -> ActionResponse {
        struct Body: Encodable { var status: String }
        return try await send("/api/suggestions/\(id)/status", method: "POST", body: encoded(Body(status: status)))
    }

    func researchJobs() async throws -> [ResearchJob] {
        try await send("/api/research/jobs?limit=40")
    }

    func researchPages() async throws -> [ResearchPage] {
        try await send("/api/research/pages")
    }

    func researchRecommendations() async throws -> [ResearchRecommendation] {
        try await send("/api/research/recommendations")
    }

    func queueResearch(kind: String, target: String?, query: String?) async throws -> QueueResearchResponse {
        struct Body: Encodable { var kind: String; var target: String?; var query: String? }
        return try await send("/api/research/jobs", method: "POST", body: encoded(Body(kind: kind, target: target, query: query)))
    }

    func cancelResearch(id: String) async throws -> [String: Bool] {
        try await send("/api/research/jobs/\(id)/cancel", method: "POST", body: Data("{}".utf8))
    }

    func retryResearch(id: String) async throws -> ResearchJob {
        try await send("/api/research/jobs/\(id)/retry", method: "POST", body: Data("{}".utf8))
    }

    /// The initialization card: the survey, the guide and the newest init job.
    func initStatus() async throws -> InitStatus {
        try await send("/api/research/init")
    }

    func queueInit() async throws -> QueueResearchResponse {
        try await send("/api/research/init", method: "POST", body: Data("{}".utf8))
    }

    /// One job with what its run directory knows (steps, phases) while it runs.
    func researchJob(id: String) async throws -> ResearchJob {
        try await send("/api/research/jobs/\(id)")
    }

    func chatConversations() async throws -> [ChatConversation] {
        try await send("/api/chat/conversations?limit=50")
    }

    /// Whether a question asked now would be answered, and if not, what to fix.
    func chatReadiness() async throws -> ChatReadiness {
        try await send("/api/chat/readiness")
    }

    func createConversation() async throws -> ChatConversation {
        try await send("/api/chat/conversations", method: "POST", body: Data("{}".utf8))
    }

    func conversation(id: String) async throws -> ChatConversation {
        try await send("/api/chat/conversations/\(id)")
    }

    /// Starts a session in the background and answers `running` — poll
    /// `chatStatus` until it is idle.
    func sendChat(id: String, text: String) async throws -> ChatSendResponse {
        struct Body: Encodable { var text: String }
        return try await send("/api/chat/conversations/\(id)/messages", method: "POST", body: encoded(Body(text: text)))
    }

    func chatStatus(id: String) async throws -> ChatStatusResponse {
        try await send("/api/chat/conversations/\(id)/status")
    }

    func cancelChat(id: String) async throws -> [String: Bool] {
        try await send("/api/chat/conversations/\(id)/cancel", method: "POST", body: Data("{}".utf8))
    }

    func deleteConversation(id: String) async throws -> ActionResponse {
        try await send("/api/chat/conversations/\(id)", method: "DELETE")
    }

    func researchProfiles() async throws -> ResearchProfilesResponse {
        try await send("/api/research/profiles")
    }

    func researchProfile(_ name: String) async throws -> ResearchProfileDetail {
        try await send("/api/research/profiles/\(profileSegment(name))")
    }

    /// Stores the profile and, with `activate`, points `research.profile` at it.
    func saveResearchProfile(
        _ profile: ResearchProfilePayload,
        prompts: [String: String],
        activate: Bool = false
    ) async throws -> ResearchProfileDetail {
        struct Body: Encodable {
            var profile: ResearchProfilePayload
            var prompts: [String: String]
            var activate: Bool
        }
        return try await send(
            "/api/research/profiles/\(profileSegment(profile.name))",
            method: "PUT",
            body: encoded(Body(profile: profile, prompts: prompts, activate: activate))
        )
    }

    /// Removes a profile — a built-in one comes back as its defaults.
    func deleteResearchProfile(_ name: String) async throws -> DeleteProfileResponse {
        try await send("/api/research/profiles/\(profileSegment(name))", method: "DELETE")
    }

    /// Profile names are letters, digits, - and _, but never trust a name that
    /// came back from a file someone edited by hand.
    private func profileSegment(_ name: String) -> String {
        name.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_"))) ?? name
    }

    func setTrust(path filePath: String, to: String) async throws -> TrustResponse {
        struct Body: Encodable { var path: String; var to: String }
        return try await send("/api/trust", method: "POST", body: encoded(Body(path: filePath, to: to)))
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

    func embeddingUsage() async throws -> EmbeddingUsageResponse {
        try await send("/api/config/embedding-usage")
    }

    /// Embed the probe texts on an endpoint of the service's machine and compare them with the pool's (nothing is saved).
    func checkEmbedEndpoint(_ endpoint: EmbedEndpointConfig) async throws -> EmbedEndpointCheck {
        try await send("/api/config/embedding-endpoint/check", method: "POST", body: encoded(endpoint))
    }

    func testEmbedding(_ config: KnodeConfig, id: String? = nil) async throws -> EmbeddingTestResponse {
        struct Body: Encodable { var config: KnodeConfig; var id: String? }
        return try await send("/api/config/embedding-test", method: "POST", body: encoded(Body(config: config, id: id)))
    }

    /// Models the draft config's provider offers for one route ("embedding",
    /// "llm", "entityLlm", "documentLlm", "summaryLlm", "judgeLlm", "translateLlm"). Inherited routes are
    /// resolved against the draft default provider server-side.
    /// `refresh` asks the provider again instead of taking the service's
    /// cached answer — what the refresh button in the picker sends.
    func listModels(route: String, config: KnodeConfig, refresh: Bool = false) async throws -> ModelListResponse {
        struct Body: Encodable { var route: String; var config: KnodeConfig; var refresh: Bool }
        return try await send("/api/config/models", method: "POST", body: encoded(Body(route: route, config: config, refresh: refresh)))
    }

    func agents() async throws -> AgentsResponse {
        try await send("/api/agents")
    }

    func saveAgent(_ name: String, _ payload: AgentDefinition.Payload) async throws -> AgentDefinition {
        struct Body: Encodable { var agent: AgentDefinition.Payload }
        return try await send("/api/agents/\(name)", method: "PUT", body: encoded(Body(agent: payload)))
    }

    /// Deleting a built-in resets it to the template rather than removing it.
    func deleteAgent(_ name: String) async throws -> DeleteAgentResponse {
        try await send("/api/agents/\(name)", method: "DELETE")
    }

    /* ------------------------------ playbooks ------------------------------ */

    func playbooks() async throws -> PlaybooksResponse {
        try await send("/api/playbooks")
    }

    func playbook(at playbookPath: String) async throws -> PlaybookText {
        try await send(path("/api/playbooks/file", query: [.init(name: "path", value: playbookPath)]))
    }

    func savePlaybook(path playbookPath: String, text: String) async throws -> PlaybookText {
        struct Body: Encodable { var path: String; var text: String }
        return try await send("/api/playbooks/file", method: "PUT", body: encoded(Body(path: playbookPath, text: text)))
    }

    /// Put the built-in version back in place of an edited one.
    func resetPlaybook(path playbookPath: String) async throws -> PlaybookText {
        try await send(path("/api/playbooks/file", query: [.init(name: "path", value: playbookPath)]), method: "DELETE")
    }

    func cliTools() async throws -> CliToolsResponse {
        try await send("/api/config/cli-tools")
    }

    func availableAgents() async throws -> AvailableAgentsResponse {
        try await send("/api/config/agents")
    }

    /* ------------------------------ research studies ------------------------------ */

    /// The studies not archived, or (`archived`) only the archived ones.
    func studies(archived: Bool = false) async throws -> [StudySummary] {
        try await send("/api/research/studies?limit=80\(archived ? "&archived=1" : "")")
    }

    func study(id: String) async throws -> StudyDetail {
        try await send("/api/research/studies/\(id)")
    }

    /// A draft from a topic; the service refines it in the background (poll the study).
    func createStudy(topic: String, agent: String, web: Bool) async throws -> StudyDetail {
        struct Runner: Encodable { var agent: String }
        struct Sources: Encodable { var web: Bool }
        struct Body: Encodable { var topic: String; var runner: Runner; var sources: Sources }
        return try await send("/api/research/studies", method: "POST", body: encoded(Body(topic: topic, runner: Runner(agent: agent), sources: Sources(web: web))))
    }

    func refineStudy(id: String, feedback: String, answers: [String: String]) async throws -> StudyDetail {
        struct Body: Encodable { var feedback: String; var answers: [String: String] }
        return try await send("/api/research/studies/\(id)/refine", method: "POST", body: encoded(Body(feedback: feedback, answers: answers)))
    }

    func startStudy(id: String) async throws -> StudyDetail {
        try await send("/api/research/studies/\(id)/start", method: "POST", body: Data("{}".utf8))
    }

    /// What a draft study would take once started, from the studies run before it.
    func studyEstimate(id: String) async throws -> TaskEstimate {
        try await send("/api/research/studies/\(id)/estimate")
    }

    func cancelStudy(id: String) async throws -> [String: Int] {
        try await send("/api/research/studies/\(id)/cancel", method: "POST", body: Data("{}".utf8))
    }

    /// A failed or cancelled study, queued again from where it stopped.
    func retryStudy(id: String) async throws -> StudyDetail {
        try await send("/api/research/studies/\(id)/retry", method: "POST", body: Data("{}".utf8))
    }

    /// A study waiting out a pause (a spent usage limit) runs now.
    func resumeStudy(id: String) async throws -> StudyDetail {
        try await send("/api/research/studies/\(id)/resume", method: "POST", body: Data("{}".utf8))
    }

    /// A finished study off the list (or back on it); it keeps everything.
    func archiveStudy(id: String, archived: Bool) async throws -> StudyDetail {
        try await send("/api/research/studies/\(id)/\(archived ? "archive" : "unarchive")", method: "POST", body: Data("{}".utf8))
    }

    /// A failed or cancelled study's jobs and logs; what it wrote stays in the knowledge base.
    func removeStudy(id: String) async throws -> StudyRemoval {
        try await send("/api/research/studies/\(id)", method: "DELETE")
    }

    /// Mark a study's pages (or its captured sources) trusted.
    func promoteStudy(id: String, what: String) async throws -> PromoteStudyResponse {
        struct Body: Encodable { var what: String }
        return try await send("/api/research/studies/\(id)/promote", method: "POST", body: encoded(Body(what: what)))
    }
}

/// What a Promote changed: files made trusted, files already trusted, files not indexed yet, failures.
struct PromoteStudyResponse: Decodable {
    struct Failure: Decodable { var path: String; var error: String }
    var to: String
    var changed: [String]
    var unchanged: [String]
    var notIndexed: [String]
    var failed: [Failure]
}
