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
    case research
    case knowledge
    case settings

    var id: String { rawValue }

    var tabs: [AppTab] {
        switch self {
        case .library: [.files, .search, .traces]
        case .ask: [.ask]
        case .research: [.studies]
        case .knowledge: [.graph, .entities, .wiki, .dream]
        case .settings: [.providers, .pipeline, .research, .chat, .playbooks, .workspace, .access]
        }
    }

    @MainActor var title: String {
        switch self {
        case .library: L("Library")
        case .ask: L("Ask")
        case .research: L("Research")
        case .knowledge: L("Knowledge")
        case .settings: L("Settings")
        }
    }

    @MainActor var subtitle: String {
        switch self {
        case .library: L("Files, search, and agent traces")
        case .ask: L("An agent that answers from your workspace")
        case .research: L("Research a topic into several wiki pages")
        case .knowledge: L("Graph, entities, wiki, and nightly review")
        case .settings: L("Models, ingest, research, and Ask")
        }
    }

    var symbol: String {
        switch self {
        case .library: "books.vertical"
        case .ask: "sparkles"
        case .research: "doc.text.magnifyingglass"
        case .knowledge: "lightbulb"
        case .settings: "slider.horizontal.3"
        }
    }
}

/// A screen. Every tab belongs to exactly one section, which is what the
/// sidebar selects; `AppSection.tabs` is the inverse and the two must agree.
///
/// Settings reads as the three things a workspace does with knowledge, in the
/// order it happens: documents are processed as they come in (Ingest), agents
/// research them into the wiki (Research), and the result answers questions
/// (Ask). Ids keep their first names, so `pipeline` is titled Ingest; Ask's
/// settings are `chat` — the config block they edit — because `ask` is the
/// Ask screen itself.
enum AppTab: String, CaseIterable, Identifiable, Codable {
    case files
    case search
    case traces
    case ask
    case studies
    case graph
    case entities
    case wiki
    case dream
    case providers
    case pipeline
    case research
    case chat
    case playbooks
    case workspace
    case access

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
        case .studies: .research
        case .graph, .entities, .wiki, .dream: .knowledge
        case .providers, .pipeline, .research, .chat, .playbooks, .workspace, .access: .settings
        }
    }

    /**
     * Which screen shows this tab. Settings' five config tabs share one host:
     * keying view identity on the leaf instead would rebuild `SettingsView` on
     * every sub-tab click, refetching the config and discarding unsaved routes.
     * Access is a screen of its own.
     */
    var host: String {
        section == .settings && self != .access ? "settings" : rawValue
    }

    @MainActor var title: String {
        switch self {
        case .files: L("Files")
        case .search: L("Search")
        case .traces: L("Traces")
        case .ask: L("Ask")
        case .studies: L("Studies")
        case .graph: L("Graph")
        case .entities: L("Entities")
        case .wiki: L("Wiki")
        case .dream: L("Dream")
        case .providers: L("Providers & Agents")
        case .pipeline: L("Ingest")
        case .research: L("Research")
        case .chat: L("Ask")
        case .playbooks: L("Playbooks")
        case .workspace: L("Workspace")
        case .access: L("Access")
        }
    }

    @MainActor var subtitle: String {
        switch self {
        case .files: L("Browse and edit knowledge")
        case .search: L("Hybrid, vector, and keyword recall")
        case .traces: L("Claude Code and Codex sessions")
        case .ask: L("An agent that answers from your workspace")
        case .studies: L("Research a topic into several wiki pages")
        case .graph: L("Entities, relations, and claims")
        case .entities: L("Every entity, filtered and sorted")
        case .wiki: L("Pages researched by agent CLIs")
        case .dream: L("Review agent improvement ideas")
        case .providers: L("Endpoints, credentials, and who does the work")
        case .pipeline: L("How documents get processed")
        case .research: L("How the wiki gets written")
        case .chat: L("How questions get answered")
        case .playbooks: L("Templates, prompts, and vocabularies agents follow")
        case .workspace: L("Clear this workspace")
        case .access: L("Your account; users and gateways of this server")
        }
    }

    var symbol: String {
        switch self {
        case .files: "doc.text"
        case .search: "magnifyingglass"
        case .traces: "terminal"
        case .ask: "sparkles"
        case .studies: "doc.text.magnifyingglass"
        case .graph: "point.3.connected.trianglepath.dotted"
        case .entities: "tablecells"
        case .wiki: "book.closed"
        case .dream: "moon.stars"
        case .providers: "cable.connector"
        case .pipeline: "tray.and.arrow.down"
        case .research: "book.and.wrench"
        case .chat: "bubble.left.and.bubble.right"
        case .playbooks: "doc.badge.gearshape"
        case .workspace: "exclamationmark.triangle"
        case .access: "person.badge.key"
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
    /// "admin" or "member", as the service last said; absent in sessions stored before sign-in was real.
    var role: String?

    var isAdmin: Bool { role == "admin" }
}

struct StoredSession: Codable {
    var user: UserProfile
    var workspaces: [Workspace]
    var activeWorkspaceID: String
}

struct ServerHealth: Decodable {
    var ok: Bool
    var dataRoot: String?
    var workspaceIsolation: Bool?
    var auth: HealthAuth?

    struct HealthAuth: Decodable {
        var enabled: Bool
        var setupRequired: Bool?
    }
}

/* ------------------------------- sign-in -------------------------------- */

/// An account as the service shows it (src/auth/accounts.ts), never with its password.
struct AuthAccount: Codable, Hashable, Identifiable {
    var username: String
    var name: String
    var role: String
    var teams: [String]
    var remoteApis: [String]
    var gateways: [String]
    var disabled: Bool?
    var createdAt: String?
    var passwordChangedAt: String?

    var id: String { username }
    var isAdmin: Bool { role == "admin" }
}

struct AuthTeam: Decodable, Hashable {
    var id: String
    var name: String
    var slug: String
}

struct AuthGateway: Decodable, Hashable, Identifiable {
    var id: String
    var description: String
    var path: String
}

/// Who you are signed in as and what you may use from where you are.
struct AuthSnapshot: Decodable {
    var account: AuthAccount
    var local: Bool?
    var groups: [String: Bool]?
    var teams: [AuthTeam]?
    var gateways: [AuthGateway]?
    var apiGroups: [String: String]?
    /// Only in a sign-in's answer, once.
    var token: String?
}

/// GET /api/auth/state: what the sign-in screen needs before anyone is signed in.
struct AuthState: Decodable {
    var auth: Bool
    var setupRequired: Bool?
    var canSetup: Bool?
    var local: Bool?
    var minPasswordLength: Int?
}

/// A password change or "sign out others" ends every session but the one asking, which gets a new token.
struct AuthRenewal: Decodable {
    var ok: Bool
    var token: String?
}

struct AuthSessionRow: Decodable, Identifiable, Hashable {
    var id: String
    var kind: String
    var label: String
    var createdAt: String
    var lastSeenAt: String
    var expiresAt: String
    var ip: String?
    var current: Bool?
}

struct AdminUser: Decodable, Identifiable, Hashable {
    var username: String
    var name: String
    var role: String
    var teams: [String]
    var remoteApis: [String]
    var gateways: [String]
    var disabled: Bool?
    var sessions: Sessions

    struct Sessions: Decodable, Hashable {
        var count: Int
        var lastSeenAt: String?
    }

    var id: String { username }
}

struct AdminUsersResponse: Decodable {
    var users: [AdminUser]
    var apiGroups: [String: String]
    var teams: [String]
    var gateways: [String]
}

/// What the admin form sends; nil fields are left as they are.
struct AdminUserDraft: Encodable {
    var username: String?
    var name: String?
    var password: String?
    var role: String?
    var teams: [String]?
    var remoteApis: [String]?
    var gateways: [String]?
    var disabled: Bool?
}

/* ------------------------------ processing ------------------------------ */

/// Whether the workspace's processing runs: extraction slots, reviews and
/// summary pages. The service never starts it on its own.
struct ProcessingState: Decodable, Equatable {
    var running: Bool
    var since: String?
    var by: String?
}

/// GET /api/labeling/status, the parts the app shows.
struct LabelingStatusResponse: Decodable, Equatable {
    var processing: ProcessingState?
    var scheduler: Scheduler?
    var local: [LocalBackend]

    struct Scheduler: Decodable, Equatable {
        var queued: Int
        var workers: [Worker]?
        var lastHour: LastHour?
    }

    struct Worker: Decodable, Equatable {
        var worker: String
        var remote: Bool
        var leased: Int
    }

    struct LastHour: Decodable, Equatable {
        var calls: Int
        var documentsWritten: Int
    }

    struct LocalBackend: Decodable, Equatable, Identifiable {
        var id: String
        var label: String
        var slots: Int
        var busy: Int
        var pausedUntil: String?
        var pauseReason: String?
    }

    /// Remote workers that held work lately.
    var remoteWorkers: Int { scheduler?.workers?.filter { $0.remote && $0.leased > 0 }.count ?? 0 }
}

/// POST /api/labeling/start | stop.
struct ProcessingSwitchResponse: Decodable {
    var ok: Bool
    var changed: Bool
    var processing: ProcessingState
}

struct GatewayRecord: Decodable, Identifiable, Hashable {
    var id: String
    var target: String
    var description: String?
    var sandbox: Bool?
    var passAuthorization: Bool?
    var createdAt: String?
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
    /// Extraction calls still to make for the queue (a long document counts its segments).
    var extractionSegments: Int?
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
    /// What a folder knode-os makes is for (FOLDER_ABOUT in the service), in
    /// English; the row shows it through `L`, which knows every one.
    var about: String?
    /// The folder on the service's machine a linked folder mirrors.
    var linked: String?

    var id: String { path.isEmpty ? "__root__" : path }
    var isWritable: Bool { path == "wiki" || path.hasPrefix("wiki/") || path == "raw/docs" || path.hasPrefix("raw/docs/") }

    /// Root files the file view may edit although nothing else may happen to
    /// them there — no move, rename or delete: what the workspace is for and
    /// the rules its wiki follows (OWNER_ROOT_FILES in the service).
    static let ownerRootFiles: Set<String> = ["purpose.md", "schema.md"]
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

/// The wiki pages citing a raw/docs file (`GET /api/file/citations`): its
/// `[[raw/docs/…]]` and Markdown links, `sources:` entries and typed
/// `relations:` such as `tested_by` (src/graph/citations.ts).
struct FileCitationsResponse: Decodable {
    var path: String
    var citedBy: [CitingPage]
}

struct CitingPage: Decodable, Identifiable {
    var path: String
    var title: String?
    /// `trusted`, or `quarantined` for a page an agent wrote that nobody has promoted yet.
    var trust: String
    var links: [CitationLink]

    var id: String { path }

    /// How the page cites the file, as it reads: "derived from · tested by".
    var labels: String {
        var seen = Set<String>()
        return links.map { $0.label.replacingOccurrences(of: "_", with: " ") }
            .filter { seen.insert($0).inserted }
            .joined(separator: " · ")
    }
}

struct CitationLink: Decodable {
    var type: String
    var inverse: Bool
    /// The predicate as the page states it toward the file: an inverse row reads as its inverse name (`tests`).
    var label: String
    /// `wikilink`, `embed`, `markdown`, `sources` or `relations`.
    var via: String
    var fragment: String?
}

/// Where a followed link leads (GET /api/link/resolve): a file, or — for a name no
/// note answers to but the graph knows — the entity, whose panel the link opens.
struct ResolvedLinkResponse: Decodable {
    struct Entity: Decodable {
        var id: String
        var name: String
        var type: String
    }

    var path: String?
    var fragment: String?
    var entity: Entity?
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
    /// Mentions in an overview; hop-decayed relevance to the query in a search.
    var score: Double
    var mentionCount: Int
    /// Live typed relations across the whole graph, not only the ones in view; absent from older services.
    var degree: Int?
    var wikiPath: String?
}

struct GraphEdge: Decodable, Hashable, Identifiable {
    var source: String
    var target: String
    var type: String
    var description: String
    var weight: Double
    /// Date-only world-time window, when the relation carries one.
    var validFrom: String? = nil
    var validTo: String? = nil
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

/// One row of Knowledge → Entities (`GET /api/entities`): a live entity with
/// the numbers that say what it is worth. The JSON is camelCase already, and
/// the `sources` families carry no underscore, so the snake_case decoder
/// leaves every key as it came.
struct EntityItem: Decodable, Identifiable, Hashable {
    var id: String
    var name: String
    var type: String
    var description: String
    var aliases: [String]
    var wikiPath: String?
    /// Distinct chunks that mention the entity.
    var mentions: Int
    var documents: Int
    /// Live typed relations it takes part in, from either end.
    var relations: Int
    var evidence: Int
    /// Live entity evidence per extractor family: mined, link, wikilink, frontmatter, llm, human, datasource, probe, other.
    var sources: [String: Int]
    /// The survivor this entity was merged into, when it was.
    var canonicalId: String?
    var createdAt: String?
    var updatedAt: String?

    /// What the Updated column sorts by; a missing date sorts first.
    var updatedKey: String { updatedAt ?? "" }
}

/// One page of the entity table, with the type counts of the whole table under the same `merged` setting.
struct EntityPage: Decodable {
    var items: [EntityItem]
    var total: Int
    var offset: Int
    var limit: Int
    var sort: String
    var order: String
    var typeCounts: [GraphInsights.TypeCount]
}

/// An entity a text names, with the spellings the text uses for it (POST /api/entities/mentions).
struct EntityMention: Decodable, Hashable, Identifiable {
    var id: String
    var name: String
    var type: String
    var wikiPath: String?
    var surfaces: [String]
    var count: Int
}

struct EntityMentionsResponse: Decodable {
    var mentions: [EntityMention]
}

/// One entity at a glance, for the panel a marked name opens (GET /api/entities/detail).
struct EntityDetail: Decodable {
    struct Entity: Decodable, Hashable {
        var id: String
        var name: String
        var type: String
        var description: String
        var aliases: [String]
        var wikiPath: String?
        var mentionCount: Int
        var documentCount: Int
        var degree: Int
    }

    struct Neighbour: Decodable, Hashable, Identifiable {
        var id: String
        var name: String
        var type: String
        var wikiPath: String?
    }

    struct Relation: Decodable, Hashable {
        var type: String
        /// `out` reads entity → other, `in` other → entity.
        var direction: String
        var weight: Double
        var description: String
        var validFrom: String?
        var validTo: String?
    }

    /// Every relation with one neighbour, strongest first.
    struct RelationGroup: Decodable, Hashable, Identifiable {
        var other: Neighbour
        var weight: Double
        var relations: [Relation]

        var id: String { other.id }
    }

    /// An entity its documents mention alongside it, with no typed relation between them.
    struct CoMention: Decodable, Hashable, Identifiable {
        var id: String
        var name: String
        var type: String
        var wikiPath: String?
        var documents: Int
        var chunks: Int
        var weight: Double
    }

    struct Document: Decodable, Hashable, Identifiable {
        var path: String
        var title: String?
        var mentions: Int

        var id: String { path }
    }

    var entity: Entity
    var relations: [RelationGroup]
    var moreRelations: Int
    var cooccurring: [CoMention]
    var claims: [Claim]
    var documents: [Document]
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

/// What a pass over the configured datasources did (`POST /api/datasources/sync`).
struct DatasourceSyncResponse: Decodable {
    var sources: Int
    var wikiPages: Int
    var errors: [String]
}

/// What the service says a person should know about the workspace
/// (`GET /api/notices`, src/server/notices.ts): data, not sentences — the app
/// words each kind in the interface language. `id` is the kind, of which there
/// is at most one; `key` changes when the notice says something new.
struct NoticesResponse: Decodable {
    var notices: [WorkspaceNotice]
}

struct WorkspaceNotice: Decodable, Identifiable, Hashable {
    /// lint, traces-off, purpose, initialize or datasources.
    var id: String
    var key: String
    /// info or warn.
    var level: String
    // lint: the newest report, and the one before it
    var report: String?
    var date: String?
    var summary: LintSummary?
    var previous: LintPrevious?
    // traces-off: what collecting would copy
    var sessions: Int?
    var bytes: Int?
    // purpose: the file to write
    var path: String?
    // initialize: which of the two exist already
    var overview: Bool?
    var guide: Bool?
    // datasources: the last pass
    var at: String?
    var sources: Int?
    var errors: [String]?
}

/// A lint report's counts, as its summary line states them.
struct LintSummary: Decodable, Hashable {
    var pages: Int
    var findings: Int
    var counts: LintCounts
}

/// The kinds of finding (the service's LintKind; the decoder turns `broken_link` into `brokenLink`).
struct LintCounts: Decodable, Hashable {
    var orphan: Int?
    var brokenLink: Int?
    var staleResearch: Int?
    var unreviewed: Int?
    var expired: Int?
    var supersededText: Int?
    var openDispute: Int?
}

struct LintPrevious: Decodable, Hashable {
    var date: String
    var summary: LintSummary
}

/// playbooks/ as Settings edits it (`GET /api/playbooks`, src/fs/playbooks.ts).
struct PlaybooksResponse: Decodable {
    var groups: [PlaybookGroup]
}

struct PlaybookGroup: Decodable, Identifiable, Hashable {
    /// research, phases, packs, intents, ontology, concepts, capabilities, chat, agents, profiles or sources.
    var id: String
    var dir: String
    /// providers, research or sources: the page that edits the whole group, files or none.
    var managedIn: String?
    var files: [PlaybookFile]
}

struct PlaybookFile: Decodable, Identifiable, Hashable {
    var id: String { path }
    var path: String
    var name: String
    var bytes: Int
    var mtime: String
    /// knode-os ships a version of the file: a reset writes it back.
    var builtin: Bool
    /// The file differs from that version.
    var modified: Bool
    /// knode-os regenerates the file, so an edit would not last.
    var readonly: Bool
    /// providers, research or sources: the page that edits the file instead.
    var managedIn: String?
}

/// One playbook with its text, as reading, saving and resetting return it.
struct PlaybookText: Decodable {
    var file: PlaybookFile
    var text: String

    private enum CodingKeys: String, CodingKey { case text }

    init(from decoder: Decoder) throws {
        file = try PlaybookFile(from: decoder)
        text = try decoder.container(keyedBy: CodingKeys.self).decode(String.self, forKey: .text)
    }
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
    var enabled: Bool?
    var priority: Int?
    var quotaGroup: String?
    var limits: EmbeddingLimits?
    var limitNote: String?
    var catalog: [String]?
    var upstream: String?

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
        enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled)
        priority = try container.decodeIfPresent(Int.self, forKey: .priority)
        quotaGroup = try container.decodeIfPresent(String.self, forKey: .quotaGroup)
        limits = try container.decodeIfPresent(EmbeddingLimits.self, forKey: .limits)
        limitNote = try container.decodeIfPresent(String.self, forKey: .limitNote)
        catalog = try container.decodeIfPresent([String].self, forKey: .catalog)
        upstream = try container.decodeIfPresent(String.self, forKey: .upstream)
    }
}

struct EmbeddingLimits: Codable, Equatable {
    var requestsPerMinute = 60
    var tokensPerMinute = 100_000
    var requestsPerDay = 5_000
    var tokensPerDay = 1_000_000
    var concurrency = 2
    var resetTimezone = "UTC"
}

struct EmbeddingPoolConfig: Codable, Equatable {
    var enabled = false
    var model = "bge-m3"
    var dimensions = 1024
    var batchSize = 16
}

struct EmbeddingUsageResponse: Decodable {
    var entries: [EmbeddingUsage]
}

struct EmbeddingUsage: Decodable, Identifiable {
    var id: String
    var requestsToday: Int
    var tokensToday: Int
    var estimatedTokensToday: Int?
    var requestsThisMinute: Int
    var inFlight: Int
    var cooldownUntil: Double?
    var lastError: String?
    var lastSuccess: Double?
}

struct EmbeddingTestResponse: Decodable {
    var ok: Bool
    var model: String?
    var dimensions: Int?
    var ms: Int?
    var error: String?
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
/// default provider — and `model`, `effort` and `speed` override that
/// target's own ("default" keeps the target's). The remaining fields only
/// carry pre-connections configs the service migrates.
struct RoutedLLMConfig: Codable, Equatable {
    var use: String
    var provider: String
    var baseUrl: String
    var apiKey: String
    var model: String
    var cliPath: String
    var effort: String
    var speed: String
    var cliTimeoutMs: Int?

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        use = try container.decodeIfPresent(String.self, forKey: .use) ?? ""
        provider = try container.decodeIfPresent(String.self, forKey: .provider) ?? "inherit"
        baseUrl = try container.decodeIfPresent(String.self, forKey: .baseUrl) ?? ""
        apiKey = try container.decodeIfPresent(String.self, forKey: .apiKey) ?? ""
        model = try container.decodeIfPresent(String.self, forKey: .model) ?? ""
        cliPath = try container.decodeIfPresent(String.self, forKey: .cliPath) ?? ""
        effort = try container.decodeIfPresent(String.self, forKey: .effort) ?? "default"
        speed = try container.decodeIfPresent(String.self, forKey: .speed) ?? "default"
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
    /// "fast" = codex's priority tier; "default" leaves the CLI's own. Only a
    /// CLI agent standing in as a target carries anything else.
    var speed: String
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
        speed = "default"
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
        speed = try container.decodeIfPresent(String.self, forKey: .speed) ?? "default"
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
    var claims: Bool
    var entityLlm: RoutedLLMConfig
    var documentLlm: RoutedLLMConfig
    /// The Summarize stage: one summary page per document, written in the
    /// background pass right after extraction.
    var summaryLlm: RoutedLLMConfig
    /// The Judge stage: knode_ask, Dream, the duplicate-entity review after
    /// each extraction pass and the disputed-claim review.
    var judgeLlm: RoutedLLMConfig
    /// Model calls per background pass: extraction calls (a long document
    /// takes one per segment) and, separately, summaries.
    var batchSize: Int
    /// Parallel model calls in a background pass, for both.
    var concurrency: Int
    /// Longest text one extraction call reads (characters); a longer document
    /// is read in segments. File-only — shown, never sent back as a change.
    var segmentChars: Int?
}

/// What the Judge stage does with its verdicts: the service's `review.llmJudge`,
/// `review.claims` and `review.claimMerge`. The thresholds stay in the config
/// file, and the service keeps every key this client does not send.
struct ReviewConfig: Codable, Equatable {
    /// "off" | "suggest" | "auto" — auto merges pairs judged the same with
    /// high confidence; a merge can always be undone.
    var llmJudge: String
    /// "off" | "suggest"
    var claims: String
    /// Duplicate claims: "off" | "suggest" | "auto" — auto merges identical
    /// wordings and pairs judged the same with high confidence; undoable.
    var claimMerge: String
    /// The workspace's web switch, for research jobs and Ask alike:
    /// "off" | "verify" (verification jobs, and agents set to on) | "research"
    /// (every job). Edited on the Research tab.
    var external: String

    init(llmJudge: String = "suggest", claims: String = "suggest", claimMerge: String = "auto", external: String = "verify") {
        self.llmJudge = llmJudge
        self.claims = claims
        self.claimMerge = claimMerge
        self.external = external
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let fallback = ReviewConfig()
        llmJudge = try container.decodeIfPresent(String.self, forKey: .llmJudge) ?? fallback.llmJudge
        claims = try container.decodeIfPresent(String.self, forKey: .claims) ?? fallback.claims
        claimMerge = try container.decodeIfPresent(String.self, forKey: .claimMerge) ?? fallback.claimMerge
        external = try container.decodeIfPresent(String.self, forKey: .external) ?? fallback.external
    }
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

    /// What the Wiki tab's initialize button does around its agent run. It
    /// always first extracts what the tier-1 queue still holds; the cap on
    /// that is edited with the Extract stage under Ingest, the follow-ups in
    /// the Research runner card.
    struct Initialization: Codable, Equatable {
        /// Topic pages queued as follow-up research jobs.
        var followUps: Int
        /// How long the catch-up extraction may run before the agent starts.
        var extractionMaxMs: Int

        init(followUps: Int = 6, extractionMaxMs: Int = 900_000) {
            self.followUps = followUps
            self.extractionMaxMs = extractionMaxMs
        }

        init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            let fallback = Initialization()
            followUps = try container.decodeIfPresent(Int.self, forKey: .followUps) ?? fallback.followUps
            extractionMaxMs = try container.decodeIfPresent(Int.self, forKey: .extractionMaxMs) ?? fallback.extractionMaxMs
        }
    }

    /// A connection id or a CLI provider name; empty follows the default LLM
    /// provider when that is itself a CLI.
    var agent: String
    var model: String
    var profile: String
    /// "team" | "native" | "single" for a profile that names none. Settings
    /// edits the pipeline on the profile, so this only round-trips.
    var pipeline: String
    /// The turn cap for a template that sets none — every built-in one does.
    /// Not edited here; the roles carry their own.
    var maxTurns: Int
    /// One agent session's limit; a team job runs several.
    var timeoutMs: Int
    var concurrency: Int
    /// What a research role with no `parallel` of its own runs at.
    var researchers: Int
    /// What a revise role with no `rounds` of its own runs at.
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
    var embeddingPool: EmbeddingPoolConfig?
    /// A mirror of the connection `llmUse` names, flattened by the service.
    /// Read-only here: the table edits the list, like the embedding one.
    var llm: LLMConfig
    var connections: [LLMConnection]
    /// Which `connections` entry every job inherits unless it names another.
    var llmUse: String
    var ingest: IngestConfig
    var extraction: ExtractionConfig
    var review: ReviewConfig
    var research: ResearchConfig
    var chat: ChatConfig

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        embedding = try container.decode(EmbeddingConfig.self, forKey: .embedding)
        embeddingProviders = try container.decodeIfPresent([EmbeddingConnection].self, forKey: .embeddingProviders) ?? []
        embeddingUse = try container.decodeIfPresent(String.self, forKey: .embeddingUse) ?? ""
        embeddingPool = try container.decodeIfPresent(EmbeddingPoolConfig.self, forKey: .embeddingPool)
        llm = try container.decode(LLMConfig.self, forKey: .llm)
        connections = try container.decodeIfPresent([LLMConnection].self, forKey: .connections) ?? []
        llmUse = try container.decodeIfPresent(String.self, forKey: .llmUse) ?? ""
        ingest = try container.decodeIfPresent(IngestConfig.self, forKey: .ingest) ?? IngestConfig()
        extraction = try container.decode(ExtractionConfig.self, forKey: .extraction)
        review = try container.decodeIfPresent(ReviewConfig.self, forKey: .review) ?? ReviewConfig()
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
    /// Web tools in Ask, within `review.external`. Ask's turn cap, timeout,
    /// page and file tools are its own, the same for every agent.
    struct Tools: Codable, Equatable {
        /// "inherit" | "on" | "off"
        var web: String

        init(web: String = "inherit") {
            self.web = web
        }

        init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            web = try container.decodeIfPresent(String.self, forKey: .web) ?? Tools().web
        }
    }

    var name: String
    var title: String
    /// A CLI provider name runs that CLI; "default" or a connection id runs
    /// the built-in deepagents loop on that model.
    var executor: String
    /// A CLI agent's executable; "" = the CLI's own name on PATH.
    var cliPath: String
    var model: String
    var effort: String
    /// "fast" = codex's priority tier; the other CLIs ignore it.
    var speed: String
    var tools: Tools
    var path: String
    /// Server-reported, never sent back.
    var builtin: Bool
    var runnable: Bool

    var id: String { name }

    init(name: String, executor: String = "default") {
        self.name = name
        title = name
        self.executor = executor
        cliPath = ""
        model = ""
        effort = "default"
        speed = "default"
        tools = Tools()
        path = ""
        builtin = false
        runnable = false
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        title = try container.decodeIfPresent(String.self, forKey: .title) ?? name
        executor = try container.decodeIfPresent(String.self, forKey: .executor) ?? ""
        cliPath = try container.decodeIfPresent(String.self, forKey: .cliPath) ?? ""
        model = try container.decodeIfPresent(String.self, forKey: .model) ?? ""
        effort = try container.decodeIfPresent(String.self, forKey: .effort) ?? "default"
        speed = try container.decodeIfPresent(String.self, forKey: .speed) ?? "default"
        tools = try container.decodeIfPresent(Tools.self, forKey: .tools) ?? Tools()
        path = try container.decodeIfPresent(String.self, forKey: .path) ?? ""
        builtin = try container.decodeIfPresent(Bool.self, forKey: .builtin) ?? false
        runnable = try container.decodeIfPresent(Bool.self, forKey: .runnable) ?? false
    }

    /// What `PUT /api/agents/:name` takes: the server owns `builtin`/`runnable`/`path`.
    struct Payload: Encodable {
        var title: String
        var executor: String
        var cliPath: String
        var model: String
        var effort: String
        var speed: String
        var tools: Tools
    }

    var payload: Payload {
        Payload(title: title, executor: executor, cliPath: cliPath, model: model, effort: effort, speed: speed, tools: tools)
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
        target.speed = speed
        return target
    }

    /// An agent as a pipeline stage sees it, run once through its own loop: a
    /// CLI agent as `asLlmTarget`, a deepagents agent as the endpoint it runs
    /// on, with its own model or else the endpoint's — the service runs the
    /// deepagents loop there, which is what sets it apart from that endpoint's
    /// row. Nil for one that runs on nothing: it follows a default that is a
    /// CLI agent, or names a model endpoint that is gone. The client-side
    /// mirror of the service's `routeTargets`.
    func asRouteTarget(connections: [LLMConnection], defaultTarget: LLMConnection?) -> LLMConnection? {
        if isCli { return asLlmTarget }
        let endpoint = executor == "default" ? defaultTarget : connections.first { $0.id == executor }
        guard var target = endpoint, !cliProviderNames.contains(target.provider) else { return nil }
        target.id = name
        target.label = title.trimmingCharacters(in: .whitespaces).isEmpty ? name : title
        if !model.isEmpty { target.model = model }
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
    var documentLlm: RouteTestResult?
    var summaryLlm: RouteTestResult?
    var judgeLlm: RouteTestResult?
}

/// One entry of what a provider offers for a `model` field. The field itself
/// stays free text — this is a shortcut, not a closed set.
struct ModelOption: Decodable, Identifiable, Hashable {
    var id: String
    var label: String?
    /// The reasoning efforts it accepts, lowest first — only when the
    /// provider says (codex's catalog). Nil = unknown: the CLI's own ladder.
    var efforts: [EffortOption]?
    /// The level it runs at when none is set.
    var defaultEffort: String?
    /// Speeds beyond standard it offers, e.g. codex's Fast tier.
    var speeds: [SpeedOption]?
}

struct EffortOption: Decodable, Hashable {
    var id: String
    var description: String?
}

struct SpeedOption: Decodable, Hashable {
    var id: String
    var name: String?
    var description: String?
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
    /// What the CLI runs when nothing is named, from its own config file.
    var defaults: CliDefaults?
}

/// A CLI's own defaults (codex's `~/.codex/config.toml`), so an empty model
/// field or a "default" effort can show what it comes to.
struct CliDefaults: Decodable, Hashable {
    var model: String?
    var effort: String?
    /// "fast" when the CLI asks for its priority tier on its own.
    var speed: String?
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
    /// "default" = the profile's speed; "fast" = codex's priority tier.
    var speed: String
    var tools: Tools
    /// research phase: parallel sessions (0 = `research.researchers`).
    var parallel: Int
    /// revise phase: review → revise rounds (0 = `research.reviewRounds`).
    /// A review role's own is the older spelling, read only while no reviser
    /// sets one; Settings no longer shows it there.
    var rounds: Int
    /// 0 = the page template's cap.
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
        case id, title, phase, enabled, agent, model, effort, speed, tools, parallel, rounds, maxTurns, prompt, native, description
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
        speed = "default"
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
        speed = try c.decodeIfPresent(String.self, forKey: .speed) ?? "default"
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
        try c.encode(speed, forKey: .speed)
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
        /// default | low | medium | high | xhigh | max | ultra
        var effort: String
        /// default | fast
        var speed: String

        init(effort: String = "default", speed: String = "default") {
            self.effort = effort
            self.speed = speed
        }

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            effort = try c.decodeIfPresent(String.self, forKey: .effort) ?? "default"
            speed = try c.decodeIfPresent(String.self, forKey: .speed) ?? "default"
        }
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
    /// "team" | "native" | "single"; "" = `research.pipeline`, which the
    /// picker shows and replaces with an explicit value once it is changed.
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


/* ------------------------------ research studies ------------------------------ */

/// A study as the list shows it (GET /api/research/studies).
struct StudySummary: Decodable, Identifiable, Hashable {
    struct Step: Decodable, Hashable { var name: String; var status: String; var detail: String? }
    var id: String
    var status: String
    var stage: String
    var title: String
    var topic: String
    var pages: Int
    var createdAt: String
    var error: String?
    var steps: [Step]
}

/// One study (GET /api/research/studies/:id): its brief, stages, pages, sources and report.
struct StudyDetail: Decodable {
    struct Job: Decodable { var id: String; var status: String; var agent: String?; var error: String?; var startedAt: String?; var finishedAt: String? }
    struct Clarification: Decodable, Hashable { var question: String; var options: [String]; var answer: String? }
    struct Question: Decodable, Hashable { var id: String; var text: String; var page: String }
    struct Page: Decodable, Hashable { var id: String; var title: String; var slug: String; var purpose: String; var sections: [String]; var questions: [String] }
    struct Report: Decodable { var title: String }
    struct Brief: Decodable {
        var title: String
        var slug: String
        var language: String
        var objective: String
        var restatement: String
        var clarifications: [Clarification]
        var questions: [Question]
        var pages: [Page]
        var report: Report
    }
    struct Runner: Decodable { var mode: String; var agent: String }
    struct Payload: Decodable {
        var topic: String
        var brief: Brief
        var stage: String
        var steps: [StudySummary.Step]
        var runner: Runner
    }
    struct PageState: Decodable, Identifiable, Hashable { var id: String; var title: String; var path: String; var status: String; var trust: String?; var error: String? }
    struct Capture: Decodable, Identifiable, Hashable {
        var path: String; var title: String?; var site: String; var kind: String; var published: String?; var url: String
        var id: String { path }
    }
    /// The files one Promote covers, by tier: `quarantined` is what it would make trusted.
    struct TierCounts: Decodable { var trusted: Int; var quarantined: Int; var unindexed: Int }
    struct Tiers: Decodable { var pages: TierCounts; var sources: TierCounts }
    var job: Job
    var payload: Payload
    var reportPath: String
    var reportExists: Bool
    var pages: [PageState]
    var captures: [Capture]
    var tiers: Tiers?
    var refining: String?
    var startProblem: String?

    var isLive: Bool { ["queued", "running", "validating", "waiting"].contains(job.status) || refining != nil }
}
