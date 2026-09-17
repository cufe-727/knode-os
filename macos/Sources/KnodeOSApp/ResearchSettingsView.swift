import SwiftUI

/// Settings · 03 · Deep research. The runner card says which coding-agent CLI
/// writes wiki pages, how many jobs run at once and which profile they follow;
/// the profile below it sets how hard they think, what they may read from the
/// web and the bar a page has to clear, and the sub-agents that do the work sit
/// behind one tab each — with its own CLI, model, tools and prompt.
///
/// A profile is a file (`playbooks/research/profiles/<name>.yaml`), so what is
/// edited here can equally be edited by hand; the role prompts travel with it
/// and stay in the language they are written in, because that text is what the
/// agent actually receives.
struct ResearchSettingsSection: View {
    @Binding var research: ResearchConfig
    @Binding var profile: ResearchProfileDetail?
    @Binding var dirty: Bool
    /// Selecting another profile reloads its file, so it goes through the
    /// parent rather than straight into `research.profile`.
    @Binding var profileSelection: String
    let summaries: [ResearchProfileSummary]
    let connections: [LLMConnection]
    let defaultProvider: String
    let isWorking: Bool
    /// Models the CLI behind an agent key offers ("" = the default provider).
    let loadModels: (String) async throws -> ModelListResponse
    let duplicate: () -> Void
    let remove: () -> Void

    @State private var selectedRoleID: String?

    /// The providers that can run a research job: a job is a CLI session, not
    /// a chat completion, so an OpenAI-compatible endpoint cannot take one.
    static let cliProviders = ["claude-cli", "codex-cli", "cursor-cli"]

    /// value → English label; the label goes through `L` at render time.
    static let efforts: [(String, String)] = [
        ("default", "CLI default"),
        ("low", "Low"),
        ("medium", "Medium"),
        ("high", "High"),
        ("xhigh", "Extra high"),
        ("max", "Max (claude; codex → xhigh, cursor → high)"),
    ]

    static let phases: [(String, String)] = [
        ("plan", "Plan · outline the page"),
        ("research", "Research · one section"),
        ("synthesize", "Synthesize · write the page"),
        ("review", "Review · critique"),
        ("revise", "Revise · fix issues"),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            runnerCard
            if profile != nil {
                profileCard
                rolesEditor
            } else {
                Text(L("No research profile loaded. Save the settings once, or check that the service is new enough to serve /api/research/profiles."))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .knodeCard()
            }
        }
    }

    private var header: some View {
        HStack(alignment: .bottom) {
            VStack(alignment: .leading, spacing: 3) {
                Eyebrow(text: L("03 · Deep research"), color: .knodeViolet)
                Text(L("Who writes the wiki, and how hard they think")).font(.title3.bold())
                Text(L("A coding-agent CLI researches a topic through the MCP endpoint and writes the page. A profile sets the reasoning effort, web access and verification bar, and lists the sub-agents — each with its own CLI, model, tools and prompt."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 12)
            RouteBadge(label: L("Agents"), color: .knodeViolet)
        }
    }

    // MARK: - Runner

    private var runnerCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(L("Research agent")).font(.headline)
                    Text(L("Which CLI runs jobs, how many at once, and which profile it follows. Roles below may override the CLI per phase."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 12)
                RouteBadge(label: L("Runner"), color: .knodeCyan)
            }
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 12) {
                GridRow {
                    FieldLabel(L("Agent")) {
                        AgentPicker(selection: $research.agent, connections: connections, inheritLabel: inheritLabel)
                    }
                    ModelField(
                        placeholder: L("CLI default"),
                        text: $research.model,
                        providerKey: research.agent,
                        load: { try await loadModels(research.agent) }
                    )
                    FieldLabel(L("Profile")) {
                        Picker(L("Profile"), selection: $profileSelection) {
                            ForEach(summaries) { summary in
                                Text(profileLabel(summary)).tag(summary.name)
                            }
                        }
                        .labelsHidden()
                        .help(BuiltinNames.profileDescription(
                            summaries.first { $0.name == profileSelection }?.description ?? ""
                        ))
                    }
                }
                GridRow {
                    FieldLabel(L("Pipeline")) {
                        VStack(alignment: .leading, spacing: 4) {
                            Picker(L("Pipeline"), selection: pipelineSelection) {
                                Text(L("Team · plan, research, synthesize, review, revise")).tag("team")
                                Text(L("Native sub-agents · one session")).tag("native")
                                Text(L("Single session")).tag("single")
                            }
                            .labelsHidden()
                            .disabled(!pinnedPipeline.isEmpty)
                            if !pinnedPipeline.isEmpty {
                                Text(L("Pinned by the profile “%@”. Change it in Pipeline override below, or pick a profile that does not pin one.", profileSelection))
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                    FieldLabel(L("Parallel jobs")) {
                        TextField("1", value: $research.concurrency, format: .number)
                    }
                    FieldLabel(L("Turns per session")) {
                        TextField("40", value: $research.maxTurns, format: .number)
                    }
                }
                GridRow {
                    FieldLabel(L("Timeout (minutes)")) {
                        TextField("20", value: timeoutMinutes, format: .number)
                    }
                    FieldLabel(L("Researchers (default fan-out)")) {
                        TextField("3", value: $research.researchers, format: .number)
                    }
                    FieldLabel(L("Review rounds (default)")) {
                        TextField("1", value: $research.reviewRounds, format: .number)
                    }
                }
            }
            HStack(spacing: 8) {
                Toggle(L("Accept the top recommendations automatically, up to"), isOn: $research.auto.enabled)
                    .toggleStyle(.checkbox)
                TextField("3", value: $research.auto.dailyJobs, format: .number)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 64)
                    .disabled(!research.auto.enabled)
                Text(L("jobs a day")).font(.callout).foregroundStyle(.secondary)
            }
            Text(note)
                .font(.caption)
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .knodeCard(padding: 18)
    }

    /// The runner falls back to the default LLM provider, which only works when
    /// that provider is itself a CLI — say so rather than failing at run time.
    private var inheritLabel: String {
        Self.cliProviders.contains(defaultProvider)
            ? L("Default LLM provider · %@", providerName(defaultProvider))
            : L("Default LLM provider (not a CLI — pick one)")
    }

    private func profileLabel(_ summary: ResearchProfileSummary) -> String {
        let title = BuiltinNames.profileTitle(summary.title)
        return title == summary.name ? summary.name : "\(summary.name) · \(title)"
    }

    private var timeoutMinutes: Binding<Int> {
        Binding(
            get: { max(1, research.timeoutMs / 60_000) },
            set: { research.timeoutMs = max(1, $0) * 60_000 }
        )
    }

    /// A profile may pin the pipeline; when it does, the runner's own setting
    /// has no effect, so the picker shows what will actually run and locks.
    private var pinnedPipeline: String { profile?.pipeline ?? "" }

    private var pipelineSelection: Binding<String> {
        Binding(
            get: { pinnedPipeline.isEmpty ? research.pipeline : pinnedPipeline },
            set: { if pinnedPipeline.isEmpty { research.pipeline = $0 } }
        )
    }

    /// What a job will actually do, assembled from the runner and the profile.
    private var note: String {
        let agentLabel = research.agent.isEmpty
            ? inheritLabel
            : (connections.first { $0.id == research.agent }?.label ?? providerName(research.agent))
        let pipeline = pinnedPipeline.isEmpty ? research.pipeline : pinnedPipeline
        var parts = [
            L("Agent: %@", agentLabel),
            L("pipeline: %@", pipeline + (pinnedPipeline.isEmpty ? "" : " (\(L("pinned by profile")))")),
        ]
        if let profile {
            parts.append(L("effort: %@", profile.reasoning.effort))
            parts.append(L("web: %@ / %@", profile.search.web, profile.search.freshness))
            parts.append(L("sources per fact: %@", String(profile.verification.minSourcesPerClaim)))
        }
        if pipeline != "single" {
            let roles = (profile?.roles ?? []).filter(\.enabled).map { role -> String in
                let fanout = role.phase == "research" ? (role.parallel == 0 ? research.researchers : role.parallel) : 0
                return role.id + (fanout > 1 ? " ×\(fanout)" : "") + (role.agent.isEmpty ? "" : " @\(role.agent)")
            }
            parts.append(L("roles: %@", roles.isEmpty ? L("none") : roles.joined(separator: ", ")))
        }
        return parts.joined(separator: " · ") + ". " + L("Web tools never exceed what review.external allows.")
    }

    // MARK: - Profile

    private var profileCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(L("Profile")).font(.headline)
                        Text(profile?.name ?? "")
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                    Text(L("Stored as %@ — edit here or in the file. The profile may pin its own pipeline.",
                           profile?.path.isEmpty == false ? profile!.path : "playbooks/research/profiles/<name>.yaml"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 12)
                Button(L("Duplicate…")) { duplicate() }
                    .disabled(isWorking)
                Button(profile?.builtin == true ? L("Reset to built-in") : L("Delete"), role: .destructive) { remove() }
                    .disabled(isWorking)
            }
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 12) {
                GridRow {
                    FieldLabel(L("Title")) {
                        TextField(L("Shown in lists"), text: bind(\.title))
                    }
                    FieldLabel(L("Description")) {
                        TextField(L("When to pick this profile"), text: bind(\.description))
                    }
                    .gridCellColumns(2)
                }
                GridRow {
                    FieldLabel(L("Pipeline override")) {
                        Picker(L("Pipeline override"), selection: bind(\.pipeline)) {
                            Text(L("Use the runner's pipeline")).tag("")
                            Text(L("Team")).tag("team")
                            Text(L("Native sub-agents")).tag("native")
                            Text(L("Single session")).tag("single")
                        }
                        .labelsHidden()
                    }
                    FieldLabel(L("Reasoning effort")) {
                        Picker(L("Reasoning effort"), selection: bind(\.reasoning.effort)) {
                            ForEach(Self.efforts, id: \.0) { Text(L($0.1)).tag($0.0) }
                        }
                        .labelsHidden()
                    }
                    FieldLabel(L("Web access")) {
                        Picker(L("Web access"), selection: bind(\.search.web)) {
                            Text(L("Follow review.external")).tag("inherit")
                            Text(L("On for every job")).tag("on")
                            Text(L("Off")).tag("off")
                        }
                        .labelsHidden()
                    }
                }
                GridRow {
                    FieldLabel(L("Search freshness")) {
                        Picker(L("Search freshness"), selection: bind(\.search.freshness)) {
                            Text(L("Live web search")).tag("live")
                            Text(L("Cached search index (codex)")).tag("cached")
                        }
                        .labelsHidden()
                    }
                    FieldLabel(L("Search rounds per section")) {
                        TextField("3", value: bind(\.search.maxRounds), format: .number)
                    }
                    FieldLabel(L("Sources per fact")) {
                        TextField("1", value: bind(\.verification.minSourcesPerClaim), format: .number)
                    }
                }
                GridRow {
                    FieldLabel(L("Conflicting sources")) {
                        Picker(L("Conflicting sources"), selection: bind(\.verification.resolveConflicts)) {
                            Text(L("Flag both sides as disputed")).tag("flag")
                            Text(L("Prefer the primary source")).tag("prefer_primary")
                            Text(L("Prefer the most recent")).tag("prefer_recent")
                        }
                        .labelsHidden()
                    }
                    FieldLabel(L("Max sections")) {
                        TextField("8", value: bind(\.stop.maxSections), format: .number)
                    }
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                Toggle(L("Prefer primary sources"), isOn: bind(\.verification.preferPrimarySources))
                Toggle(L("Stop a section when a search round adds nothing new"), isOn: bind(\.stop.marginalGain))
                Toggle(L("Cite a source on every fact"), isOn: bind(\.output.citations))
                Toggle(L("Mark uncertain claims as suspected"), isOn: bind(\.output.uncertainty))
                Toggle(L("Require an evidence table section"), isOn: bind(\.output.evidenceTable))
            }
            .toggleStyle(.checkbox)
        }
        .knodeCard(padding: 18)
    }

    // MARK: - Roles

    private var roles: [ResearchRole] { profile?.roles ?? [] }

    /// The tab that is open, kept valid as roles are added and removed.
    private var selectedIndex: Int {
        if let id = selectedRoleID, let index = roles.firstIndex(where: { $0.id == id }) { return index }
        return roles.isEmpty ? 0 : 0
    }

    private var rolesEditor: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(L("Sub-agents")).font(.headline)
                    Text(L("One card per role. Each has its own CLI, model, effort, tools and prompt; turn a role off to skip its phase. Several roles may share a phase — review roles all run, research roles split the sections."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 12)
                Button(L("Add role")) { addRole() }
            }
            if roles.isEmpty {
                Text(L("No roles. The team pipeline needs at least a synthesize role; single-session mode ignores roles."))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .knodeCard()
            } else {
                roleTabs
                RoleCard(
                    role: roleBinding(selectedIndex),
                    phaseDefaults: profile?.phaseDefaults ?? [:],
                    connections: connections,
                    pipeline: pinnedPipeline.isEmpty ? research.pipeline : pinnedPipeline,
                    researchAgent: research.agent,
                    researchers: research.researchers,
                    reviewRounds: research.reviewRounds,
                    loadModels: loadModels,
                    remove: { removeRole(id: roles[selectedIndex].id) }
                )
                .id(roles[selectedIndex].id)
            }
        }
    }

    /// One tab per role, so five sub-agents fit on a screen instead of five
    /// full-height cards stacked down the page.
    private var roleTabs: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Array(roles.enumerated()), id: \.element.id) { index, role in
                    let selected = index == selectedIndex
                    Button {
                        selectedRoleID = role.id
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 5) {
                                Circle()
                                    .fill(role.enabled ? Color.knodeGood : Color.secondary.opacity(0.45))
                                    .frame(width: 6, height: 6)
                                Text(BuiltinNames.roleTitle(id: role.id, title: role.title))
                                    .font(.callout.weight(selected ? .semibold : .regular))
                                    .lineLimit(1)
                            }
                            Text(phaseLabel(role) + (role.enabled ? "" : " · \(L("off"))"))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(
                            selected ? Color.knodeViolet.opacity(0.16) : Color.secondary.opacity(0.08),
                            in: RoundedRectangle(cornerRadius: 9)
                        )
                        .overlay {
                            RoundedRectangle(cornerRadius: 9)
                                .stroke(selected ? Color.knodeViolet.opacity(0.55) : Color.white.opacity(0.06))
                        }
                        .opacity(role.enabled ? 1 : 0.6)
                    }
                    .buttonStyle(.plain)
                    .help(BuiltinNames.roleDescription(role.description))
                }
            }
            .padding(.vertical, 2)
        }
    }

    /// The tab's second line: the phase, plus how this one role is multiplied —
    /// sessions running at once for research, critique rounds for review.
    private func phaseLabel(_ role: ResearchRole) -> String {
        switch role.phase {
        case "research":
            let fanout = role.parallel == 0 ? research.researchers : role.parallel
            return fanout > 1 ? L("research · %@ at a time", String(fanout)) : role.phase
        case "review", "revise":
            let rounds = role.rounds == 0 ? research.reviewRounds : role.rounds
            return rounds > 1 ? L("%@ · %@ rounds", role.phase, String(rounds)) : role.phase
        default:
            return role.phase
        }
    }

    private func addRole() {
        guard var draft = profile else { return }
        var id = "role"
        var suffix = 2
        let taken = Set(draft.roles.map(\.id))
        while taken.contains(id) {
            id = "role-\(suffix)"
            suffix += 1
        }
        draft.roles.append(ResearchRole(id: id, phase: "research", promptDefault: draft.phaseDefaults["research"] ?? ""))
        profile = draft
        dirty = true
        selectedRoleID = id
    }

    private func removeRole(id: String) {
        guard var draft = profile else { return }
        draft.roles.removeAll { $0.id == id }
        profile = draft
        dirty = true
        selectedRoleID = draft.roles.first?.id
    }

    private func roleBinding(_ index: Int) -> Binding<ResearchRole> {
        Binding(
            get: { profile?.roles[safe: index] ?? ResearchRole(id: "role", phase: "research", promptDefault: "") },
            set: { updated in
                guard var draft = profile, draft.roles.indices.contains(index) else { return }
                draft.roles[index] = updated
                profile = draft
                dirty = true
            }
        )
    }

    /// Every profile field edits the draft in place and marks it unsaved, so
    /// "Save & apply" knows to write the YAML back alongside the config.
    private func bind<Value>(_ keyPath: WritableKeyPath<ResearchProfileDetail, Value>) -> Binding<Value> {
        Binding(
            get: { profile![keyPath: keyPath] },
            set: {
                profile![keyPath: keyPath] = $0
                dirty = true
            }
        )
    }
}

/// Which CLI runs a job: one of the configured CLI connections, one of the
/// CLIs found on the service's PATH, or whatever the caller inherits from.
struct AgentPicker: View {
    @Binding var selection: String
    let connections: [LLMConnection]
    let inheritLabel: String

    var body: some View {
        Picker(L("Agent"), selection: $selection) {
            Text(inheritLabel).tag("")
            ForEach(cliConnections) { connection in
                Text("\(connection.label) · \(providerName(connection.provider))").tag(connection.id)
            }
            ForEach(ResearchSettingsSection.cliProviders, id: \.self) { provider in
                Text(L("%@ · from PATH", providerName(provider))).tag(provider)
            }
        }
        .labelsHidden()
    }

    private var cliConnections: [LLMConnection] {
        connections.filter { ResearchSettingsSection.cliProviders.contains($0.provider) }
    }
}

/// One sub-agent: the phase it covers, where it runs, what it may touch, and
/// the prompt it is handed. An untouched prompt stays the built-in one — the
/// service only writes a role prompt file once its text actually differs.
/// What a phase asks of a model — the same idea as the stage rows in 02, one
/// step down: how often this sub-agent runs, what it produces, and the effort
/// that usually pays for itself there.
private struct PhaseGuidance {
    let badge: String
    let detail: String
    /// The effort this phase is usually worth; marked in the picker.
    let effort: String
    let color: Color

    static func of(_ phase: String) -> PhaseGuidance {
        switch phase {
        case "plan":
            PhaseGuidance(
                badge: "Judgment",
                detail: "One short session: it reads the brief, scouts the index and returns a JSON outline — no prose. A mid-tier model is enough, as long as it returns valid JSON; effort buys a better split into sections, not better writing.",
                effort: "medium",
                color: .knodeCyan
            )
        case "research":
            PhaseGuidance(
                badge: "Volume",
                detail: "One session per section, all at once — this is where most of the tokens go. A fast, cheap model is the right trade; raise effort only for sections that need real reasoning rather than retrieval.",
                effort: "medium",
                color: .knodeViolet
            )
        case "synthesize":
            PhaseGuidance(
                badge: "Quality",
                detail: "One session turns everyone's findings into the page people will actually read, and it is the only role that writes. Use the strongest model you have, at high effort — this is the output.",
                effort: "high",
                color: .knodeViolet
            )
        case "review":
            PhaseGuidance(
                badge: "Scrutiny",
                detail: "Reads the finished page against the contract, spot-checks sources and returns a JSON verdict. A strong model at high effort catches more, and the session is short, so it stays cheap.",
                effort: "high",
                color: .knodeCyan
            )
        case "revise":
            PhaseGuidance(
                badge: "Precision",
                detail: "Applies the review's notes to a page that already exists. Same class of model as the writer, but it edits rather than composes, so medium effort is usually enough.",
                effort: "medium",
                color: .knodeViolet
            )
        default:
            PhaseGuidance(
                badge: "Custom",
                detail: "A role of your own. Match the model and effort to what its prompt asks for — cheap and fast for gathering, strong and careful for writing or judging.",
                effort: "default",
                color: .knodeViolet
            )
        }
    }
}

/// One sub-agent: what its phase asks of a model, where it runs, what it may
/// touch, and the prompt it is handed. An untouched prompt stays the built-in
/// one — the service only writes a role prompt file once its text differs.
///
/// The CLI is not chosen here. A job runs on one coding agent, picked once in
/// the runner card above; a role that pins its own (by hand, in the YAML) says
/// so below and can be put back.
private struct RoleCard: View {
    @Binding var role: ResearchRole
    let phaseDefaults: [String: String]
    let connections: [LLMConnection]
    /// The pipeline a job will really run, so the card can say whether the
    /// native sub-agent switch means anything right now.
    let pipeline: String
    /// What an empty `role.agent` falls back to, so the model list is the one
    /// this role will really be asking.
    let researchAgent: String
    let researchers: Int
    let reviewRounds: Int
    let loadModels: (String) async throws -> ModelListResponse
    let remove: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            head
            guidance
            grid
            tools
            prompt
        }
        .knodeCard(padding: 18)
        .opacity(role.enabled ? 1 : 0.55)
    }

    /// What the role may touch. `native` is not a tool but a delegation: in the
    /// native pipeline one orchestrator session writes the page and calls the
    /// roles marked here as the CLI's own sub-agents, so the two roles that
    /// write — synthesize and revise — are never among them.
    private var tools: some View {
        VStack(alignment: .leading, spacing: 6) {
            Toggle(L("Writes pages (knode_write / knode_commit)"), isOn: $role.tools.write)
            Toggle(L("Reads files (Read / Grep / Glob)"), isOn: $role.tools.files)
            Toggle(L("Offer to the orchestrator as a native sub-agent"), isOn: $role.native)
                .disabled(!canBeNative)
            Text(nativeNote)
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.leading, 20)
        }
        .toggleStyle(.checkbox)
    }

    private var canBeNative: Bool { role.phase != "synthesize" && role.phase != "revise" }

    private var nativeNote: String {
        if !canBeNative {
            return L("The orchestrator writes the page itself, so this phase is never delegated.")
        }
        let what = L("With pipeline = native, one session writes the page and calls this role through the CLI's own sub-agents (claude --agents, codex agents.<id>) instead of knode starting a session for it. Sub-agents never write pages.")
        return pipeline == "native" ? what : what + " " + L("The pipeline is %@ right now, so this switch changes nothing.", pipeline)
    }

    private var advice: PhaseGuidance { .of(role.phase) }

    /// A role the service seeded covers exactly one phase, so it is stated
    /// rather than chosen; a role you add picks its own.
    private var isSeeded: Bool { BuiltinNames.isSeededRole(role.id) }

    private var effectiveAgent: String { role.agent.isEmpty ? researchAgent : role.agent }

    private var hasFanout: Bool { role.phase == "research" || role.phase == "review" || role.phase == "revise" }

    private var head: some View {
        HStack(spacing: 10) {
            Toggle(L("On"), isOn: $role.enabled)
                .toggleStyle(.checkbox)
            TextField(L("Role title"), text: $role.title)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 240)
            Text("\(role.id) · \(role.phase)\(role.native ? " · \(L("native"))" : "")")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(.tertiary)
            Spacer()
            Button(role: .destructive) { remove() } label: { Image(systemName: "trash") }
                .buttonStyle(.borderless)
                .help(L("Remove this role"))
        }
    }

    private var guidance: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 8) {
                RouteBadge(label: L(advice.badge), color: advice.color)
                Text(L(advice.detail))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 6) {
                Text(role.agent.isEmpty
                     ? L("Runs on %@, like every other role.", runsOnLabel)
                     : L("Pinned to %@ instead of the research agent.", runsOnLabel))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                if !role.agent.isEmpty {
                    Button(L("Use the research agent")) { role.agent = "" }
                        .buttonStyle(.borderless)
                        .font(.caption2)
                }
            }
        }
    }

    /// The CLI this role will really run on, named the way the runner names it.
    private var runsOnLabel: String {
        let key = effectiveAgent
        if key.isEmpty { return L("the research agent") }
        return connections.first { $0.id == key }?.label ?? providerName(key)
    }

    private var grid: some View {
        Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 12) {
            if isSeeded {
                GridRow {
                    modelField
                    effortField
                    webField
                }
                GridRow {
                    turnsField
                    if hasFanout {
                        fanoutField
                        descriptionField
                    } else {
                        descriptionField.gridCellColumns(2)
                    }
                }
            } else {
                GridRow {
                    phaseField
                    modelField
                    effortField
                }
                GridRow {
                    webField
                    turnsField
                    if hasFanout { fanoutField }
                }
                GridRow {
                    descriptionField.gridCellColumns(3)
                }
            }
        }
    }

    private var phaseField: some View {
        FieldLabel(L("Phase")) {
            Picker(L("Phase"), selection: phaseBinding) {
                ForEach(ResearchSettingsSection.phases, id: \.0) { Text(L($0.1)).tag($0.0) }
            }
            .labelsHidden()
        }
    }

    private var modelField: some View {
        ModelField(
            placeholder: L("Agent's model"),
            text: $role.model,
            providerKey: effectiveAgent,
            load: { try await loadModels(effectiveAgent) }
        )
    }

    /// The effort the phase is usually worth is marked in the list, so the
    /// recommendation sits where the choice is made.
    private var effortField: some View {
        FieldLabel(L("Effort")) {
            Picker(L("Effort"), selection: $role.effort) {
                Text(L("Profile default")).tag("default")
                ForEach(ResearchSettingsSection.efforts.dropFirst(), id: \.0) { value, label in
                    Text(value == advice.effort ? "\(L(label)) · \(L("recommended"))" : L(label)).tag(value)
                }
            }
            .labelsHidden()
        }
    }

    private var webField: some View {
        FieldLabel(L("Web tools")) {
            Picker(L("Web tools"), selection: $role.tools.web) {
                Text(L("Profile setting")).tag("inherit")
                Text(L("On (within review.external)")).tag("on")
                Text(L("Off")).tag("off")
            }
            .labelsHidden()
        }
    }

    private var turnsField: some View {
        FieldLabel(L("Turns per session")) {
            TextField(L("Default"), value: $role.maxTurns, format: .number)
        }
    }

    @ViewBuilder
    private var fanoutField: some View {
        if role.phase == "research" {
            FieldLabel(L("Parallel sessions")) {
                TextField("\(researchers)", value: $role.parallel, format: .number)
                    .help(L("How many sections are researched at the same time. One session per section either way — the outline decides how many there are; 0 follows the runner."))
            }
        } else {
            FieldLabel(L("Rounds")) {
                TextField("\(reviewRounds)", value: $role.rounds, format: .number)
            }
        }
    }

    private var descriptionField: some View {
        FieldLabel(L("Description")) {
            TextField(L("One line the orchestrator reads when picking this sub-agent"), text: $role.description)
        }
    }

    private var prompt: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(L("Prompt")).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Text("\(role.promptPath)\(role.promptIsDefault ? " · \(L("built-in"))" : "")")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                Spacer()
                Button(L("Reset to built-in")) { resetPrompt() }
                    .buttonStyle(.borderless)
                    .disabled(role.promptIsDefault)
            }
            TextEditor(text: promptBinding)
                .font(.system(size: 11, design: .monospaced))
                .frame(height: 170)
                .padding(6)
                .background(Color(nsColor: .textBackgroundColor).opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
                .overlay { RoundedRectangle(cornerRadius: 8).stroke(Color.white.opacity(0.08)) }
            Text(L("The prompt stays in the language it is written in — it is what the agent actually receives."))
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    /// Moving a role to another phase carries an untouched prompt to that
    /// phase's built-in; an edited one is left alone. The two phases that write
    /// the page always need the write tools.
    private var phaseBinding: Binding<String> {
        Binding(
            get: { role.phase },
            set: { phase in
                let wasDefault = role.promptIsDefault || role.promptText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                role.phase = phase
                role.promptDefault = phaseDefaults[phase] ?? ""
                if wasDefault {
                    role.promptText = role.promptDefault
                    role.promptIsDefault = true
                }
                if phase == "synthesize" || phase == "revise" { role.tools.write = true }
            }
        )
    }

    private var promptBinding: Binding<String> {
        Binding(
            get: { role.promptText },
            set: { text in
                role.promptText = text
                role.promptIsDefault = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    == role.promptDefault.trimmingCharacters(in: .whitespacesAndNewlines)
            }
        )
    }

    private func resetPrompt() {
        let fallback = role.promptDefault.isEmpty ? (phaseDefaults[role.phase] ?? "") : role.promptDefault
        role.promptText = fallback
        role.promptDefault = fallback
        role.promptIsDefault = true
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
