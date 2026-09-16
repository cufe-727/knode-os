import Foundation
import SwiftUI

enum AppSection: String, CaseIterable, Identifiable, Codable {
    case files
    case search
    case ask
    case graph
    case wiki
    case traces
    case dream
    case settings

    var id: String { rawValue }

    var title: String {
        switch self {
        case .files: "Files"
        case .search: "Search"
        case .ask: "Ask"
        case .graph: "Graph"
        case .wiki: "Wiki"
        case .traces: "Traces"
        case .dream: "Dream"
        case .settings: "Settings"
        }
    }

    var subtitle: String {
        switch self {
        case .files: "Browse and edit knowledge"
        case .search: "Hybrid, vector, and keyword recall"
        case .ask: "Cited answers from your workspace"
        case .graph: "Entities, relations, and claims"
        case .wiki: "Pages researched by agent CLIs"
        case .traces: "Claude Code and Codex sessions"
        case .dream: "Review agent improvement ideas"
        case .settings: "Model routes and pipeline limits"
        }
    }

    var symbol: String {
        switch self {
        case .files: "doc.text.magnifyingglass"
        case .search: "magnifyingglass"
        case .ask: "sparkles"
        case .graph: "point.3.connected.trianglepath.dotted"
        case .wiki: "book.closed"
        case .traces: "terminal"
        case .dream: "moon.stars"
        case .settings: "slider.horizontal.3"
        }
    }
}

enum WorkspaceKind: String, Codable, CaseIterable {
    case personal
    case team
}

struct Workspace: Codable, Hashable, Identifiable {
    var id: String
    var name: String
    var kind: WorkspaceKind
    var code: String?
    var createdAt: String?

    var displayName: String { name }
    var detail: String { kind == .personal ? "Private workspace" : "Team workspace" }
}

struct UserProfile: Codable, Hashable {
    var username: String
    var name: String
}

struct StoredSession: Codable {
    var user: UserProfile
    var workspaces: [Workspace]
    var activeWorkspaceID: String
}

struct LocalAccount: Codable {
    var username: String
    var name: String
    var passwordHash: String
}

struct ServerHealth: Decodable {
    var ok: Bool
    var dataRoot: String?
    var workspaceIsolation: Bool?
}

struct KnowledgeStats: Decodable, Equatable {
    var documents: Int
    var chunks: Int
    var embeddings: Int?
    var entities: Int
    var relations: Int
    var traces: Int
    var pendingSuggestions: Int
    var extractionQueue: Int?
    var embeddingModel: String?
    var llmModel: String?
    var lastDream: LastDream?

    struct LastDream: Decodable, Equatable {
        var at: String?
        var report: String?
        var sessions: Int?
    }
}

enum TreeNodeKind: String, Decodable {
    case file
    case dir
}

struct TreeNode: Decodable, Identifiable, Hashable {
    var name: String
    var path: String
    var kind: TreeNodeKind
    var bytes: Int?
    var mtime: String?
    var children: [TreeNode]?

    var id: String { path.isEmpty ? "__root__" : path }
    var isWritable: Bool { path == "wiki" || path.hasPrefix("wiki/") || path == "raw/docs" || path.hasPrefix("raw/docs/") }
}

struct FileResponse: Decodable {
    var path: String
    var content: String
    /// Size on disk, which is larger than `content` when the read was capped.
    var bytes: Int?
    var truncated: Bool?
    /// True when the text is Markdown knode-os derived from a PDF or image
    /// rather than the file's own bytes — readable, never editable.
    var derived: Bool?
}

struct ResolvedLinkResponse: Decodable {
    var path: String
    var fragment: String?
}

struct SearchResult: Decodable, Identifiable, Hashable {
    var chunkId: String
    var documentId: String
    var path: String
    var title: String?
    var content: String
    var score: Double
    var signals: [String: Double]

    var id: String { chunkId }
}

struct Citation: Decodable, Hashable, Identifiable {
    var ref: Int
    var path: String
    var chunkId: String
    var id: String { "\(ref)-\(chunkId)" }
}

struct Claim: Decodable, Hashable, Identifiable {
    var id: String
    var subject: String
    var object: String?
    var type: String
    var statement: String
    var status: String
    var startDate: String?
    var endDate: String?
    var path: String?
}

struct AskResponse: Decodable {
    var answer: String
    var citations: [Citation]
    var gaps: [String]
    var contexts: [SearchResult]
    var facts: [Claim]
}

struct GraphNode: Decodable, Hashable, Identifiable {
    var id: String
    var name: String
    var type: String
    var description: String
    var score: Double
    var mentionCount: Int
}

struct GraphEdge: Decodable, Hashable, Identifiable {
    var source: String
    var target: String
    var type: String
    var description: String
    var weight: Double
    var id: String { "\(source)-\(target)-\(type)" }
}

struct GraphResponse: Decodable {
    var nodes: [GraphNode]
    var edges: [GraphEdge]
    var chunks: [SearchResult]
    var claims: [Claim]?
}

struct GraphInsights: Decodable {
    struct Totals: Decodable {
        var entities: Int
        var relations: Int
        var mentions: Int
    }

    struct Hub: Decodable, Identifiable {
        var id: String
        var name: String
        var degree: Int
    }

    struct Isolated: Decodable, Identifiable {
        var id: String
        var name: String
    }

    struct TypeCount: Decodable, Identifiable {
        var type: String
        var n: Int
        var id: String { type }
    }

    var totals: Totals
    var hubs: [Hub]
    var isolated: [Isolated]
    var typeCounts: [TypeCount]
}

struct TraceItem: Decodable, Identifiable, Hashable {
    var id: String
    var source: String
    var sessionId: String?
    var path: String
    var project: String?
    var startedAt: String?
    var bytes: Int
    var sha256: String
    var analyzedAt: String?
}

struct TraceSyncResponse: Decodable {
    var copied: Int
    var skills: Int
}

struct Suggestion: Decodable, Identifiable, Hashable {
    var id: String
    var kind: String
    var title: String
    var body: String
    var evidence: [String]
    var status: String
    var reportPath: String?
    var createdAt: String
}

struct DreamResponse: Decodable {
    var reportPath: String
    var sessions: Int
    var suggestions: [Suggestion]
}

struct IngestStats: Codable {
    var scanned: Int?
    var indexed: Int
    var unchanged: Int
    var removed: Int?
    var skipped: Int?
    var errors: Int?
    var chunks: Int
    var entities: Int?
    var relations: Int?
}

struct UploadResponse: Decodable {
    var ok: Bool
    var saved: [String]
}

/// One file in a multipart upload. `name` is the path relative to the
/// destination directory, so a folder upload keeps its subtree ("notes/2026/kickoff.md").
struct UploadItem {
    var name: String
    var url: URL
}

struct ActionResponse: Decodable {
    var ok: Bool
}

struct ResearchJob: Decodable, Identifiable, Hashable {
    var id: String
    var kind: String
    var target: String?
    var query: String?
    var status: String
    var agent: String?
    var outputPath: String?
    var error: String?
    var turns: Int?
    var createdAt: String
    var startedAt: String?
    var finishedAt: String?

    var subject: String { target ?? query ?? "" }
}

struct ResearchPage: Decodable, Identifiable, Hashable {
    var id: String { path }
    var path: String
    var exists: Bool
    var job: String
    var kind: String
    var target: String?
    var agent: String?
    var finishedAt: String?
    var trust: String?
    var warnings: [String]?
}

struct ResearchRecommendation: Decodable, Identifiable, Hashable {
    var id: String { "\(kind)|\(target)" }
    var kind: String
    var target: String
    var score: Double
    var reasons: [String]
    var suggestionId: String?
}

struct QueueResearchResponse: Decodable {
    var job: ResearchJob
    var created: Bool
}

struct TrustResponse: Decodable {
    var key: String
    var from: String
    var to: String
}

struct EmbeddingConfig: Codable, Equatable {
    var provider: String
    var baseUrl: String
    var apiKey: String
    var model: String
    var dimensions: Int
    var batchSize: Int?
    var sendDimensions: Bool
}

struct LLMConfig: Codable, Equatable {
    var provider: String
    var baseUrl: String
    var apiKey: String
    var model: String
    var cliPath: String
    var cliTimeoutMs: Int?
}

/// A pipeline route. `use` names the connection it runs on — empty for the
/// default provider — and `model` overrides that connection's own model. The
/// remaining fields only carry pre-connections configs the service migrates.
struct RoutedLLMConfig: Codable, Equatable {
    var use: String
    var provider: String
    var baseUrl: String
    var apiKey: String
    var model: String
    var cliPath: String
    var cliTimeoutMs: Int?

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        use = try container.decodeIfPresent(String.self, forKey: .use) ?? ""
        provider = try container.decodeIfPresent(String.self, forKey: .provider) ?? "inherit"
        baseUrl = try container.decodeIfPresent(String.self, forKey: .baseUrl) ?? ""
        apiKey = try container.decodeIfPresent(String.self, forKey: .apiKey) ?? ""
        model = try container.decodeIfPresent(String.self, forKey: .model) ?? ""
        cliPath = try container.decodeIfPresent(String.self, forKey: .cliPath) ?? ""
        cliTimeoutMs = try container.decodeIfPresent(Int.self, forKey: .cliTimeoutMs)
    }
}

/// A named endpoint plus credentials that any number of routes can point at.
struct LLMConnection: Codable, Equatable, Identifiable {
    var id: String
    var label: String
    var provider: String
    var baseUrl: String
    var apiKey: String
    var model: String
    var cliPath: String
    var cliTimeoutMs: Int?

    init(id: String, label: String, provider: String = "openai") {
        self.id = id
        self.label = label
        self.provider = provider
        baseUrl = provider == "openai" ? "https://api.openai.com/v1" : ""
        apiKey = ""
        model = ""
        cliPath = ""
        cliTimeoutMs = nil
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        label = try container.decodeIfPresent(String.self, forKey: .label) ?? id
        provider = try container.decodeIfPresent(String.self, forKey: .provider) ?? "openai"
        baseUrl = try container.decodeIfPresent(String.self, forKey: .baseUrl) ?? ""
        apiKey = try container.decodeIfPresent(String.self, forKey: .apiKey) ?? ""
        model = try container.decodeIfPresent(String.self, forKey: .model) ?? ""
        cliPath = try container.decodeIfPresent(String.self, forKey: .cliPath) ?? ""
        cliTimeoutMs = try container.decodeIfPresent(Int.self, forKey: .cliTimeoutMs)
    }
}

struct ExtractionConfig: Codable, Equatable {
    var dailyTokenBudget: Int
    var claims: Bool
    var entityLlm: RoutedLLMConfig
    var conceptLlm: RoutedLLMConfig
    var documentLlm: RoutedLLMConfig
    var batchSize: Int
    var concurrency: Int
}

struct KnodeConfig: Codable, Equatable {
    var embedding: EmbeddingConfig
    var llm: LLMConfig
    var connections: [LLMConnection]
    var extraction: ExtractionConfig

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        embedding = try container.decode(EmbeddingConfig.self, forKey: .embedding)
        llm = try container.decode(LLMConfig.self, forKey: .llm)
        connections = try container.decodeIfPresent([LLMConnection].self, forKey: .connections) ?? []
        extraction = try container.decode(ExtractionConfig.self, forKey: .extraction)
    }
}

struct RouteTestResult: Decodable {
    var ok: Bool
    var enabled: Bool?
    var inherited: Bool?
    var note: String?
    var error: String?
    var provider: String?
    var model: String?
    var dimensions: Int?
    var sample: String?
    var ms: Int?
}

struct ConfigTestResponse: Decodable {
    var embedding: RouteTestResult?
    var llm: RouteTestResult?
    var entityLlm: RouteTestResult?
    var conceptLlm: RouteTestResult?
    var documentLlm: RouteTestResult?
}

/// One entry of what a provider offers for a `model` field. The field itself
/// stays free text — this is a shortcut, not a closed set.
struct ModelOption: Decodable, Identifiable, Hashable {
    var id: String
    var label: String?
}

struct ModelListResponse: Decodable {
    /// "api" — the provider listed them; "cli" — the CLI did; "builtin" — knode's own hints.
    var source: String
    var ok: Bool
    var models: [ModelOption]
    var command: String?
    var resolvedPath: String?
    var note: String?
    var error: String?
}

/// Where a coding-agent CLI resolved to on the service's PATH.
struct CliTool: Decodable, Identifiable {
    var provider: String
    var command: String
    var path: String?
    var id: String { provider }
}

struct CliToolsResponse: Decodable {
    var tools: [CliTool]
}

struct ConfigSaveResponse: Decodable {
    var ok: Bool
    var config: KnodeConfig
    var reembedded: Bool
    var reconverted: Bool?
    var reindex: IngestStats?
}

enum SearchMode: String, CaseIterable, Identifiable {
    case hybrid
    case vector
    case keyword
    var id: String { rawValue }
}

extension String {
    var knodeInitials: String {
        let parts = split(whereSeparator: { $0 == " " || $0 == "@" || $0 == "." || $0 == "_" || $0 == "-" })
        if parts.count > 1 {
            return String(parts[0].prefix(1) + parts[1].prefix(1)).uppercased()
        }
        return String((parts.first ?? Substring("K")).prefix(2)).uppercased()
    }

    var knodeDate: String {
        let formatter = ISO8601DateFormatter()
        guard let date = formatter.date(from: self) else { return self }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}

extension Color {
    static let knodeCyan = Color(red: 0.36, green: 0.78, blue: 1.0)
    static let knodeViolet = Color(red: 0.71, green: 0.55, blue: 1.0)
    static let knodeGood = Color(red: 0.37, green: 0.82, blue: 0.59)
    static let knodeBad = Color(red: 1.0, green: 0.48, blue: 0.56)
}
