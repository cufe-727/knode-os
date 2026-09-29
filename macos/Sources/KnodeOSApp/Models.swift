import Foundation
import SwiftUI

/**
 * Navigation is two levels: a section in the sidebar, a tab inside it.
 *
 * The grouping follows what the workspace does with a file rather than what
 * the service implements: material comes in (Library), you ask about it
 * (Ask), and knowledge grows out of it (Knowledge). A section whose `tabs`
 * holds a single entry shows no tab strip.
 */
enum AppSection: String, CaseIterable, Identifiable, Codable {
    case library
    case ask
    case knowledge
    case settings

    var id: String { rawValue }

    var tabs: [AppTab] {
        switch self {
        case .library: [.files, .search, .traces]
        case .ask: [.ask]
        case .knowledge: [.graph, .wiki, .dream]
        case .settings: [.providers, .pipeline, .research, .workspace]
        }
    }

    @MainActor var title: String {
        switch self {
        case .library: L("Library")
        case .ask: L("Ask")
        case .knowledge: L("Knowledge")
        case .settings: L("Settings")
        }
    }

    @MainActor var subtitle: String {
        switch self {
        case .library: L("Files, search, and agent traces")
        case .ask: L("An agent that answers from your workspace")
        case .knowledge: L("Graph, wiki, and nightly review")
        case .settings: L("Model routes and pipeline limits")
        }
    }

    var symbol: String {
        switch self {
        case .library: "books.vertical"
        case .ask: "sparkles"
        case .knowledge: "lightbulb"
        case .settings: "slider.horizontal.3"
        }
    }
}

/// A screen. Every tab belongs to exactly one section, which is what the
/// sidebar selects; `AppSection.tabs` is the inverse and the two must agree.
enum AppTab: String, CaseIterable, Identifiable, Codable {
    case files
    case search
    case traces
    case ask
    case graph
    case wiki
    case dream
    case providers
    case pipeline
    case research
    case workspace

    var id: String { rawValue }

    /**
     * A tab that used to exist, so a stored navigation still lands somewhere.
     * `agents` was folded into `providers` in 2026-09-19: an agent runs on a
     * provider from the table above it, and the two were never separable in
     * anything but the tab strip.
     */
    static func named(_ raw: String) -> AppTab? {
        AppTab(rawValue: raw) ?? (raw == "agents" ? .providers : nil)
    }

    var section: AppSection {
        switch self {
        case .files, .search, .traces: .library
        case .ask: .ask
        case .graph, .wiki, .dream: .knowledge
        case .providers, .pipeline, .research, .workspace: .settings
        }
    }

    /**
     * Which screen shows this tab. Settings' four tabs share one host: keying
     * view identity on the leaf instead would rebuild `SettingsView` on every
     * sub-tab click, refetching the config and discarding unsaved routes.
     */
    var host: String {
        section == .settings ? "settings" : rawValue
    }

    @MainActor var title: String {
        switch self {
        case .files: L("Files")
        case .search: L("Search")
        case .traces: L("Traces")
        case .ask: L("Ask")
        case .graph: L("Graph")
        case .wiki: L("Wiki")
        case .dream: L("Dream")
        case .providers: L("Providers & Agents")
        case .pipeline: L("Pipeline")
        case .research: L("Research")
        case .workspace: L("Workspace")
        }
    }

    @MainActor var subtitle: String {
        switch self {
        case .files: L("Browse and edit knowledge")
        case .search: L("Hybrid, vector, and keyword recall")
        case .traces: L("Claude Code and Codex sessions")
        case .ask: L("An agent that answers from your workspace")
        case .graph: L("Entities, relations, and claims")
        case .wiki: L("Pages researched by agent CLIs")
        case .dream: L("Review agent improvement ideas")
        case .providers: L("Endpoints, credentials, and who does the work")
        case .pipeline: L("What each stage needs")
        case .research: L("How the wiki gets written")
        case .workspace: L("Clear this workspace")
        }
    }

    var symbol: String {
        switch self {
        case .files: "doc.text"
        case .search: "magnifyingglass"
        case .traces: "terminal"
        case .ask: "sparkles"
        case .graph: "point.3.connected.trianglepath.dotted"
        case .wiki: "book.closed"
        case .dream: "moon.stars"
        case .providers: "cable.connector"
        case .pipeline: "arrow.triangle.branch"
        case .research: "book.and.wrench"
        case .workspace: "exclamationmark.triangle"
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

/// One pre-flight step of an initialization (index, extract, regenerate, survey).
struct InitStep: Decodable, Identifiable, Hashable {
    var name: String
    var status: String
    var detail: String?

    var id: String { name }
}

/// One agent session of a team run, as the runner recorded it.
struct PhaseRecord: Decodable, Identifiable, Hashable {
    var name: String
    var label: String
    var role: String?
    var agent: String?
    var turns: Int?
    var error: String?

    var id: String { label }
}

/// A page an initialization decided is worth its own research job.
struct InitTopic: Decodable, Identifiable, Hashable {
    var kind: String
    var target: String
    var why: String?
    var queued: String?

    var id: String { "\(kind):\(target)" }
}

/// The parts of a job's payload the client shows.
struct ResearchJobPayload: Decodable, Hashable {
    var steps: [InitStep]?
    var phases: [PhaseRecord]?
    var topics: [InitTopic]?
    var followUps: [String]?
    var warnings: [String]?
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
    var payload: ResearchJobPayload?
    /// Present on the job-detail route, which also reads the run directory.
    var steps: [InitStep]?
    var phases: [PhaseRecord]?

    var subject: String { target ?? query ?? "" }
    /// Queued, running or validating — the UI keeps polling.
    var isLive: Bool { status == "queued" || status == "running" || status == "validating" }
    var initSteps: [InitStep] { steps?.isEmpty == false ? steps! : payload?.steps ?? [] }
    var initPhases: [PhaseRecord] { phases?.isEmpty == false ? phases! : payload?.phases ?? [] }
    var initTopics: [InitTopic] { payload?.topics ?? [] }
}

/// What `GET /api/survey` reports, narrowed to what the initialization card shows.
struct KbSurvey: Decodable, Hashable {
    struct Stats: Decodable, Hashable {
        var documents: Int
        var chunks: Int
        var entities: Int
        var relations: Int
        var claims: Int
    }

    struct Extraction: Decodable, Hashable {
        var queued: Int
        var llmEnabled: Bool
    }

    struct Guide: Decodable, Hashable {
        struct Stamp: Decodable, Hashable {
            var job: String
            var at: String
            var agent: String
        }

        var exists: Bool
        var path: String
        var bytes: Int
        var updatedAt: String?
        var stamp: Stamp?
    }

    var stats: Stats
    var extraction: Extraction
    var guide: Guide
}

struct InitStatus: Decodable {
    var survey: KbSurvey
    var guide: KbSurvey.Guide
    var job: ResearchJob?
    var followUps: [ResearchJob]
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

/// One configured embedding provider. Only one is active at a time — vectors
/// from two models do not share a space — so `KnodeConfig.embeddingUse` names
/// the one the Index stage runs on, and switching re-embeds the corpus.
struct EmbeddingConnection: Codable, Equatable, Identifiable {
    var id: String
    var label: String
    var provider: String
    var baseUrl: String
    var apiKey: String
    var model: String
    var dimensions: Int
    var batchSize: Int?
    var sendDimensions: Bool

    init(id: String, label: String, provider: String = "openai") {
        self.id = id
        self.label = label
        self.provider = provider
        baseUrl = provider == "openai" ? "https://api.openai.com/v1" : ""
        apiKey = ""
        model = ""
        dimensions = provider == "local" ? 384 : 1536
        batchSize = nil
        sendDimensions = false
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        label = try container.decodeIfPresent(String.self, forKey: .label) ?? id
        provider = try container.decodeIfPresent(String.self, forKey: .provider) ?? "local"
        baseUrl = try container.decodeIfPresent(String.self, forKey: .baseUrl) ?? ""
        apiKey = try container.decodeIfPresent(String.self, forKey: .apiKey) ?? ""
        model = try container.decodeIfPresent(String.self, forKey: .model) ?? ""
        dimensions = try container.decodeIfPresent(Int.self, forKey: .dimensions) ?? 384
        batchSize = try container.decodeIfPresent(Int.self, forKey: .batchSize)
        sendDimensions = try container.decodeIfPresent(Bool.self, forKey: .sendDimensions) ?? false
    }
}

struct LLMConfig: Codable, Equatable {
    var provider: String
    var baseUrl: String
    var apiKey: String
    var model: String
    var cliPath: String
    /// How hard a CLI provider thinks. "default" leaves the CLI's own setting
    /// alone, and an OpenAI-compatible endpoint ignores it.
    var effort: String
    var cliTimeoutMs: Int?
    /// Shown in the providers table. Empty = the provider's own name.
    var label: String?

    /// Decoded field by field so a service that predates one of them — `effort`
    /// arrived after the rest — still yields a usable config instead of failing.
    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        provider = try container.decodeIfPresent(String.self, forKey: .provider) ?? "openai"
        baseUrl = try container.decodeIfPresent(String.self, forKey: .baseUrl) ?? ""
        apiKey = try container.decodeIfPresent(String.self, forKey: .apiKey) ?? ""
        model = try container.decodeIfPresent(String.self, forKey: .model) ?? ""
        cliPath = try container.decodeIfPresent(String.self, forKey: .cliPath) ?? ""
        effort = try container.decodeIfPresent(String.self, forKey: .effort) ?? "default"
        cliTimeoutMs = try container.decodeIfPresent(Int.self, forKey: .cliTimeoutMs)
        label = try container.decodeIfPresent(String.self, forKey: .label)
    }
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
    /// See `LLMConfig.effort`.
    var effort: String
    var cliTimeoutMs: Int?

    init(id: String, label: String, provider: String = "openai") {
        self.id = id
        self.label = label
        self.provider = provider
        baseUrl = provider == "openai" ? "https://api.openai.com/v1" : ""
        apiKey = ""
        model = ""
        cliPath = ""
        effort = "default"
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
        effort = try container.decodeIfPresent(String.self, forKey: .effort) ?? "default"
        cliTimeoutMs = try container.decodeIfPresent(Int.self, forKey: .cliTimeoutMs)
    }
}

/// The per-stage rates the pipeline runs at. The service owns the rest of its
/// `ingest` block (chunk size, watch); those fields are left out deliberately,
/// and it keeps whatever this client does not send.
struct IngestConfig: Codable, Equatable {
    /// Parallel documents in flight during the index pass.
    var concurrency: Int
    /// Parallel document conversions in the prepare pass.
    var convertConcurrency: Int

    init(concurrency: Int = 4, convertConcurrency: Int = 2) {
        self.concurrency = concurrency
        self.convertConcurrency = convertConcurrency
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let fallback = IngestConfig()
        concurrency = try container.decodeIfPresent(Int.self, forKey: .concurrency) ?? fallback.concurrency
        convertConcurrency = try container.decodeIfPresent(Int.self, forKey: .convertConcurrency) ?? fallback.convertConcurrency
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

/// The runner half of the service's `research` block: which coding-agent CLI
/// writes wiki pages, how many run at once, and which profile they follow. The
/// service merges what it receives into its own block, so the fields this
/// client does not model (runsDir, keepRuns, readDirs) keep their values.
struct ResearchConfig: Codable, Equatable {
    struct Auto: Codable, Equatable {
        var enabled: Bool
        var dailyJobs: Int
    }

    /// What the Wiki tab's initialize button does before the agent starts.
    struct Initialization: Codable, Equatable {
        /// Topic pages queued as follow-up research jobs.
        var followUps: Int
        /// "drain" runs tier-1 extraction to the end of the queue first; "skip" leaves it to the background loop.
        var extraction: String
        var extractionMaxMs: Int

        init(followUps: Int = 6, extraction: String = "drain", extractionMaxMs: Int = 900_000) {
            self.followUps = followUps
            self.extraction = extraction
            self.extractionMaxMs = extractionMaxMs
        }

        init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            let fallback = Initialization()
            followUps = try container.decodeIfPresent(Int.self, forKey: .followUps) ?? fallback.followUps
            extraction = try container.decodeIfPresent(String.self, forKey: .extraction) ?? fallback.extraction
            extractionMaxMs = try container.decodeIfPresent(Int.self, forKey: .extractionMaxMs) ?? fallback.extractionMaxMs
        }
    }

    /// A connection id or a CLI provider name; empty follows the default LLM
    /// provider when that is itself a CLI.
    var agent: String
    var model: String
    var profile: String
    /// "team" | "native" | "single" — a profile may pin its own.
    var pipeline: String
    var maxTurns: Int
    var timeoutMs: Int
    var concurrency: Int
    var researchers: Int
    var reviewRounds: Int
    var auto: Auto
    var initialization: Initialization

    enum CodingKeys: String, CodingKey {
        case agent, model, profile, pipeline, maxTurns, timeoutMs, concurrency, researchers, reviewRounds, auto
        case initialization = "init"
    }

    init(
        agent: String = "",
        model: String = "",
        profile: String = "default",
        pipeline: String = "team",
        maxTurns: Int = 40,
        timeoutMs: Int = 1_200_000,
        concurrency: Int = 1,
        researchers: Int = 3,
        reviewRounds: Int = 1,
        auto: Auto = Auto(enabled: false, dailyJobs: 3),
        initialization: Initialization = Initialization()
    ) {
        self.agent = agent
        self.model = model
        self.profile = profile
        self.pipeline = pipeline
        self.maxTurns = maxTurns
        self.timeoutMs = timeoutMs
        self.concurrency = concurrency
        self.researchers = researchers
        self.reviewRounds = reviewRounds
        self.auto = auto
        self.initialization = initialization
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let fallback = ResearchConfig()
        agent = try container.decodeIfPresent(String.self, forKey: .agent) ?? fallback.agent
        model = try container.decodeIfPresent(String.self, forKey: .model) ?? fallback.model
        profile = try container.decodeIfPresent(String.self, forKey: .profile) ?? fallback.profile
        pipeline = try container.decodeIfPresent(String.self, forKey: .pipeline) ?? fallback.pipeline
        maxTurns = try container.decodeIfPresent(Int.self, forKey: .maxTurns) ?? fallback.maxTurns
        timeoutMs = try container.decodeIfPresent(Int.self, forKey: .timeoutMs) ?? fallback.timeoutMs
        concurrency = try container.decodeIfPresent(Int.self, forKey: .concurrency) ?? fallback.concurrency
        researchers = try container.decodeIfPresent(Int.self, forKey: .researchers) ?? fallback.researchers
        reviewRounds = try container.decodeIfPresent(Int.self, forKey: .reviewRounds) ?? fallback.reviewRounds
        auto = try container.decodeIfPresent(Auto.self, forKey: .auto) ?? fallback.auto
        initialization = try container.decodeIfPresent(Initialization.self, forKey: .initialization) ?? fallback.initialization
    }
}

/// The chat entry's settings (`chat` in knode.config.json).
struct ChatConfig: Codable, Equatable {
    /// Connection id or CLI provider; empty follows the research agent.
    var agent: String
    var model: String
    var historyTurns: Int
    var keep: Int

    init(
        agent: String = "default",
        model: String = "",
        historyTurns: Int = 12,
        keep: Int = 200
    ) {
        self.agent = agent
        self.model = model
        self.historyTurns = historyTurns
        self.keep = keep
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let fallback = ChatConfig()
        agent = try container.decodeIfPresent(String.self, forKey: .agent) ?? fallback.agent
        model = try container.decodeIfPresent(String.self, forKey: .model) ?? fallback.model
        historyTurns = try container.decodeIfPresent(Int.self, forKey: .historyTurns) ?? fallback.historyTurns
        keep = try container.decodeIfPresent(Int.self, forKey: .keep) ?? fallback.keep
    }
}

struct KnodeConfig: Codable, Equatable {
    /// The active embedding provider, flattened by the service from
    /// `embeddingProviders`. Read-only here: the table edits the list.
    var embedding: EmbeddingConfig
    var embeddingProviders: [EmbeddingConnection]
    /// Which `embeddingProviders` entry the Index stage runs on.
    var embeddingUse: String
    /// A mirror of the connection `llmUse` names, flattened by the service.
    /// Read-only here: the table edits the list, like the embedding one.
    var llm: LLMConfig
    var connections: [LLMConnection]
    /// Which `connections` entry every job inherits unless it names another.
    var llmUse: String
    var ingest: IngestConfig
    var extraction: ExtractionConfig
    var research: ResearchConfig
    var chat: ChatConfig

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        embedding = try container.decode(EmbeddingConfig.self, forKey: .embedding)
        embeddingProviders = try container.decodeIfPresent([EmbeddingConnection].self, forKey: .embeddingProviders) ?? []
        embeddingUse = try container.decodeIfPresent(String.self, forKey: .embeddingUse) ?? ""
        llm = try container.decode(LLMConfig.self, forKey: .llm)
        connections = try container.decodeIfPresent([LLMConnection].self, forKey: .connections) ?? []
        llmUse = try container.decodeIfPresent(String.self, forKey: .llmUse) ?? ""
        ingest = try container.decodeIfPresent(IngestConfig.self, forKey: .ingest) ?? IngestConfig()
        extraction = try container.decode(ExtractionConfig.self, forKey: .extraction)
        research = try container.decodeIfPresent(ResearchConfig.self, forKey: .research) ?? ResearchConfig()
        chat = try container.decodeIfPresent(ChatConfig.self, forKey: .chat) ?? ChatConfig()
    }

    /// The entry the Index stage runs on, or nil while the list is still loading.
    var activeEmbedding: EmbeddingConnection? {
        embeddingProviders.first { $0.id == embeddingUse } ?? embeddingProviders.first
    }

    /// The connection every job inherits, or nil while the list is still loading.
    var activeLlm: LLMConnection? {
        connections.first { $0.id == llmUse } ?? connections.first
    }
}

/// The coding-agent CLIs. They are agents that bring their own loop, so they
/// live in the agents table, not among the models.
let cliProviderNames = ["claude-cli", "codex-cli", "cursor-cli"]

/// A named agent: who runs a research job or a chat turn, and how hard they
/// think. How the research itself is conducted stays in the profile.
struct AgentDefinition: Codable, Equatable, Identifiable {
    struct Tools: Codable, Equatable {
        var write: Bool
        var files: Bool
        /// "inherit" | "on" | "off"
        var web: String

        init(write: Bool = false, files: Bool = true, web: String = "inherit") {
            self.write = write
            self.files = files
            self.web = web
        }

        init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            let fallback = Tools()
            write = try container.decodeIfPresent(Bool.self, forKey: .write) ?? fallback.write
            files = try container.decodeIfPresent(Bool.self, forKey: .files) ?? fallback.files
            web = try container.decodeIfPresent(String.self, forKey: .web) ?? fallback.web
        }
    }

    var name: String
    var title: String
    var description: String
    /// "general" | "deep-research" — only orders the pickers now.
    var kind: String
    /// A CLI provider name runs that CLI; "default" or a connection id runs
    /// the built-in deepagents loop on that model.
    var executor: String
    /// A CLI agent's executable; "" = the CLI's own name on PATH.
    var cliPath: String
    var model: String
    var effort: String
    var tools: Tools
    /// 0 = the caller's own default.
    var maxTurns: Int
    var timeoutMs: Int
    var prompt: String
    var path: String
    /// Server-reported, never sent back.
    var builtin: Bool
    var runnable: Bool

    var id: String { name }

    init(name: String, kind: String = "general", executor: String = "default") {
        self.name = name
        title = name
        description = ""
        self.kind = kind
        self.executor = executor
        cliPath = ""
        model = ""
        effort = "default"
        // what Ask needs to take notes; a CLI answers with its own tools anyway
        tools = Tools(write: true, files: true, web: "inherit")
        maxTurns = 0
        timeoutMs = 0
        prompt = ""
        path = ""
        builtin = false
        runnable = false
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        kind = try container.decodeIfPresent(String.self, forKey: .kind) ?? "general"
        title = try container.decodeIfPresent(String.self, forKey: .title) ?? name
        description = try container.decodeIfPresent(String.self, forKey: .description) ?? ""
        executor = try container.decodeIfPresent(String.self, forKey: .executor) ?? ""
        cliPath = try container.decodeIfPresent(String.self, forKey: .cliPath) ?? ""
        model = try container.decodeIfPresent(String.self, forKey: .model) ?? ""
        effort = try container.decodeIfPresent(String.self, forKey: .effort) ?? "default"
        tools = try container.decodeIfPresent(Tools.self, forKey: .tools) ?? Tools()
        maxTurns = try container.decodeIfPresent(Int.self, forKey: .maxTurns) ?? 0
        timeoutMs = try container.decodeIfPresent(Int.self, forKey: .timeoutMs) ?? 0
        prompt = try container.decodeIfPresent(String.self, forKey: .prompt) ?? ""
        path = try container.decodeIfPresent(String.self, forKey: .path) ?? ""
        builtin = try container.decodeIfPresent(Bool.self, forKey: .builtin) ?? false
        runnable = try container.decodeIfPresent(Bool.self, forKey: .runnable) ?? false
    }

    /// What `PUT /api/agents/:name` takes: the server owns `builtin`/`runnable`/`path`.
    struct Payload: Encodable {
        var title: String
        var description: String
        var kind: String
        var executor: String
        var cliPath: String
        var model: String
        var effort: String
        var tools: Tools
        var maxTurns: Int
        var timeoutMs: Int
        var prompt: String
    }

    var payload: Payload {
        Payload(title: title, description: description, kind: kind, executor: executor, cliPath: cliPath, model: model,
                effort: effort, tools: tools, maxTurns: maxTurns, timeoutMs: timeoutMs, prompt: prompt)
    }

    /// Runs a coding-agent CLI, rather than deepagents on a model.
    var isCli: Bool { cliProviderNames.contains(executor) }

    /// A CLI agent as a pipeline stage or the default sees it: a one-shot LLM.
    /// The client-side mirror of the service's `readAgentLlms`.
    var asLlmTarget: LLMConnection? {
        guard isCli else { return nil }
        var target = LLMConnection(id: name, label: title.trimmingCharacters(in: .whitespaces).isEmpty ? name : title, provider: executor)
        target.model = model
        target.cliPath = cliPath
        target.effort = effort
        return target
    }
}

struct AgentsResponse: Decodable {
    var active: String
    var chat: String
    var agents: [AgentDefinition]
}

struct DeleteAgentResponse: Decodable {
    var ok: Bool
    var reset: Bool?
}

/* ------------------------------ chat ---------------------------------- */

/// One tool call a chat turn made, or a file the reply wrote.
struct ChatEvent: Decodable, Hashable, Identifiable {
    var tool: String
    var summary: String
    var path: String?
    var ok: Bool?

    var id: String { "\(tool)|\(summary)|\(path ?? "")" }
    var label: String { tool == "wrote" ? "wrote \(summary)" : summary.isEmpty ? tool : "\(tool): \(summary)" }
}

/// Whether a question asked now would be answered, and if not, why. `reason`
/// matches the one the send path returns, so both land on the same screen.
struct ChatReadiness: Decodable {
    var ready: Bool
    var reason: String?
    var hint: String?
    var provider: String?
    var model: String?
}

struct ChatMessage: Decodable, Identifiable, Hashable {
    var id: String
    var seq: Int
    var role: String
    var content: String
    var events: [ChatEvent]
    var turns: Int?
    var error: String?
    var createdAt: String

    var isUser: Bool { role == "user" }
}

struct ChatConversation: Decodable, Identifiable, Hashable {
    var id: String
    var title: String
    var status: String
    var agent: String?
    var updatedAt: String
    var messages: [ChatMessage]?
    var running: Bool?

    @MainActor var displayTitle: String { title.isEmpty ? L("(untitled)") : title }
}

struct ChatStatusResponse: Decodable {
    var status: String
    var seq: Int?
    var activity: [ChatEvent]
}

struct ChatSendResponse: Decodable {
    var ok: Bool
    var seq: Int
    /// `running` means a session started and must be polled until it is idle.
    var status: String
}

struct ChatProtocolResponse: Decodable {
    var path: String
    var text: String
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
    /// True when the service answered from its own cache rather than the provider.
    var cached: Bool?
    var cachedAt: String?
}

/**
 * The model lists this screen has already fetched, shared by every picker on
 * it. Without it each `ModelField` kept its own copy: the same provider was
 * asked once per field, and every list was thrown away when the view went
 * away. The service caches by endpoint underneath, so this only has to stop
 * the round trip, not the work behind it.
 */
@MainActor
final class ModelCatalog: ObservableObject {
    @Published private(set) var lists: [String: ModelListResponse] = [:]
    @Published private(set) var failures: [String: String] = [:]
    @Published private(set) var loading: Set<String> = []

    func list(_ key: String) -> ModelListResponse? { lists[key] }
    func failure(_ key: String) -> String? { failures[key] }
    func isLoading(_ key: String) -> Bool { loading.contains(key) }

    /// Fetch unless it is already held. `refresh` reloads and tells the
    /// service to ask the provider again.
    func load(_ key: String, refresh: Bool = false, using fetch: @escaping (Bool) async throws -> ModelListResponse) async {
        if loading.contains(key) { return }
        if !refresh, lists[key] != nil { return }
        loading.insert(key)
        failures[key] = nil
        defer { loading.remove(key) }
        do {
            lists[key] = try await fetch(refresh)
        } catch {
            failures[key] = error.localizedDescription
        }
    }

    /// A provider change invalidates what was fetched from the old one.
    func forget(prefix: String) {
        for key in lists.keys where key.hasPrefix(prefix) { lists[key] = nil }
        for key in failures.keys where key.hasPrefix(prefix) { failures[key] = nil }
    }
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

/// What can run a session here, and what to preselect when nothing is set.
struct AvailableAgent: Decodable, Identifiable {
    var id: String
    var kind: String
    var label: String
    var available: Bool
    var reason: String?
}

struct AvailableAgentsResponse: Decodable {
    var agents: [AvailableAgent]
    var suggested: String?
}

struct ConfigSaveResponse: Decodable {
    var ok: Bool
    var config: KnodeConfig
    var reembedded: Bool
    var reconverted: Bool?
    var reindex: IngestStats?
}

/* ------------------------- deep research profiles ------------------------ */

/// A sub-agent inside a profile: which phase it covers, the CLI and model it
/// runs on, the tools it may use and the prompt it is given. `prompt*` fields
/// are what the service resolved for display — they are sent back in the PUT's
/// own `prompts` map, never inside the profile, so `encode` leaves them out.
struct ResearchRole: Codable, Equatable, Identifiable {
    struct Tools: Codable, Equatable {
        /// knode_write / knode_commit — the role writes pages.
        var write: Bool
        /// Read / Grep / Glob over the read-only add-dirs.
        var files: Bool
        /// "inherit" (the profile's search.web) | "on" | "off"; review.external still caps it.
        var web: String
    }

    var id: String
    var title: String
    /// plan | research | synthesize | review | revise
    var phase: String
    var enabled: Bool
    /// Connection id or provider name; empty = the research agent.
    var agent: String
    var model: String
    /// "default" = the profile's reasoning effort.
    var effort: String
    var tools: Tools
    /// research phase: parallel sessions (0 = the runner's fan-out).
    var parallel: Int
    /// review / revise: rounds (0 = the runner's review rounds).
    var rounds: Int
    /// 0 = derived from the template and the runner's turn cap.
    var maxTurns: Int
    /// Prompt file relative to playbooks/research/ ("" = the phase default).
    var prompt: String
    /// Offered to the orchestrator as a native sub-agent when pipeline = native.
    var native: Bool
    var description: String

    var promptPath: String
    var promptText: String
    var promptIsDefault: Bool
    var promptDefault: String

    private enum CodingKeys: String, CodingKey {
        case id, title, phase, enabled, agent, model, effort, tools, parallel, rounds, maxTurns, prompt, native, description
        case promptPath, promptText, promptIsDefault, promptDefault
    }

    init(id: String, phase: String, promptDefault: String) {
        self.id = id
        title = "New role"
        self.phase = phase
        enabled = true
        agent = ""
        model = ""
        effort = "default"
        tools = Tools(write: phase == "synthesize" || phase == "revise", files: true, web: "inherit")
        parallel = 0
        rounds = 0
        maxTurns = 0
        prompt = ""
        native = false
        description = ""
        promptPath = "playbooks/research/roles/\(id).md"
        promptText = promptDefault
        promptIsDefault = true
        self.promptDefault = promptDefault
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? id
        phase = try c.decodeIfPresent(String.self, forKey: .phase) ?? "research"
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        agent = try c.decodeIfPresent(String.self, forKey: .agent) ?? ""
        model = try c.decodeIfPresent(String.self, forKey: .model) ?? ""
        effort = try c.decodeIfPresent(String.self, forKey: .effort) ?? "default"
        tools = try c.decodeIfPresent(Tools.self, forKey: .tools) ?? Tools(write: false, files: true, web: "inherit")
        parallel = try c.decodeIfPresent(Int.self, forKey: .parallel) ?? 0
        rounds = try c.decodeIfPresent(Int.self, forKey: .rounds) ?? 0
        maxTurns = try c.decodeIfPresent(Int.self, forKey: .maxTurns) ?? 0
        prompt = try c.decodeIfPresent(String.self, forKey: .prompt) ?? ""
        native = try c.decodeIfPresent(Bool.self, forKey: .native) ?? false
        description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        promptPath = try c.decodeIfPresent(String.self, forKey: .promptPath) ?? ""
        promptText = try c.decodeIfPresent(String.self, forKey: .promptText) ?? ""
        promptIsDefault = try c.decodeIfPresent(Bool.self, forKey: .promptIsDefault) ?? true
        promptDefault = try c.decodeIfPresent(String.self, forKey: .promptDefault) ?? ""
    }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(title, forKey: .title)
        try c.encode(phase, forKey: .phase)
        try c.encode(enabled, forKey: .enabled)
        try c.encode(agent, forKey: .agent)
        try c.encode(model, forKey: .model)
        try c.encode(effort, forKey: .effort)
        try c.encode(tools, forKey: .tools)
        try c.encode(parallel, forKey: .parallel)
        try c.encode(rounds, forKey: .rounds)
        try c.encode(maxTurns, forKey: .maxTurns)
        try c.encode(prompt, forKey: .prompt)
        try c.encode(native, forKey: .native)
        try c.encode(description, forKey: .description)
    }
}

/// `playbooks/research/profiles/<name>.yaml` as the service resolved it.
struct ResearchProfileDetail: Codable, Equatable {
    struct Reasoning: Codable, Equatable {
        /// default | low | medium | high | xhigh | max
        var effort: String
    }

    struct Search: Codable, Equatable {
        var web: String
        /// live | cached
        var freshness: String
        var maxRounds: Int
    }

    struct Verification: Codable, Equatable {
        var minSourcesPerClaim: Int
        var preferPrimarySources: Bool
        /// flag | prefer_primary | prefer_recent
        var resolveConflicts: String
    }

    struct Stop: Codable, Equatable {
        var maxSections: Int
        var marginalGain: Bool
    }

    struct Output: Codable, Equatable {
        var citations: Bool
        var uncertainty: Bool
        var evidenceTable: Bool
    }

    var name: String
    var title: String
    var description: String
    /// "" = the runner's pipeline.
    var pipeline: String
    var reasoning: Reasoning
    var search: Search
    var verification: Verification
    var stop: Stop
    var output: Output
    var roles: [ResearchRole]
    var path: String
    /// A built-in profile deletes back to its defaults instead of disappearing.
    var builtin: Bool
    /// The prompt each phase falls back to, for "Reset to built-in".
    var phaseDefaults: [String: String]

    private enum CodingKeys: String, CodingKey {
        case name, title, description, pipeline, reasoning, search, verification, stop, output, roles
        case path, builtin, phaseDefaults
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? name
        description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        pipeline = try c.decodeIfPresent(String.self, forKey: .pipeline) ?? ""
        reasoning = try c.decodeIfPresent(Reasoning.self, forKey: .reasoning) ?? Reasoning(effort: "default")
        search = try c.decodeIfPresent(Search.self, forKey: .search) ?? Search(web: "inherit", freshness: "live", maxRounds: 3)
        verification = try c.decodeIfPresent(Verification.self, forKey: .verification)
            ?? Verification(minSourcesPerClaim: 1, preferPrimarySources: true, resolveConflicts: "flag")
        stop = try c.decodeIfPresent(Stop.self, forKey: .stop) ?? Stop(maxSections: 8, marginalGain: true)
        output = try c.decodeIfPresent(Output.self, forKey: .output) ?? Output(citations: true, uncertainty: true, evidenceTable: false)
        roles = try c.decodeIfPresent([ResearchRole].self, forKey: .roles) ?? []
        path = try c.decodeIfPresent(String.self, forKey: .path) ?? ""
        builtin = try c.decodeIfPresent(Bool.self, forKey: .builtin) ?? false
        phaseDefaults = try c.decodeIfPresent([String: String].self, forKey: .phaseDefaults) ?? [:]
    }

    /// What `PUT /api/research/profiles/:name` stores: the profile itself,
    /// without the read-only fields the service derives.
    func payload(name: String? = nil) -> ResearchProfilePayload {
        ResearchProfilePayload(
            name: name ?? self.name,
            title: title,
            description: description,
            pipeline: pipeline,
            reasoning: reasoning,
            search: search,
            verification: verification,
            stop: stop,
            output: output,
            roles: roles
        )
    }

    /// Role prompts travel next to the profile; the service only writes a text
    /// that differs from what the role runs with today.
    var prompts: [String: String] {
        Dictionary(roles.map { ($0.id, $0.promptText) }, uniquingKeysWith: { _, last in last })
    }
}

struct ResearchProfilePayload: Encodable {
    var name: String
    var title: String
    var description: String
    var pipeline: String
    var reasoning: ResearchProfileDetail.Reasoning
    var search: ResearchProfileDetail.Search
    var verification: ResearchProfileDetail.Verification
    var stop: ResearchProfileDetail.Stop
    var output: ResearchProfileDetail.Output
    var roles: [ResearchRole]
}

/// One row of `GET /api/research/profiles`.
struct ResearchProfileSummary: Decodable, Identifiable, Hashable {
    var name: String
    var title: String
    var description: String
    var builtin: Bool
    var id: String { name }

    private enum CodingKeys: String, CodingKey {
        case name, title, description, builtin
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? name
        description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        builtin = try c.decodeIfPresent(Bool.self, forKey: .builtin) ?? false
    }
}

struct ResearchProfilesResponse: Decodable {
    var active: String
    var profiles: [ResearchProfileSummary]
}

struct DeleteProfileResponse: Decodable {
    var ok: Bool
    /// A built-in came back as its defaults rather than being removed.
    var reset: Bool?
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
