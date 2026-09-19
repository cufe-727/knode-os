import Foundation
import SwiftUI

/// The app's interface language. It is a client-side preference, not part of
/// the workspace config: what the service stores — role prompts, profile
/// titles someone typed, the wiki pages agents write — is data, and stays in
/// the language it was written in. Only the chrome around it switches.
enum AppLanguage: String, CaseIterable, Identifiable {
    case system
    case english
    case chinese

    var id: String { rawValue }

    /// Shown in both languages so the picker is readable whichever way it is set.
    var label: String {
        switch self {
        case .system: "跟随系统 · System"
        case .english: "English"
        case .chinese: "中文"
        }
    }

    var isChinese: Bool {
        switch self {
        case .chinese: true
        case .english: false
        case .system: Locale.preferredLanguages.first?.hasPrefix("zh") ?? false
        }
    }
}

/// Where the current language lives. Views read it through `L(_:)`; the value
/// itself is mirrored from `AppModel.language`, which every view observes, so
/// changing it redraws the whole interface.
@MainActor
enum L10n {
    static let storageKey = "knode-os.macos.language.v1"

    private(set) static var current: AppLanguage = {
        AppLanguage(rawValue: UserDefaults.standard.string(forKey: storageKey) ?? "") ?? .system
    }()

    static func set(_ language: AppLanguage) {
        current = language
        UserDefaults.standard.set(language.rawValue, forKey: storageKey)
    }

    static var isChinese: Bool { current.isChinese }
}

/// Translates one interface string. The English text is the key, so an entry
/// that has no translation yet still renders — in English — instead of showing
/// a key name to the user.
@MainActor
func L(_ english: String) -> String {
    guard L10n.isChinese else { return english }
    return zhHans[english] ?? english
}

/// The `%@` / `%d` form, for a string with values in it.
@MainActor
func L(_ english: String, _ arguments: any CVarArg...) -> String {
    String(format: L(english), arguments: arguments)
}

/// Names the service seeds its built-in research profiles and roles with. They
/// are stored data — the user may rename them — so they are only translated
/// while they still read exactly as the service wrote them.
@MainActor
enum BuiltinNames {
    private static let roleTitles: [String: String] = [
        "planner": "Planner",
        "researcher": "Researcher",
        "synthesizer": "Lead writer",
        "critic": "Reviewer",
        "reviser": "Reviser",
    ]

    private static let seededRoleTitles: [String: String] = [
        "planner": "规划者",
        "researcher": "研究员",
        "synthesizer": "主笔",
        "critic": "评审",
        "reviser": "修订者",
    ]

    private static let roleDescriptions: [String: String] = [
        "读简报、摸底索引，把页面拆成可并行调查的章节（JSON 提纲）":
            "Reads the brief, scouts the index, and splits the page into sections that can be researched in parallel (a JSON outline)",
        "只负责一个章节：用 knode 检索与只读资料取证，返回发现与候选 claims / relations":
            "Takes one section: gathers evidence through knode search and read-only sources, and returns findings plus candidate claims / relations",
        "把发现综合成页面并用 knode_write 写入":
            "Turns the findings into the page and writes it with knode_write",
        "对照契约评审页面，抽查来源，返回 JSON 判定":
            "Reviews the page against the contract, spot-checks sources, and returns a JSON verdict",
        "按评审与校验意见修正页面":
            "Fixes the page against the review and validation notes",
    ]

    private static let profileTitles: [String: String] = [
        "默认 · 团队流水线": "Default · team pipeline",
        "快速 · 单会话": "Quick · single session",
        "深度 · 高强度核实": "Thorough · high verification",
        "原生子代理": "Native sub-agents",
    ]

    private static let profileDescriptions: [String: String] = [
        "规划 → 并行调查 → 综合 → 评审 → 修订；推理强度与联网跟随 CLI 与 review.external 的默认值。":
            "Plan → parallel research → synthesize → review → revise; effort and web access follow the CLI and review.external defaults.",
        "一个会话独立完成，适合刷新已有页面或小问题；章节少、检索轮次少。":
            "One session does everything — good for refreshing a page or a small question; fewer sections, fewer search rounds.",
        "最高推理强度、更多研究员与评审轮次、每条事实至少两个来源、附证据表；成本最高。":
            "Top effort, more researchers and review rounds, at least two sources per fact, with an evidence table; the most expensive option.",
        "一个主管会话，研究员与评审作为 CLI 原生子代理（claude --agents / codex agents.enabled）；cursor 退回单会话。":
            "One orchestrator session with the researchers and reviewers as the CLI's own sub-agents (claude --agents / codex agents.enabled); cursor falls back to a single session.",
    ]

    /// A role the service seeds covers exactly one phase; a role someone adds
    /// picks its own, so only these have their phase stated rather than chosen.
    static func isSeededRole(_ id: String) -> Bool { seededRoleTitles[id] != nil }

    /// The role's own title, translated only while it is still the seeded one.
    static func roleTitle(id: String, title: String) -> String {
        guard !L10n.isChinese else { return title.isEmpty ? (seededRoleTitles[id] ?? id) : title }
        guard title == seededRoleTitles[id], let english = roleTitles[id] else { return title }
        return english
    }

    static func roleDescription(_ description: String) -> String {
        L10n.isChinese ? description : (roleDescriptions[description] ?? description)
    }

    static func profileTitle(_ title: String) -> String {
        L10n.isChinese ? title : (profileTitles[title] ?? title)
    }

    static func profileDescription(_ description: String) -> String {
        L10n.isChinese ? description : (profileDescriptions[description] ?? description)
    }
}

/// English → 简体中文. Keys are the exact English strings the views pass to
/// `L(_:)`; anything missing falls through to English.
/// Built from pairs rather than written as a dictionary literal: a duplicate
/// key in a literal traps at first lookup, and the first lookup only happens
/// once someone switches to Chinese. Here the first spelling simply wins.
@MainActor
private let zhHans: [String: String] = Dictionary(zhHansPairs, uniquingKeysWith: { first, _ in first })

@MainActor
private let zhHansPairs: [(String, String)] = [
    // MARK: - Shell and sections
    // Level 1: the four sidebar sections.
    ("Library", "资料"),
    ("Files, search, and agent traces", "文件、检索与 agent 轨迹"),
    ("Ask", "问答"),
    ("Quick cited answers, or a working agent", "带引用的快速回答，或交给 agent 深入"),
    ("Knowledge", "知识"),
    ("Graph, wiki, and nightly review", "图谱、Wiki 与夜间复盘"),
    ("Settings", "设置"),
    ("Model routes and pipeline limits", "模型路由与流水线限额"),
    // Level 2: the tabs inside them.
    ("Files", "文件"),
    ("Browse and edit knowledge", "浏览与编辑知识"),
    ("Search", "检索"),
    ("Hybrid, vector, and keyword recall", "混合、向量与关键词召回"),
    ("Traces", "轨迹"),
    ("Claude Code and Codex sessions", "Claude Code 与 Codex 会话"),
    ("Graph", "图谱"),
    ("Entities, relations, and claims", "实体、关系与断言"),
    ("Wiki", "Wiki"),
    ("Pages researched by agent CLIs", "由 agent CLI 研究产出的页面"),
    ("Dream", "夜间分析"),
    ("Review agent improvement ideas", "查看 agent 改进建议"),
    ("Providers", "服务商"),
    ("Sync now", "立即同步"),
    ("Loading traces…", "正在加载轨迹…"),
    ("No traces yet", "还没有轨迹"),
    ("No matching traces", "没有匹配的轨迹"),
    ("Run a Claude Code or Codex session, then sync it into this workspace.", "先跑一次 Claude Code 或 Codex 会话，再同步进这个工作区。"),
    ("Try another project, source, or session ID.", "换一个项目、来源或会话 ID 试试。"),
    ("Scope", "范围"),
    ("Whole base", "整个知识库"),
    ("Limit the search to a folder — the one picked in Files is offered here.", "把检索限制在某个目录 —— 在「文件」里选中的目录会出现在这里。"),
    ("Clear this workspace", "清空这个工作区"),
    ("Language", "语言"),

    // MARK: - Settings · shell
    ("Model routing", "模型路由"),
    ("Give each knowledge job the right model.", "给每种知识工作配上合适的模型。"),
    ("Test stages", "测试各阶段"),
    ("Save & apply", "保存并应用"),
    ("Loading model routes…", "正在载入模型路由…"),
    ("Could not load settings", "无法载入设置"),
    ("The local service is unavailable. Retry to start it and reload this workspace's routes.", "本地服务不可用。重试可以启动它并重新载入这个工作区的路由。"),
    ("Retry", "重试"),
    ("Convert", "转换"),
    ("Images & scanned PDFs", "图片与扫描版 PDF"),
    ("Index", "索引"),
    ("Embedding", "向量化"),
    ("Extract", "抽取"),
    ("Entities & relations", "实体与关系"),
    ("Synthesize", "综合"),
    ("Concept pages", "概念页"),
    ("Answer", "回答"),
    ("Ask, Wiki & Dream", "问答、Wiki 与夜间分析"),
    ("Loading…", "载入中…"),
    ("Not configured", "未配置"),
    ("Default model", "默认模型"),

    // MARK: - Settings · 01 providers
    ("01 · Providers", "01 · 提供方"),
    ("Endpoints and credentials", "端点与凭据"),
    ("Configure each provider once. Every stage below picks from this list, so no endpoint or key is ever entered twice.", "每个提供方只配一次。下面每个阶段都从这个列表里选，端点和密钥不会填第二遍。"),
    ("Configure once", "只配一次"),
    ("Embedding provider", "向量化提供方"),
    ("One per workspace — the Index stage always uses it.", "每个工作区一个 —— 索引阶段固定用它。"),
    ("Required", "必填"),
    ("Provider", "提供方"),
    ("Local hashing · offline", "本地哈希 · 离线"),
    ("OpenAI-compatible API", "OpenAI 兼容 API"),
    ("Volcengine Ark · multimodal", "火山方舟 · 多模态"),
    ("Model", "模型"),
    ("Base URL", "接口地址"),
    ("API key", "API 密钥"),
    ("Dimensions", "维度"),
    ("Batch size", "批大小"),
    ("Send dimensions with API requests", "请求里带上 dimensions 参数"),
    ("Default LLM provider", "默认 LLM 提供方"),
    ("What a stage runs on unless it picks another connection, and what answers Ask, Wiki and Dream.", "各阶段没有另选连接时跑在它上面，问答、Wiki 与夜间分析也用它。"),
    ("Default", "默认"),
    ("Codex CLI", "Codex CLI"),
    ("Claude Code CLI", "Claude Code CLI"),
    ("Cursor Agent CLI", "Cursor Agent CLI"),
    ("Connections", "连接"),
    ("Add connection", "新增连接"),
    ("Name this connection", "给这个连接起个名字"),
    ("Remove this connection", "删除这个连接"),
    ("Kind", "类型"),
    ("Name", "名称"),
    ("Add provider", "新增提供方"),
    ("LLM provider", "LLM 提供方"),
    ("Embed", "向量"),
    ("LLM", "LLM"),
    ("Name this provider", "给这个提供方起个名字"),
    ("No model set", "未设模型"),
    ("Expand %@", "展开 %@"),
    ("Collapse %@", "收起 %@"),
    ("Remove this provider", "删除这个提供方"),
    ("This provider cannot be removed", "这个提供方不能删除"),
    ("Index now runs on %@ — saving re-embeds the corpus.", "索引改为使用 %@ —— 保存后会重新向量化整个知识库。"),
    ("Hashing", "哈希"),
    ("%@d", "%@ 维"),
    ("%@ · %@d", "%@ · %@ 维"),
    ("Use CLI default", "用 CLI 自带的默认值"),

    // MARK: - Settings · 02 pipeline
    ("02 · Pipeline", "02 · 流水线"),
    ("What each stage needs", "每个阶段需要什么"),
    ("A document moves down this list. The stages ask different things of a model, which is why each one can run somewhere else.", "一份文档顺着这个列表往下走。各阶段对模型的要求不同，所以每一步都可以跑在不同的地方。"),
    ("Per stage", "按阶段"),
    ("Images and scanned PDF pages become searchable Markdown.", "图片与扫描版 PDF 页转成可检索的 Markdown。"),
    ("Vision", "视觉"),
    ("Every chunk becomes a vector for semantic and hybrid recall.", "每个分块变成一个向量，用于语义与混合召回。"),
    ("Names entities, relations and factual claims in changed documents.", "从变动的文档里抽出实体、关系与事实断言。"),
    ("Volume", "量大"),
    ("Turns hot entity clusters into readable, linked Concept pages.", "把热门实体聚类变成可读、带链接的概念页。"),
    ("Quality", "质量"),
    ("Ask, wiki summaries and the nightly Dream analysis.", "问答、wiki 摘要与夜间 Dream 分析。"),
    ("Interactive", "交互"),
    ("Run with", "运行于"),
    ("Runs on", "运行于"),
    ("Optional · use its model", "可选 · 用它自己的模型"),
    ("Pipeline controls", "流水线限额"),
    ("Bound background work without changing the selected models.", "在不改动已选模型的前提下限制后台开销。"),
    ("Daily token budget", "每日 token 预算"),
    ("Documents per pass", "每轮文档数"),
    ("Parallel calls", "并行调用"),
    ("Extract factual claims alongside entities", "抽实体的同时抽事实断言"),
    ("Stage test results", "阶段测试结果"),
    ("Testing each configured stage…", "正在测试每个已配置的阶段…"),
    ("Stage tests complete", "阶段测试完成"),
    ("Models", "模型列表"),
    ("List the models this provider offers", "列出这个提供方可用的模型"),
    ("Ask the provider again", "重新向提供方查询"),
    ("Asking the provider…", "正在向提供方查询…"),
    ("This provider lists no models — type the id you want.", "这个提供方不提供列表 —— 直接输入模型 id。"),

    ("Parallel conversions", "并行转换数"),
    ("Parallel documents", "并行文档数"),
    ("Texts per request", "每次请求的文本数"),
    ("Shared by Extract and Synthesize — the two stages that run in the background.", "抽取与综合共用 —— 这两个阶段在后台跑。"),
    ("One provider at a time — vectors from two models are not comparable. Switching re-embeds the whole corpus when you save.", "同时只有一个生效 —— 两个模型的向量不可比较。切换后保存会重新向量化整个知识库。"),
    ("Not an LLM — it uses one of the embedding providers from section 01. Changing which one, or its model or dimensions, re-embeds the whole corpus.", "不是 LLM —— 它用 01 里的某个向量化提供方。换提供方、换模型或换维度都会重新向量化整个知识库。"),
    ("The busiest stage — it runs on every changed document, bounded by the daily budget and the batch size here. A fast, cheap model that returns clean JSON is usually the right trade.", "最忙的阶段 —— 每个变更过的文档都要过一遍，受每日预算和这里的批量限制。通常选一个快而便宜、能稳定输出 JSON 的模型。"),

    ("Cached — the service last asked at %@.", "来自缓存 —— 服务端最近一次询问是 %@。"),

    // MARK: - Settings · danger zone
    ("Danger zone", "危险操作"),
    ("Clear workspace", "清空工作区"),
    ("Remove all workspace content and derived data, then leave behind a fresh empty directory tree.", "删除工作区的全部内容与派生数据，只留下一个干净的空目录树。"),
    ("Cancel", "取消"),
    ("Clearing workspace…", "正在清空工作区…"),
    ("Workspace cleared. A fresh empty directory tree is ready.", "工作区已清空，干净的空目录树已就绪。"),

    // MARK: - Settings · 03 deep research
    ("03 · Deep research", "03 · 深度研究"),
    ("Who writes the wiki, and how hard they think", "谁来写 wiki，想得有多深"),
    ("An agent researches a topic through the MCP endpoint and writes the page — a coding-agent CLI on this machine, or the built-in agent on an OpenAI-compatible connection. A profile sets the reasoning effort, web access and verification bar, and lists the sub-agents — each with its own agent, model, tools and prompt.", "一个 agent 通过 MCP 端点研究主题并写出页面 —— 可以是本机的编码 agent CLI，也可以是跑在 OpenAI 兼容连接上的内置 agent。profile 决定推理强度、联网范围与核实标准，并列出各个子代理 —— 每个子代理有自己的 agent、模型、工具与提示词。"),
    ("Agents", "智能体"),
    ("Research agent", "研究 agent"),
    ("Which agent runs jobs, how many at once, and which profile it follows. Roles below may override the agent per phase.", "哪个 agent 执行任务、同时跑几个、跟随哪份 profile。下面的角色可以按阶段各自换 agent。"),
    ("Runner", "执行器"),
    ("Agent", "Agent"),
    ("CLI default", "CLI 默认"),
    ("Profile", "Profile"),
    ("Pipeline", "流水线"),
    ("Team · plan, research, synthesize, review, revise", "团队 · 规划、调查、综合、评审、修订"),
    ("Native sub-agents · one session", "原生子代理 · 单会话"),
    ("Single session", "单会话"),
    ("Parallel jobs", "并行任务数"),
    ("Turns per session", "每会话轮数"),
    ("Timeout (minutes)", "超时（分钟）"),
    ("Researchers (default fan-out)", "研究员数（默认并行）"),
    ("Review rounds (default)", "评审轮数（默认）"),
    ("Accept the top recommendations automatically, up to", "自动接受推荐榜前几条，每天最多"),
    ("jobs a day", "个任务"),
    ("Default LLM provider · %@", "默认 LLM 提供方 · %@"),
    ("Not configured — pick an agent", "未配置 —— 请选一个 agent"),
    ("not configured", "未配置"),
    ("built-in agent", "内置 agent"),
    ("web: none (built-in agent)", "联网：无（内置 agent）"),
    ("The built-in agent has no web tool — it verifies against the knowledge base only.", "内置 agent 没有联网工具 —— 只对知识库做核实。"),
    ("The research agent above", "上面选的研究 agent"),
    ("Agent's model", "agent 自己的模型"),
    ("%@ · from PATH", "%@ · 来自 PATH"),
    ("pinned by profile", "由 profile 钉住"),
    ("Pinned by the profile “%@”. Change it in Pipeline override below, or pick a profile that does not pin one.", "被 profile「%@」钉住。可以在下面的「流水线覆盖」里改，或换一个不钉死流水线的 profile。"),
    ("Agent: %@", "Agent：%@"),
    ("pipeline: %@", "流水线：%@"),
    ("effort: %@", "推理强度：%@"),
    ("web: %@ / %@", "联网：%@ / %@"),
    ("sources per fact: %@", "每条事实来源数：%@"),
    ("roles: %@", "角色：%@"),
    ("none", "无"),
    ("Web tools never exceed what review.external allows.", "联网范围永远不会超出 review.external 允许的限度。"),
    ("No research profile loaded. Save the settings once, or check that the service is new enough to serve /api/research/profiles.", "没有载入到研究 profile。先保存一次设置，或确认服务端版本支持 /api/research/profiles。"),

    ("Runs on the default provider (%@).", "跑在默认提供方上（%@）。"),
    ("Runs on %@.", "跑在 %@ 上。"),
    ("no endpoint set", "未设置端点"),
    ("%@ is not on the service PATH — enter its full path.", "服务的 PATH 里找不到 %@ —— 填它的完整路径。"),
    ("Use %@ from PATH instead", "改用 PATH 里的 %@"),

    // MARK: - Settings · 03 agents
    ("03 · Agents", "03 · 智能体"),
    ("04 · Research", "04 · 研究"),
    ("Who does the work", "谁来干活"),
    ("An agent is an executor with a name: a coding-agent CLI on this machine, or an OpenAI-compatible connection running the built-in deep agent. Research and Chat below point at one.", "一个 agent 就是起了名字的执行器：本机的编码 agent CLI，或者跑内置 deep agent 的 OpenAI 兼容连接。下面的研究与对话各指向其中一个。"),
    ("Add agent", "新增 agent"),
    ("Named", "具名"),
    ("General agent", "通用 agent"),
    ("Deep research agent", "深度研究 agent"),
    ("Name this agent", "给这个 agent 起个名字"),
    ("No agents yet", "还没有 agent"),
    ("Add one from a template: a general deep agent for Chat, or a deep-research agent that writes wiki pages.", "从模板加一个：给对话用的通用 deep agent，或者负责写 wiki 页面的深度研究 agent。"),
    ("Add a general agent", "新增一个通用 agent"),
    ("General", "通用"),
    ("Deep research", "深度研究"),
    ("Research", "研究"),
    ("Runs on", "运行于"),
    ("Its own default", "用它自己的默认值"),
    ("Its executor cannot run here — pick another one.", "它的执行器在这台机器上跑不起来 —— 换一个。"),
    ("Reset this template to its built-in", "把这个模板恢复成内置版本"),
    ("Remove this agent", "删除这个 agent"),
    ("0 = the caller's default", "0 = 用调用方的默认值"),
    ("When to pick this agent", "什么时候选这个 agent"),
    ("System prompt", "系统提示词"),
    ("Empty = the research protocol the run workspace already carries. Stored at %@.", "留空 = 用运行工作区自带的研究协议。存放在 %@。"),
    ("New agent", "新 agent"),
    ("New research agent", "新研究 agent"),
    ("Agent %@ created", "已创建 agent %@"),
    ("Could not create the agent: %@", "创建 agent 失败：%@"),
    ("Agent %@ removed", "已删除 agent %@"),
    ("Agent %@ reset to the built-in", "agent %@ 已恢复为内置版本"),
    ("Could not remove the agent: %@", "删除 agent 失败：%@"),
    ("Remove agent %@?", "删除 agent %@？"),
    ("Reset %@ to the built-in template?", "把 %@ 恢复成内置模板？"),
    ("Its file goes back to the template, including the prompt.", "它的文件会回到模板状态，提示词也一并恢复。"),
    ("Anything pointing at it falls back to nothing configured.", "指向它的地方会退回未配置状态。"),
    ("How the wiki gets written", "wiki 是怎么写出来的"),
    ("What initialization does, how Chat behaves, and how a deep-research job runs: which agent from section 03 takes it, how the phases fan out, and the verification bar the profile sets for its sub-agents.", "初始化做什么、对话怎么表现，以及一个深度研究任务怎么跑：由 03 里的哪个 agent 接手、各阶段怎么并行、profile 给子代理设了多高的核实门槛。"),
    ("Deep research pipeline", "深度研究流水线"),

    // MARK: - Settings · profile card
    ("Stored as %@ — edit here or in the file. The profile may pin its own pipeline.", "存放在 %@ —— 在这里改或直接改文件都行。profile 可以钉死自己的流水线。"),
    ("Duplicate…", "另存为…"),
    ("Delete", "删除"),
    ("Reset to built-in", "重置为内置"),
    ("Title", "标题"),
    ("Shown in lists", "列表里显示的名字"),
    ("Description", "说明"),
    ("When to pick this profile", "什么时候用这份 profile"),
    ("Pipeline override", "流水线覆盖"),
    ("Use the runner's pipeline", "跟随执行器的流水线"),
    ("Team", "团队"),
    ("Native sub-agents", "原生子代理"),
    ("Reasoning effort", "推理强度"),
    ("Web access", "联网"),
    ("Follow review.external", "跟随 review.external"),
    ("On for every job", "所有任务都联网"),
    ("Off", "关闭"),
    ("Search freshness", "检索新鲜度"),
    ("Live web search", "实时网页检索"),
    ("Cached search index (codex)", "缓存检索索引（codex）"),
    ("Search rounds per section", "每章节检索轮数"),
    ("Sources per fact", "每条事实来源数"),
    ("Conflicting sources", "来源冲突时"),
    ("Flag both sides as disputed", "两边都标为争议"),
    ("Prefer the primary source", "优先一手来源"),
    ("Prefer the most recent", "优先最新"),
    ("Max sections", "章节上限"),
    ("Prefer primary sources", "优先一手来源"),
    ("Stop a section when a search round adds nothing new", "某轮检索不再带来新事实就结束该章节"),
    ("Cite a source on every fact", "每条事实都要给出来源"),
    ("Mark uncertain claims as suspected", "不确定的断言标记为 suspected"),
    ("Require an evidence table section", "必须包含证据表章节"),
    ("Duplicate profile", "另存为新 profile"),
    ("The copy starts from what is on screen, including unsaved edits. Select it above and save to make it the active profile.", "副本以当前屏幕上的内容为准，包括还没保存的改动。在上面选中它并保存，它才会成为生效的 profile。"),
    ("Letters, digits, - and _, up to 41 characters.", "字母、数字、- 和 _，最长 41 个字符。"),
    ("Create", "创建"),
    ("Discard unsaved changes to %@?", "放弃对 %@ 的未保存改动吗？"),
    ("this profile", "当前 profile"),
    ("Discard and switch", "放弃并切换"),
    ("Keep editing", "继续编辑"),
    ("Reset %@ to the built-in defaults?", "把 %@ 重置为内置默认值吗？"),
    ("Delete profile %@?", "删除 profile %@ 吗？"),
    ("Reset", "重置"),
    ("Its file goes back to the built-in profile, including every role prompt.", "它的文件会恢复成内置 profile，包括每个角色的提示词。"),
    ("The profile file and the roles defined in it are removed.", "这份 profile 文件以及其中定义的角色会被删除。"),
    ("Profile %@ created — save to make it the active profile", "已创建 profile %@ —— 保存后它才会生效"),
    ("Duplicate failed: %@", "另存失败：%@"),
    ("Profile %@ reset to the built-in", "profile %@ 已重置为内置版本"),
    ("Profile %@ deleted", "profile %@ 已删除"),
    ("Research profile %@ could not be loaded: %@", "研究 profile %@ 载入失败：%@"),
    ("Delete failed: %@", "删除失败：%@"),
    ("Reset failed: %@", "重置失败：%@"),

    // MARK: - Settings · sub-agents
    ("Sub-agents", "子代理"),
    ("One card per role. Each has its own CLI, model, effort, tools and prompt; turn a role off to skip its phase. Several roles may share a phase — review roles all run, research roles split the sections.", "每个角色一张卡。每个角色有自己的 CLI、模型、推理强度、工具与提示词；关掉一个角色就跳过它那个阶段。多个角色可以共用一个阶段 —— 评审角色全部运行，研究角色分摊章节。"),
    ("Add role", "新增角色"),
    ("No roles. The team pipeline needs at least a synthesize role; single-session mode ignores roles.", "还没有角色。团队流水线至少需要一个综合角色；单会话模式不看角色。"),
    ("On", "启用"),
    ("Role title", "角色标题"),
    ("Remove this role", "删除这个角色"),
    ("Phase", "阶段"),
    ("Plan · outline the page", "规划 · 定页面提纲"),
    ("Research · one section", "调查 · 负责一个章节"),
    ("Synthesize · write the page", "综合 · 写出页面"),
    ("Review · critique", "评审 · 提意见"),
    ("Revise · fix issues", "修订 · 改问题"),
    ("Effort", "推理强度"),
    ("Profile default", "跟随 profile"),
    ("CLI default effort", "CLI 默认"),
    ("Low", "低"),
    ("Medium", "中"),
    ("High", "高"),
    ("Extra high", "很高"),
    ("Max (claude & codex; cursor → high)", "最高（claude 与 codex；cursor → high）"),
    ("Web tools", "联网工具"),
    ("Profile setting", "跟随 profile"),
    ("On (within review.external)", "开启（不超出 review.external）"),
    ("Parallel sessions", "并行会话数"),
    ("Rounds", "轮数"),
    ("One line the orchestrator reads when picking this sub-agent", "编排者挑选子代理时读到的一句话"),
    ("Writes pages (knode_write / knode_commit)", "可以写页面（knode_write / knode_commit）"),
    ("Reads files (Read / Grep / Glob)", "可以读文件（Read / Grep / Glob）"),
    ("Native sub-agent (pipeline: native)", "注册为原生子代理（流水线：native）"),
    ("Prompt", "提示词"),
    ("built-in", "内置"),
    ("native", "原生"),
    ("The prompt stays in the language it is written in — it is what the agent actually receives.", "提示词保持它本来的语言 —— 这就是 agent 实际收到的内容。"),
    ("off", "已关闭"),

    // MARK: - Settings · status
    ("Saving routes… re-embedding if retrieval changed.", "正在保存路由… 如果检索配置变了会重新嵌入。"),
    ("Configuration saved · re-embedded %@ docs and %@ chunks", "配置已保存 · 重新嵌入 %@ 份文档、%@ 个分块"),
    ("Configuration saved · refreshed document conversion for %@ docs", "配置已保存 · 重新转换了 %@ 份文档"),
    ("Configuration saved and stages applied", "配置已保存，各阶段已生效"),
    (" · research profile %@ saved", " · 研究 profile %@ 已保存"),
    (" · research profile not saved: %@", " · 研究 profile 未保存：%@"),
    ("Test failed: %@", "测试失败：%@"),
    ("Save failed: %@", "保存失败：%@"),
    ("Clear failed: %@", "清空失败：%@"),
    ("Configuration saved for %@", "已为 %@ 保存配置"),

    // MARK: - Swept views
    ("WORKSPACES", "工作区"),
    ("New context", "新建上下文"),
    ("Workspace", "工作区"),
    ("Workspace folder", "工作区文件夹"),
    ("Workspace file", "工作区文件"),
    ("Default workspace", "默认工作区"),
    ("Open workspace", "打开工作区"),
    ("Choose a workspace", "选择工作区"),
    ("Create workspace", "创建工作区"),
    ("Create a workspace", "创建一个工作区"),
    ("Each workspace has its own complete directory tree, index, graph, and model settings.", "每个工作区都有自己完整的目录树、索引、图谱与模型设置。"),
    ("Where do you want to start?", "从哪里开始？"),
    ("Move between private and shared context.", "在私人与共享上下文之间切换。"),
    ("Personal knowledge stays private. Join a Team to work from shared context.", "个人知识保持私密。加入 Team 才会共用上下文。"),
    ("Keep private research in your personal space, then bring the right knowledge into a shared Team when collaboration starts.", "研究先放在个人空间，等需要协作时再把该共享的知识带进 Team。"),
    ("Shared context", "共享上下文"),
    ("Private files, traces, and agent memory", "私有文件、轨迹与 agent 记忆"),
    ("Join a Team", "加入 Team"),
    ("Join Team", "加入 Team"),
    ("OR JOIN A TEAM", "或加入一个 TEAM"),
    ("Invite link or Team code", "邀请链接或 Team 代码"),
    ("Enter an invite code to create or open an isolated Team workspace.", "输入邀请码，创建或打开一个独立的 Team 工作区。"),
    ("e.g. Product research", "例如：产品调研"),
    ("e.g. KNODE-LABS", "例如：KNODE-LABS"),
    ("Ready for teams", "支持团队"),
    ("Sign in to knode-os", "登录 knode-os"),
    ("Welcome back", "欢迎回来"),
    ("Username", "用户名"),
    ("Password", "密码"),
    ("Confirm password", "确认密码"),
    ("Enter your password", "输入密码"),
    ("Keep me signed in", "保持登录"),
    ("Continue", "继续"),
    ("Create account", "创建账号"),
    ("Create an account", "创建一个账号"),
    ("Create a local account", "创建本地账号"),
    ("Back to sign in", "返回登录"),
    ("New here?", "第一次用？"),
    ("Local account", "本地账号"),
    ("Local by default", "默认本地"),
    ("Built for agents", "为 agent 而生"),
    ("Credentials stay on this Mac. The server still listens only on localhost.", "凭据只存在这台 Mac 上，服务也只监听 localhost。"),
    ("Mock accounts: admin / admin or test / test", "演示账号：admin / admin 或 test / test"),
    ("admin or test", "admin 或 test"),
    ("Continue to your personal knowledge workspace and Teams.", "进入你的个人知识工作区与 Team。"),
    ("Build a memory that works the way you do.", "打造一份贴合你工作方式的记忆。"),
    ("Your knowledge, in context", "你的知识，随上下文而来"),
    ("Your files remain the source of truth.", "文件始终是唯一的事实来源。"),
    ("Search, graph, and recall stay connected.", "检索、图谱与召回彼此相连。"),
    ("Knode service", "Knode 服务"),
    ("Connect", "连接"),
    ("Checking…", "检查中…"),
    ("Connect to the local service or initialize a workspace.", "连接本地服务，或初始化一个工作区。"),
    ("The app starts its bundled local service automatically. Enter another URL only when connecting to an externally managed service.", "应用会自动启动内置的本地服务。只有连接外部托管的服务时才需要改这个地址。"),
    ("Browse the workspace tree, or drag documents and folders onto it to upload and index them.", "浏览工作区目录树，或把文档、文件夹拖进来上传并索引。"),
    ("No files", "还没有文件"),
    ("Select a file", "选择一个文件"),
    ("Select this file", "选中这个文件"),
    ("Go to Files", "前往文件"),
    ("Open", "打开"),
    ("Save", "保存"),
    ("Rename", "重命名"),
    ("Rename…", "重命名…"),
    ("Rename folder…", "重命名文件夹…"),
    ("Delete…", "删除…"),
    ("Delete folder…", "删除文件夹…"),
    ("Copy path", "复制路径"),
    ("Move to…", "移动到…"),
    ("Move folder to…", "移动文件夹到…"),
    ("New file here…", "在这里新建文件…"),
    ("New folder here…", "在这里新建文件夹…"),
    ("Upload files here…", "上传文件到这里…"),
    ("Upload folder here…", "上传文件夹到这里…"),
    ("Create a new note", "新建笔记"),
    ("Create a new folder", "新建文件夹"),
    ("Existing folders", "已有文件夹"),
    ("New items →", "新内容 →"),
    ("Click a folder in the tree to send new files, new folders and uploads there", "在目录树里点一个文件夹，新建与上传都会落到那里"),
    ("Clear the picked folder — new items follow the open file again", "清除选定文件夹 —— 新内容重新跟随当前打开的文件"),
    ("Select — tick several files to move or delete them in one go", "多选 —— 勾上多个文件，一次移动或删除"),
    ("Move every selected file into another folder", "把选中的文件全部移动到另一个文件夹"),
    ("Delete every selected file", "删除所有选中的文件"),
    ("This removes the selected files from the current workspace. The knowledge extracted from them is disposed; history stays queryable.", "这会把选中的文件从当前工作区移除。它们抽取出的知识会被回收，历史仍可查询。"),
    ("Refresh — reread the workspace tree from disk", "刷新 —— 重新从磁盘读取工作区目录树"),
    ("Index — turn new and changed files into knowledge: chunk, embed, extract entities and refresh the wiki. The CLI calls this `ingest` / `sync`.", "索引 —— 把新增与变更的文件变成知识：分块、嵌入、抽实体并刷新 wiki。CLI 里叫 `ingest` / `sync`。"),
    ("Load full file", "载入完整文件"),
    ("read-only", "只读"),
    ("Size", "大小"),
    ("Source", "来源"),
    ("Metadata", "元数据"),
    ("Project", "项目"),
    ("Writable paths must live under wiki/ or raw/docs/.", "可写路径必须在 wiki/ 或 raw/docs/ 之下。"),
    ("Writable paths must live under wiki/ or raw/docs/. Intermediate folders are created too.", "可写路径必须在 wiki/ 或 raw/docs/ 之下，中间目录会自动创建。"),
    ("Search the knowledge base…", "检索知识库…"),
    ("Recall anything", "召回一切"),
    ("Search across documents, skills, and the generated wiki. Hybrid mode combines semantic, keyword, graph, and usage signals.", "在文档、技能与生成的 wiki 中检索。混合模式会综合语义、关键词、图谱与使用热度。"),
    ("Mode", "模式"),
    ("No matching knowledge", "没有匹配的知识"),
    ("Try broader terms, another retrieval mode, or index more documents.", "换更宽的说法、换一种召回模式，或者再索引一些文档。"),
    ("Choose a result", "选择一条结果"),
    ("Inspect its retrieval signals and open the source file.", "查看它的召回信号并打开源文件。"),
    ("Relevance", "相关度"),
    ("Ask your knowledge base", "向知识库提问"),
    ("Ask a question — answered from your workspace with citations…", "提一个问题 —— 用工作区内容作答并给出引用…"),
    ("Answers are grounded in retrieved chunks and extracted claims. Citations link straight back to the source files.", "回答基于召回的分块与抽取出的断言，引用直接链回源文件。"),
    ("Searching context, following the graph, and composing a cited answer…", "正在检索上下文、沿图谱展开，并组织带引用的回答…"),
    ("No answer returned", "没有返回回答"),
    ("Check the local service and your default reasoning model route.", "检查本地服务与默认推理模型路由。"),
    ("Grounded in", "依据"),
    ("Graph search — entity, product, concept…", "图谱检索 —— 实体、产品、概念…"),
    ("Depth", "深度"),
    ("1 hop", "1 跳"),
    ("2 hops", "2 跳"),
    ("3 hops", "3 跳"),
    ("Explore", "展开"),
    ("The graph is empty", "图谱是空的"),
    ("Index documents with wikilinks or configure entity extraction to create nodes and relations.", "索引带 wikilink 的文档，或配置实体抽取，才会产生节点与关系。"),
    ("Knowledge graph insights", "知识图谱洞察"),
    ("Graph health", "图谱健康度"),
    ("Entities", "实体"),
    ("Relations", "关系"),
    ("Entity types", "实体类型"),
    ("Hubs", "枢纽"),
    ("Isolated entities", "孤立实体"),
    ("Mentions", "提及"),
    ("entities", "实体"),
    ("rels", "关系"),
    ("docs", "文档"),
    ("chunks", "分块"),
    ("Mirrored into raw/traces/ — click a row to open one. They feed the nightly dream; turn on trace.episodes in Settings → Pipeline to make them searchable too.", "镜像在 raw/traces/ —— 点一行即可打开。它们供夜间分析使用；在「设置 → 流水线」里打开 trace.episodes 后还能进入检索。"),
    ("Open %@", "打开 %@"),
    ("Filter traces", "筛选轨迹"),
    ("Session", "会话"),
    ("Started", "开始于"),
    ("Kind", "类型"),
    ("Recent traces → suggestions for skills, memory, and knowledge", "近期轨迹 → 技能、记忆与知识的改进建议"),
    ("Dream analyzes recent agent sessions and proposes grounded improvements to skills, memory, and knowledge.", "夜间分析会回顾近期 agent 会话，给出有依据的技能、记忆与知识改进建议。"),
    ("Analyzed", "已分析"),
    ("Accepted", "已采纳"),
    ("Rejected", "已拒绝"),
    ("Pending", "待处理"),
    ("Dismiss", "忽略"),
    ("Done", "完成"),
    ("All", "全部"),
    ("Status", "状态"),
    ("Queue", "排队"),
    ("Promote", "提升"),
    ("Demote", "降级"),
    ("Refresh", "刷新"),
    ("Reload jobs, pages and recommendations", "重新载入任务、页面与推荐"),
    ("No research jobs yet. Queue one above or accept a recommendation.", "还没有研究任务。在上面排一个，或采纳一条推荐。"),
    ("No research pages yet.", "还没有研究页面。"),
    ("Nothing to recommend yet — recommendations come from hot entities, repeated questions and pages whose facts changed.", "暂时没有推荐 —— 推荐来自热门实体、反复出现的问题，以及事实发生变化的页面。"),
    ("entity / concept name, “A vs B”, a question, or wiki/… path", "实体 / 概念名、“A vs B”、一个问题，或 wiki/… 路径"),
    ("1 · Convert", "1 · 转换"),
    ("2 · Index", "2 · 索引"),
    ("3 · Extract", "3 · 抽取"),
    ("4 · Synthesize", "4 · 综合"),
    ("5 · Answer", "5 · 回答"),
    ("Other connections", "其他连接"),
    ("Add one when a stage needs a different endpoint — a vision-capable API, a cheaper model, a second key.", "当某个阶段需要不同的端点时再加 —— 支持视觉的 API、更便宜的模型、第二把密钥。"),
    ("The model has to see pixels: an API provider gets the image inline, codex takes --image, and claude and cursor read the file with their own tools. A text-only model fails here. Changing this re-converts every image and scanned page.", "这一步模型必须真的看到像素：API 提供方直接收到图片，codex 用 --image，claude 与 cursor 用自己的工具读文件。纯文本模型在这里会失败。改动它会重新转换所有图片与扫描页。"),
    ("Not an LLM — it uses the embedding provider from section 01, one per workspace. Changing its model or dimensions re-embeds the whole corpus.", "这一步不是 LLM —— 它用 01 里的向量化提供方，每个工作区一个。改模型或维度会重嵌整个语料。"),
    ("The busiest stage — it runs on every changed document, bounded by the daily budget and batch size below. A fast, cheap model that returns clean JSON is usually the right trade.", "最繁忙的一步 —— 每份变动的文档都要跑，受下面的日预算与批大小限制。通常选又快又便宜、能吐干净 JSON 的模型最划算。"),
    ("Far fewer calls than Extract — only hot clusters reach it — and the output is prose people read, so a stronger model pays for itself here.", "调用次数远少于抽取 —— 只有热门聚类才走到这里 —— 而且产出是给人读的文字，用更强的模型是值得的。"),
    ("Always the default provider. Latency lands straight in the Ask box, so prefer something responsive.", "固定用默认提供方。延迟会直接体现在问答框里，选响应快的。"),
    ("Set in section 01 · Embedding provider", "在 01 · 向量化提供方里设置"),
    ("Set in section 01 · Default LLM provider", "在 01 · 默认 LLM 提供方里设置"),
    ("API model not set", "未设置 API 模型"),
    ("Local hashing · %@d", "本地哈希 · %@ 维"),
    ("Budget", "预算"),
    ("Batch", "批大小"),
    ("Concurrency", "并发"),
    ("CLI executable", "CLI 可执行文件"),
    ("Use command from PATH", "使用 PATH 里的命令"),
    ("Pin a path…", "指定路径…"),
    ("Clear", "清除"),
    ("Runs %@ from PATH — nothing to fill in", "从 PATH 运行 %@ —— 不需要填"),
    ("Picking one fills the field — Save & apply writes it to the workspace config.", "选中即填入 —— 保存并应用后写进工作区配置。"),
    ("Nothing matches “%@”.", "没有匹配“%@”的项。"),
    ("from the endpoint", "来自端点"),
    ("from the CLI", "来自 CLI"),
    ("Settings are still loading", "设置还在载入"),
    ("this workspace", "这个工作区"),
    ("Clear %@", "清空 %@"),
    ("Clear %@?", "清空 %@ 吗？"),
    ("Configure each provider once for %@, then point every pipeline stage at one of them. Test stages sends one real request per configured stage before you save.", "为 %@ 把每个提供方配置一次，然后让流水线的每个阶段指向其中之一。「测试各阶段」会在保存前对每个已配置的阶段各发一次真实请求。"),
    ("The local hashing embedder is private, offline, and ready immediately.", "本地哈希向量化完全离线私密，开箱即用。"),
    ("Changing the API model or dimensions re-embeds the corpus after saving. Use env:VAR_NAME to keep keys out of the config file.", "改 API 模型或维度会在保存后重嵌整个语料。用 env:VAR_NAME 可以把密钥留在配置文件之外。"),
    ("Ark posts to /embeddings/multimodal and returns one vector per request, so Base URL ends at /api/v3 and Model is the endpoint id (ep-…). Dimensions must match the model — doubao-embedding-vision is 2048, or 1024 when the dimensions parameter is sent.", "方舟走 /embeddings/multimodal，每次请求返回一个向量，所以接口地址写到 /api/v3 为止，模型填 endpoint id（ep-…）。维度必须与模型一致 —— doubao-embedding-vision 是 2048，带 dimensions 参数时是 1024。"),
    ("Any OpenAI-compatible chat endpoint works (OpenAI, DeepSeek, Ollama, vLLM, SiliconFlow…). Use env:VAR_NAME to keep the key out of the config file. An empty model disables LLM features; the deterministic pipeline keeps running.", "任何 OpenAI 兼容的对话端点都可以（OpenAI、DeepSeek、Ollama、vLLM、SiliconFlow…）。用 env:VAR_NAME 把密钥留在配置文件之外。模型留空会关掉 LLM 功能，确定性流水线照常运行。"),
    ("Uses your existing Codex login for a read-only one-shot request.", "复用你已有的 Codex 登录，发一次只读请求。"),
    ("Uses your existing Claude Code login for one non-interactive turn.", "复用你已有的 Claude Code 登录，跑一轮非交互会话。"),
    ("Uses your existing Cursor Agent login in headless print mode.", "复用你已有的 Cursor Agent 登录，以无界面打印模式运行。"),
    ("This permanently deletes every file, index, graph, trace, suggestion, and model setting in the workspace. The empty workspace itself remains available.", "这会永久删除工作区里的所有文件、索引、图谱、轨迹、建议与模型设置。空的工作区本身仍然保留。"),
    ("Interface language — prompts and pages keep the language they are written in", "界面语言 —— 提示词与生成的页面保持它们本来的语言"),

    // MARK: - Counts and paths
    ("Add — a new file or folder, or documents uploaded from disk, into %@/", "新增 —— 在 %@/ 下新建文件或文件夹，或从磁盘上传文档"),
    ("Add a file or folder", "新增文件或文件夹"),
    ("%@ selected", "已选 %@ 项"),
    ("Lands in %@", "会落在 %@"),
    ("the workspace root", "工作区根目录"),
    ("Only wiki/ and raw/docs/ take new %@ — edit the path above", "只有 wiki/ 和 raw/docs/ 能放新的%@ —— 请改上面的路径"),
    ("Creates %@/", "将创建 %@/"),
    ("Select 1 file here", "选中这里的 1 个文件"),
    ("Select %@ files here", "选中这里的 %@ 个文件"),
    ("%@ mentions", "%@ 次提及"),
    ("%@ nodes · %@ relations", "%@ 个节点 · %@ 条关系"),
    ("degree %@", "度数 %@"),
    ("%@ sessions", "%@ 个会话"),
    ("%@ turns", "%@ 轮"),
    ("Evidence · %@", "证据 · %@"),

    // MARK: - Sub-agent guidance
    ("Judgment", "判断"),
    ("One short session: it reads the brief, scouts the index and returns a JSON outline — no prose. A mid-tier model is enough, as long as it returns valid JSON; effort buys a better split into sections, not better writing.", "一次短会话：读简报、摸底索引，返回 JSON 提纲，不写正文。中档模型就够，关键是能稳定吐出合法 JSON；提高强度换来的是更合理的章节切分，不是更好的文笔。"),
    ("One session per section, all at once — this is where most of the tokens go. A fast, cheap model is the right trade; raise effort only for sections that need real reasoning rather than retrieval.", "每个章节一个会话、同时开跑 —— 绝大部分 token 花在这里。用又快又便宜的模型最划算；只有当某些章节真要推理而不只是检索时，才值得调高强度。"),
    ("One session turns everyone's findings into the page people will actually read, and it is the only role that writes. Use the strongest model you have, at high effort — this is the output.", "一次会话把所有人的发现写成真正给人读的页面，也是唯一会写页面的角色。用你手上最强的模型、high 强度 —— 这就是最终产出。"),
    ("Reads the finished page against the contract, spot-checks sources and returns a JSON verdict. A strong model at high effort catches more, and the session is short, so it stays cheap.", "对照契约通读成稿、抽查来源，返回 JSON 判定。强模型 + high 强度能挑出更多问题，而且会话很短，花不了多少钱。"),
    ("Applies the review's notes to a page that already exists. Same class of model as the writer, but it edits rather than composes, so medium effort is usually enough.", "把评审意见落到已经写好的页面上。模型档次跟主笔一致，但它是改而不是写，medium 强度通常就够。"),
    ("Scrutiny", "挑刺"),
    ("Precision", "精修"),
    ("Custom", "自定义"),
    ("A role of your own. Match the model and effort to what its prompt asks for — cheap and fast for gathering, strong and careful for writing or judging.", "你自己加的角色。按它提示词要做的事挑模型与强度 —— 取证用便宜快的，写作或评判用强而稳的。"),
    ("recommended", "推荐"),
    ("Runs on %@, like every other role.", "和其他角色一样跑在 %@ 上。"),
    ("Pinned to %@ instead of the research agent.", "被固定在 %@，没有跟随研究 agent。"),
    ("Use the research agent", "改回研究 agent"),
    ("the research agent", "研究 agent"),

    // MARK: - Fan-out and delegation
    ("research · %@ at a time", "research · 最多 %@ 并行"),
    ("%@ · %@ rounds", "%@ · %@ 轮"),
    ("Offer to the orchestrator as a native sub-agent", "作为原生子代理交给主管调用"),
    ("The orchestrator writes the page itself, so this phase is never delegated.", "页面由主管会话自己写，这个阶段不会被委派出去。"),
    ("With pipeline = native, one session writes the page and calls this role through the CLI's own sub-agents (claude --agents, codex agents.<id>) instead of knode starting a session for it. Sub-agents never write pages.", "流水线为 native 时，由一个会话写页面，并通过 CLI 自己的子代理机制（claude --agents、codex agents.<id>）调用这个角色，而不是由 knode 单独起一个会话。子代理永远不能写页面。"),
    ("The pipeline is %@ right now, so this switch changes nothing.", "当前流水线是 %@，所以这个开关暂时不起作用。"),
    ("How many sections are researched at the same time. One session per section either way — the outline decides how many there are; 0 follows the runner.", "同时调查几个章节。无论如何都是一个章节一个会话 —— 会话总数由提纲的章节数决定；填 0 表示跟随执行器的设置。"),

    // MARK: - Knowledge-base initialization
    ("Knowledge base", "知识库"),
    ("Initialize knowledge base", "初始化知识库"),
    ("Re-initialize knowledge base", "重新初始化知识库"),
    ("Initialize", "初始化"),
    ("Re-initialize", "重新初始化"),
    ("The research agent surveys everything (indexing and extracting first), writes wiki/overview.md and the AGENTS.md / CLAUDE.md guide every later agent reads, and queues the topic pages worth writing next.", "研究 agent 先索引与抽取，再通读整个知识库，写出 wiki/overview.md 总览和给后来 agent 看的 AGENTS.md / CLAUDE.md 指南，并把值得单独成页的主题排进队列。"),
    ("relations", "关系"),
    ("claims", "断言"),
    ("awaiting extraction", "待抽取"),
    ("guide %@", "指南 %@"),
    ("no guide yet", "尚未生成指南"),
    ("agent", "agent"),
    ("follow-up pages", "后续页面"),
    ("Index the files", "索引文件"),
    ("Extract entities & claims", "抽取实体与断言"),
    ("Regenerate stub pages", "重建生成页"),
    ("Survey the base", "通读知识库"),
    ("Initialization queued", "初始化已排队"),
    ("Initializing the knowledge base…", "正在初始化知识库…"),
    ("Knowledge base initialized", "知识库初始化完成"),
    ("Initialization %@", "初始化%@"),
    ("Could not start: %@", "无法开始：%@"),
    ("Initialization", "初始化"),
    ("What the Wiki tab's initialize button does before the agent starts, and how many topic pages it queues afterwards.", "Wiki 页的初始化按钮在 agent 开跑前做什么，以及之后排队多少个主题页。"),
    ("Init", "初始化"),
    ("Extraction first", "先做抽取"),
    ("Drain the tier-1 queue (within the daily budget)", "清空 tier-1 队列（在每日预算内）"),
    ("Skip — leave it to the background loop", "跳过 —— 交给后台循环"),
    ("Extraction time cap (minutes)", "抽取时间上限（分钟）"),
    ("Follow-up pages queued", "排队的后续页面数"),

    // MARK: - Ask (quick retrieval answers + the agent mode that was Chat)
    ("Quick", "快速"),
    ("Ask · Agent mode", "问答 · Agent 模式"),
    ("Ask's Agent mode uses the same agent research does: it answers over MCP, and writes what you teach it as a quarantined note. Quick mode needs none of this — it answers from retrieval.", "问答的 Agent 模式用的是和深度研究同一个 agent：它通过 MCP 作答，并把你教它的内容写成隔离状态的笔记。快速模式不需要这些 —— 它直接从检索作答。"),
    ("Quick answers in one retrieval pass. Agent runs the configured CLI, which can take minutes.", "快速模式一次检索就给出答案；Agent 模式会跑配置好的 CLI，可能要几分钟。"),
    ("New question", "新建提问"),
    ("Nothing asked yet.", "还没有提问。"),
    ("Delete this conversation", "删除这个对话"),
    ("(untitled)", "（未命名）"),
    ("(empty reply)", "（没有回复）"),
    ("Quick answers are grounded in retrieved chunks and extracted claims, with citations back to the source files. Agent mode can dig further, and writes what you teach it as a quarantined note you can adopt.", "快速回答基于检索到的片段与抽取出的断言，引用直接链回源文件。Agent 模式可以继续深挖，并把你教它的内容写成隔离状态的笔记，确认后再采纳。"),
    ("Citations", "引用"),
    ("Known facts", "已知事实"),
    ("Knowledge gaps", "知识缺口"),
    ("Dig deeper with the agent", "交给 agent 深入"),
    ("Ask a question, or “remember: …” to teach the knowledge base", "提问，或者用“记住：…”把新知识教给知识库"),
    ("Answering…", "正在回答…"),
    ("The agent is answering…", "agent 正在回答…"),
    ("Send", "发送"),
    ("Stopping…", "正在停止…"),
    ("Adopt", "采纳"),
    ("Promote this note from quarantined to trusted", "把这篇笔记从隔离状态提升为可信"),
    ("%@ is trusted now", "%@ 已标为可信"),
    ("Adopt failed: %@", "采纳失败：%@"),
    ("Could not start a conversation: %@", "无法新建对话：%@"),
    ("Send failed: %@", "发送失败：%@"),
    ("Turns per reply", "每次回复的轮数上限"),
    ("Messages replayed", "回放的历史消息数"),
    ("Conversations kept", "保留的对话数"),
    ("Every reply is a fresh session that replays the recent messages — there is no CLI session to resume, so a long conversation costs more input each turn.", "每次回复都是一个新会话，把最近几条消息重放进去 —— 没有可续接的 CLI 会话，所以对话越长，每轮的输入成本越高。"),
]
