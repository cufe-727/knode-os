import SwiftUI

/// Settings · Research, in three layers. The runner card says which agent runs
/// jobs, how many at once and for how long, and whether agents may use the web
/// at all; the profile below it says how a job runs — its pipeline — and the
/// bar a page has to clear; the sub-agents that do each phase sit behind one
/// tab each, with their own model, tools and prompt.
///
/// A profile is a file (`playbooks/research/profiles/<name>.yaml`), so what is
/// edited here can equally be edited by hand; the role prompts travel with it
/// and stay in the language they are written in, because that text is what the
/// agent actually receives.
///
/// What the agent's runtime takes no flag for is greyed out, with the reason
/// (see `ResearchRuntime`), and the rules a profile only writes into the brief
/// sit folded away from the ones knode checks.
struct ResearchSettingsSection: View {
    @Binding var research: ResearchConfig
    /// The workspace's web switch (`review.external`): the cap over the
    /// profile's, the roles' and Ask's own web settings.
    @Binding var review: ReviewConfig
    @Binding var profile: ResearchProfileDetail?
    @Binding var dirty: Bool
    /// Selecting another profile reloads its file, so it goes through the
    /// parent rather than straight into `research.profile`.
    @Binding var profileSelection: String
    let summaries: [ResearchProfileSummary]
    /// The models and the CLI agents (see `llmTargets`), for naming a spec.
    let connections: [LLMConnection]
    /// The named agents from Providers & Agents, so the pickers can offer them.
    let agents: [AgentDefinition]
    /// What the default is in the draft: a model, or a CLI agent.
    let defaultTarget: LLMConnection?
    let isWorking: Bool
    /// What a spec's Model field inherits when it is left empty. A closure
    /// because the rule needs the whole config, which only SettingsView holds.
    let inheritedModel: (String) -> String
    /// Models the CLI behind an agent key offers ("" = the default provider).
    let loadModels: (String, Bool) async throws -> ModelListResponse
    let duplicate: () -> Void
    let remove: () -> Void

    @State private var selectedRoleID: String?
    /// The rules the agent is only told about start folded.
    @State private var rulesExpanded = false

    /// The coding-agent CLIs. An OpenAI-compatible connection can run a job
    /// too — on the built-in agent — so this list is no longer the whole set.
    static let cliProviders = ["claude-cli", "codex-cli", "cursor-cli"]

    /// The spec that names the default connection rather than a named one.
    static let defaultConnection = "default"

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
        VStack(alignment: .leading, spacing: 3) {
            Text(L("How the wiki gets written")).font(.title3.bold())
            Text(L("The runner picks who runs jobs; the profile sets how a job runs and the bar a page has to clear; its sub-agents each take one phase."))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - Runner

    private var runnerCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 3) {
                Text(L("Runner")).font(.headline)
                Text(L("Who runs research jobs, how many at once, and whether agents may use the web at all."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 12) {
                GridRow {
                    FieldLabel(L("Agent")) {
                        AgentPicker(selection: $research.agent, agents: agents, connections: connections, fallbackLabel: nil, defaultName: defaultTarget?.label ?? "")
                    }
                    // a research run thinks as hard as its profile says, so the
                    // profile's effort and speed sit on the model it runs
                    ModelField(
                        placeholder: L("CLI default"),
                        text: $research.model,
                        inherited: inheritedModel(research.agent),
                        providerKey: research.agent,
                        route: "agent:\(research.agent)",
                        load: { refresh in try await loadModels(research.agent, refresh) },
                        tuning: runnerTuning
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
                    FieldLabel(L("Parallel jobs")) {
                        TextField("1", value: $research.concurrency, format: .number)
                    }
                    FieldLabel(L("Session timeout (minutes)")) {
                        TextField("20", value: timeoutMinutes, format: .number)
                            .help(L("Each agent session stops after this long. A team job runs several — the plan, one per section, the write-up, each review — so the job as a whole takes longer."))
                    }
                    FieldLabel(L("Web access")) {
                        Picker(L("Web access"), selection: $review.external) {
                            Text(L("Off for every agent")).tag("off")
                            Text(L("Verification jobs only")).tag("verify")
                            Text(L("Every job, and Ask")).tag("research")
                        }
                        .labelsHidden()
                        .help(L("The workspace's switch, Ask included. A profile, a role or an Ask agent can turn the web off, or on for more jobs — never past Off."))
                    }
                }
            }
            // the two ways jobs get queued without anyone asking for one
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Toggle(L("Accept the top recommendations automatically, up to"), isOn: $research.auto.enabled)
                        .toggleStyle(.checkbox)
                    TextField("3", value: $research.auto.dailyJobs, format: .number)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 64)
                        .disabled(!research.auto.enabled)
                    Text(L("jobs a day")).font(.callout).foregroundStyle(.secondary)
                }
                HStack(spacing: 8) {
                    Toggle(L("After an initialization, queue up to"), isOn: queuesFollowUps)
                        .toggleStyle(.checkbox)
                    TextField("6", value: $research.initialization.followUps, format: .number)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 64)
                        .disabled(research.initialization.followUps == 0)
                    Text(L("topic pages it suggests")).font(.callout).foregroundStyle(.secondary)
                }
            }
            Text(note)
                .font(.caption)
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .knodeCard(padding: 18)
    }

    /// A profile by its title; the file name joins in only when another
    /// profile reads the same, as a fresh duplicate does.
    private func profileLabel(_ summary: ResearchProfileSummary) -> String {
        let title = BuiltinNames.profileTitle(summary.title)
        guard !title.isEmpty, title != summary.name else { return summary.name }
        let shared = summaries.contains { $0.name != summary.name && BuiltinNames.profileTitle($0.title) == title }
        return shared ? "\(title) · \(summary.name)" : title
    }

    /// Whether an initialization queues the topic pages its plan suggests.
    /// There is no separate switch in the config — none is `followUps: 0` —
    /// so turning it back on starts from the default count.
    private var queuesFollowUps: Binding<Bool> {
        Binding(
            get: { research.initialization.followUps > 0 },
            set: { research.initialization.followUps = $0 ? ResearchConfig.Initialization().followUps : 0 }
        )
    }

    private var timeoutMinutes: Binding<Int> {
        Binding(
            get: { max(1, research.timeoutMs / 60_000) },
            set: { research.timeoutMs = max(1, $0) * 60_000 }
        )
    }

    /// The pipeline a job of this profile runs: its own, else what the config
    /// keeps for a profile that names none.
    private var pipeline: String {
        let own = profile?.pipeline ?? ""
        return own.isEmpty ? research.pipeline : own
    }

    /// Picking a pipeline writes it into the profile, so what the picker shows
    /// is always what that profile runs.
    private var pipelineSelection: Binding<String> {
        Binding(
            get: { pipeline },
            set: { mode in
                guard profile != nil, mode != pipeline else { return }
                profile!.pipeline = mode
                dirty = true
            }
        )
    }

    /// The CLI a spec runs on — an agent's executor, a CLI agent's provider, a
    /// bare CLI name, or what the default is — and "" when it runs on a model,
    /// which takes no effort.
    private func runtime(_ spec: String) -> String {
        let provider: String
        if let agent = agents.first(where: { $0.name == spec }) {
            provider = agent.executor
        } else if spec == Self.defaultConnection {
            provider = defaultTarget?.provider ?? ""
        } else {
            provider = connections.first { $0.id == spec }?.provider ?? spec
        }
        return cliProviderNames.contains(provider) ? provider : ""
    }

    /// What knode can hold a session on this spec to; nil while the spec
    /// names nothing that resolves, which greys out nothing.
    private func researchRuntime(_ spec: String) -> ResearchRuntime? {
        guard !spec.isEmpty else { return nil }
        if let agent = agents.first(where: { $0.name == spec }) {
            return ResearchRuntime(provider: agent.isCli ? agent.executor : "")
        }
        let provider: String?
        if spec == Self.defaultConnection {
            provider = defaultTarget?.provider
        } else if cliProviderNames.contains(spec) {
            provider = spec
        } else {
            provider = connections.first { $0.id == spec }?.provider
        }
        guard let provider else { return nil }
        return ResearchRuntime(provider: cliProviderNames.contains(provider) ? provider : "")
    }

    /// The runtimes a job of this profile runs on: the research agent's, and
    /// any a role that is on has been pinned to by hand.
    private var runtimesInUse: [ResearchRuntime] {
        ([research.agent] + roles.filter { $0.enabled && !$0.agent.isEmpty }.map(\.agent)).compactMap(researchRuntime)
    }

    /// The runtime a native job's orchestrator — the writer's session — is on.
    private var orchestratorRuntime: ResearchRuntime? {
        let writer = roles.first { $0.enabled && $0.phase == "synthesize" }
        return researchRuntime(writer.map { $0.agent.isEmpty ? research.agent : $0.agent } ?? research.agent)
    }

    /// What a job really runs: native on an orchestrator without sub-agents
    /// (Cursor) comes to one session, as `runNativePipeline` falls back.
    private var runningPipeline: String {
        pipeline == "native" && orchestratorRuntime?.hasSubAgents == false ? "single" : pipeline
    }

    /// The profile's effort and speed, on the model the research agent runs:
    /// every session and role that sets none runs at them.
    private var runnerTuning: ModelTuning? {
        guard let profile else { return nil }
        let cli = runtime(research.agent)
        guard !cli.isEmpty else { return nil }
        return ModelTuning(
            effort: bind(\.reasoning.effort),
            speed: bind(\.reasoning.speed),
            runtime: cli,
            note: L("Saved with the profile “%@” — every role that sets none runs at it.", profile.name)
        )
    }

    /// A spec by the name the tables give it: an agent's title, the default
    /// with what it is now, or a model or CLI agent by its label.
    private func specLabel(_ spec: String) -> String {
        if let agent = agents.first(where: { $0.name == spec }) { return agent.title }
        if spec == Self.defaultConnection {
            return defaultTarget.map { L("Default LLM provider · %@", $0.label) } ?? L("Default LLM provider")
        }
        return connections.first { $0.id == spec }?.label ?? providerName(spec)
    }

    private func pipelineName(_ mode: String) -> String {
        switch mode {
        case "native": L("Native sub-agents")
        case "single": L("Single session")
        default: L("Team")
        }
    }

    /// Which jobs get web tools when no role says otherwise — `webAllowed` on
    /// the service, read for this profile and the research agent.
    private var webSummary: String {
        guard let profile else { return "" }
        if review.external == "off" || profile.search.web == "off" { return L("off") }
        if researchRuntime(research.agent)?.hasWeb == false { return L("none (built-in agent)") }
        if review.external == "research" || profile.search.web == "on" { return L("every job") }
        return L("verification jobs only")
    }

    /// What a job will actually do, assembled from the runner and the profile.
    private var note: String {
        let agentLabel = research.agent.isEmpty ? L("not configured") : specLabel(research.agent)
        let pipeline = runningPipeline
        var parts = [L("Agent: %@", agentLabel), L("pipeline: %@", pipelineName(pipeline))]
        if let profile {
            parts.append(L("effort: %@", profile.reasoning.effort))
            parts.append(L("web: %@", webSummary))
            parts.append(L("sources per fact: %@", String(profile.verification.minSourcesPerClaim)))
        }
        if pipeline != "single" {
            // native runs the writer's session and the roles offered to it; team runs every role that is on
            let running = roles.filter { $0.enabled && (pipeline != "native" || $0.phase == "synthesize" || ($0.native && $0.phase != "revise")) }
            let names = running.map { role -> String in
                let fanout = pipeline == "team" && role.phase == "research" ? (role.parallel == 0 ? research.researchers : role.parallel) : 0
                return BuiltinNames.roleTitle(id: role.id, title: role.title) + (fanout > 1 ? " ×\(fanout)" : "") + (role.agent.isEmpty ? "" : " @\(specLabel(role.agent))")
            }
            parts.append(L("roles: %@", names.isEmpty ? L("none") : names.joined(separator: L10n.isChinese ? "、" : ", ")))
        }
        let limits = researchRuntime(research.agent)?.limits
        return parts.joined(separator: " · ") + "." + (limits.map { " " + $0 } ?? "")
    }

    // MARK: - Profile

    /// Whether any runtime in use can search the web at all; nothing in use
    /// that resolves counts as yes, so a missing agent greys out nothing.
    private var webPossible: Bool {
        runtimesInUse.isEmpty || runtimesInUse.contains(where: \.hasWeb)
    }

    /// Only codex can be pointed at a cached index, and only while it may
    /// search at all.
    private var freshnessApplies: Bool {
        let codex = runtimesInUse.isEmpty || runtimesInUse.contains(where: \.choosesFreshness)
        return codex && review.external != "off" && profile?.search.web != "off"
    }

    /// One line on the pipeline that is picked: what runs, and on Cursor, why
    /// native comes to a single session.
    private var pipelineNote: String {
        switch pipeline {
        case "native":
            let alone = orchestratorRuntime?.hasSubAgents == false
            return L("One session — the Lead writer’s — runs the job and calls the roles offered as native sub-agents through the CLI itself.")
                + (alone ? " " + L("Cursor has no sub-agents, so a native job runs as a single session.") : "")
        case "single":
            return L("One session does the whole job with the rules below; the sub-agents are not used.")
        default:
            return L("Plan → research each section in parallel → write → review ↔ revise, each its own session, done by the sub-agents below.")
        }
    }

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
                    Text(L("Stored as %@ — edit here or in the file.",
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
                    FieldLabel(L("Pipeline")) {
                        Picker(L("Pipeline"), selection: pipelineSelection) {
                            Text(L("Team")).tag("team")
                            Text(L("Native sub-agents")).tag("native")
                            Text(L("Single session")).tag("single")
                        }
                        .labelsHidden()
                    }
                    FieldLabel(L("Web access")) {
                        Picker(L("Web access"), selection: bind(\.search.web)) {
                            Text(L("Follow the workspace")).tag("inherit")
                            Text(L("On for every job")).tag("on")
                            Text(L("Off")).tag("off")
                        }
                        .labelsHidden()
                        .disabled(review.external == "off" || !webPossible)
                        .help(review.external == "off"
                              ? L("Web access is off for the whole workspace — see the runner above.")
                              : L("On widens the workspace's verification-only default to every job of this profile."))
                    }
                    FieldLabel(L("Search freshness")) {
                        Picker(L("Search freshness"), selection: bind(\.search.freshness)) {
                            Text(L("Live web search")).tag("live")
                            Text(L("Cached search index (codex)")).tag("cached")
                        }
                        .labelsHidden()
                        .disabled(!freshnessApplies)
                        .help(L("Only the Codex CLI can search a cached index; the other agents always search live."))
                    }
                }
                // top-aligned: the checkbox is shorter than the two fields beside it
                GridRow(alignment: .top) {
                    FieldLabel(L("Max sections")) {
                        TextField("8", value: bind(\.stop.maxSections), format: .number)
                            .help(L("The team pipeline cuts the outline to this many sections."))
                    }
                    FieldLabel(L("Sources per fact")) {
                        TextField("1", value: bind(\.verification.minSourcesPerClaim), format: .number)
                            .help(L("From 2 up, a page whose facts cite fewer sources is sent back."))
                    }
                    FieldLabel(L("Evidence table")) {
                        Toggle(L("Required section"), isOn: bind(\.output.evidenceTable))
                            .toggleStyle(.checkbox)
                            .help(L("A page without the evidence table section is sent back."))
                    }
                }
            }
            Text(pipelineNote)
                .font(.caption)
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
            DisclosureGroup(isExpanded: $rulesExpanded) {
                VStack(alignment: .leading, spacing: 10) {
                    Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 12) {
                        GridRow {
                            FieldLabel(L("Search rounds per section")) {
                                TextField("3", value: bind(\.search.maxRounds), format: .number)
                            }
                            FieldLabel(L("Conflicting sources")) {
                                Picker(L("Conflicting sources"), selection: bind(\.verification.resolveConflicts)) {
                                    Text(L("Flag both sides as disputed")).tag("flag")
                                    Text(L("Prefer the primary source")).tag("prefer_primary")
                                    Text(L("Prefer the most recent")).tag("prefer_recent")
                                }
                                .labelsHidden()
                            }
                        }
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        Toggle(L("Prefer primary sources"), isOn: bind(\.verification.preferPrimarySources))
                        Toggle(L("Stop a section when a search round adds nothing new"), isOn: bind(\.stop.marginalGain))
                        Toggle(L("Cite a source on every fact"), isOn: bind(\.output.citations))
                        Toggle(L("Mark uncertain claims as suspected"), isOn: bind(\.output.uncertainty))
                    }
                    .toggleStyle(.checkbox)
                }
                .padding(.top, 8)
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(L("Research rules")).font(.callout.weight(.semibold))
                    Text(L("Written into every brief for the agent to follow; knode does not check them."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
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

    /// What a reviser with no rounds of its own runs: a review role's older
    /// setting, else the config's default — `revisionRounds` on the service.
    private var roundsFallback: Int {
        let older = roles.filter { $0.enabled && $0.phase == "review" }.map(\.rounds).max() ?? 0
        return older > 0 ? older : research.reviewRounds
    }

    private var rolesCaption: String {
        switch pipeline {
        case "single":
            L("A single session uses none of these roles; they wait for the team or native pipeline.")
        case "native":
            L("The Lead writer’s session runs the job and calls the roles offered as native sub-agents; the others are not used.")
        default:
            L("Each role that is on runs as its own session, in phase order; turn one off to skip its phase.")
        }
    }

    private var rolesEditor: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(L("Sub-agents")).font(.headline)
                    Text(rolesCaption)
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
                    label: specLabel,
                    pipeline: pipeline,
                    researchAgent: research.agent,
                    researchers: research.researchers,
                    roundsFallback: roundsFallback,
                    webOff: review.external == "off",
                    nativeFallsBack: orchestratorRuntime?.hasSubAgents == false,
                    profileReasoning: profile?.reasoning ?? ResearchProfileDetail.Reasoning(),
                    runtime: runtime,
                    support: researchRuntime,
                    inheritedModel: inheritedModel,
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
    /// sessions running at once for research, revision rounds for revise.
    private func phaseLabel(_ role: ResearchRole) -> String {
        switch role.phase {
        case "research":
            let fanout = role.parallel == 0 ? research.researchers : role.parallel
            return fanout > 1 ? L("research · %@ at a time", String(fanout)) : role.phase
        case "revise":
            let rounds = role.rounds == 0 ? roundsFallback : role.rounds
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

/// What knode can hold one research session to on each runtime, read off
/// `sessionArgs` (src/research/launch.ts) and the built-in agent
/// (src/research/deepagents.ts). Settings greys out what a runtime takes no
/// flag for, rather than letting it look as if it applied.
private struct ResearchRuntime: Equatable {
    /// "claude-cli" | "codex-cli" | "cursor-cli"; "" = the built-in agent on a model.
    let provider: String

    /// claude --max-turns; the built-in loop's recursion limit.
    var capsTurns: Bool { provider == "claude-cli" || provider.isEmpty }
    /// Whether a session gets knode_write or not: claude's allowed-tools list,
    /// the built-in agent's tool list. codex and cursor see every MCP tool.
    var scopesTools: Bool { provider == "claude-cli" || provider.isEmpty }
    /// Read / Grep / Glob as tools to grant or withhold: claude only. codex's
    /// sandbox and cursor always read; the built-in agent reads no files.
    var scopesFiles: Bool { provider == "claude-cli" }
    /// Web tools on or off per session: claude's WebSearch / WebFetch, codex's
    /// web_search. cursor takes no switch; the built-in agent has no web tool.
    var switchesWeb: Bool { provider == "claude-cli" || provider == "codex-cli" }
    var hasWeb: Bool { !provider.isEmpty }
    /// codex's web_search = live | cached.
    var choosesFreshness: Bool { provider == "codex-cli" }
    /// claude --agents, codex agents.<id>, deepagents' own; cursor has none.
    var hasSubAgents: Bool { provider != "cursor-cli" }

    /// Why settings are greyed out on this runtime; nil when none are.
    @MainActor var limits: String? {
        switch provider {
        case "cursor-cli":
            L("Cursor CLI takes no turn cap, tool scope or web switch from knode, so those settings are greyed out — the brief and the prompts are what steer it.")
        case "codex-cli":
            L("Codex CLI takes no turn cap or tool scope from knode — its sandbox keeps it read-only on disk — so those settings are greyed out.")
        case "":
            L("The built-in agent has no web tool and reads no files, so those settings are greyed out — it works through knode's tools only.")
        default:
            nil
        }
    }
}

/// Which agent runs a job or answers Ask: one of the agents in section 01 —
/// deepagents on a model, or a coding-agent CLI — each saying which it is.
///
/// A config written before agents may name a bare CLI, the default provider
/// or a model straight. Those keep resolving, so the one in use stays on the
/// list — only that one: a new choice is an agent.
///
/// `fallbackLabel` is what an empty selection means ("the research agent
/// above") for chat and roles. The research agent itself passes nil: it has no
/// fallback any more, so an empty value is shown as the unconfigured state.
struct AgentPicker: View {
    @Binding var selection: String
    /// The agents from Providers & Agents, in the order that table lists them.
    var agents: [AgentDefinition] = []
    let connections: [LLMConnection]
    var fallbackLabel: String?
    /// What the default is called now, for a legacy `default` selection.
    var defaultName: String = ""

    var body: some View {
        Picker(L("Agent"), selection: $selection) {
            if let fallbackLabel {
                Text(fallbackLabel).tag("")
            } else if selection.isEmpty {
                Text(L("Not configured — pick an agent")).tag("")
            }
            ForEach(agents) { agent in
                Text("\(agent.title) · \(agent.isCli ? providerName(agent.executor) : "deepagents")").tag(agent.name)
            }
            if !selection.isEmpty && !agents.contains(where: { $0.name == selection }) {
                Divider()
                Text(legacyLabel).tag(selection)
            }
        }
        .labelsHidden()
    }

    private var legacyLabel: String {
        if selection == ResearchSettingsSection.defaultConnection {
            return defaultName.isEmpty ? L("Default LLM provider") : L("Default LLM provider · %@", defaultName)
        }
        if cliProviderNames.contains(selection) { return L("%@ · from PATH", providerName(selection)) }
        if let connection = connections.first(where: { $0.id == selection }) { return "\(connection.label) · deepagents" }
        return selection
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
/// so below and can be put back. What that runtime takes no flag for is greyed
/// out, and one line says why.
private struct RoleCard: View {
    @Binding var role: ResearchRole
    let phaseDefaults: [String: String]
    /// A spec by the name the tables give it.
    let label: (String) -> String
    /// The pipeline a job will really run: the native sub-agent switch only
    /// shows under `native`.
    let pipeline: String
    /// What an empty `role.agent` falls back to, so the model list is the one
    /// this role will really be asking.
    let researchAgent: String
    let researchers: Int
    /// What an unset Revision rounds runs (see the section's `roundsFallback`).
    let roundsFallback: Int
    /// The workspace's web switch is off, so no web setting here applies.
    let webOff: Bool
    /// The orchestrator's CLI has no sub-agents (Cursor), so native runs alone.
    let nativeFallsBack: Bool
    /// What a role that sets no effort or speed runs at.
    let profileReasoning: ResearchProfileDetail.Reasoning
    /// The CLI a spec runs on, "" for a model (see the section's `runtime`).
    let runtime: (String) -> String
    /// What knode can hold a spec's sessions to; nil while it names nothing.
    let support: (String) -> ResearchRuntime?
    let inheritedModel: (String) -> String
    let loadModels: (String, Bool) async throws -> ModelListResponse
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

    /// What this role's runtime enforces; an agent that does not resolve
    /// greys out nothing.
    private var enforced: ResearchRuntime? { support(effectiveAgent) }

    /// What the role may touch. `native` is not a tool but a delegation: in the
    /// native pipeline one orchestrator session writes the page and calls the
    /// roles marked here as the CLI's own sub-agents, so the two roles that
    /// write — synthesize and revise — are never among them.
    private var tools: some View {
        VStack(alignment: .leading, spacing: 6) {
            Toggle(L("Writes pages (knode_write / knode_commit)"), isOn: $role.tools.write)
                .disabled(enforced?.scopesTools == false)
            Toggle(L("Reads files (Read / Grep / Glob)"), isOn: $role.tools.files)
                .disabled(enforced?.scopesFiles == false)
            if pipeline == "native" {
                Toggle(L("Offer to the orchestrator as a native sub-agent"), isOn: $role.native)
                    .disabled(!canBeNative || nativeFallsBack)
                Text(nativeNote)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 20)
            }
            if let limits = enforced?.limits {
                Text(limits)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .toggleStyle(.checkbox)
    }

    private var canBeNative: Bool { role.phase != "synthesize" && role.phase != "revise" }

    private var nativeNote: String {
        if !canBeNative {
            return L("The orchestrator writes the page itself, so this phase is never delegated.")
        }
        if nativeFallsBack {
            return L("Cursor has no sub-agents, so a native job runs as a single session.")
        }
        return L("One session writes the page and calls this role through the CLI's own sub-agents (claude --agents, codex agents.<id>) instead of knode starting a session for it. Sub-agents never write pages.")
    }

    private var advice: PhaseGuidance { .of(role.phase) }

    /// A role the service seeded covers exactly one phase, so it is stated
    /// rather than chosen; a role you add picks its own.
    private var isSeeded: Bool { BuiltinNames.isSeededRole(role.id) }

    private var effectiveAgent: String { role.agent.isEmpty ? researchAgent : role.agent }

    /// Research is multiplied by sessions at once, revise by rounds; the
    /// review roles all run once per round, so they carry no number.
    private var hasFanout: Bool { role.phase == "research" || role.phase == "revise" }

    private var head: some View {
        HStack(spacing: 10) {
            Toggle(L("On"), isOn: $role.enabled)
                .toggleStyle(.checkbox)
            TextField(L("Role title"), text: $role.title)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 240)
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
        return label(key)
    }

    private var grid: some View {
        Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 12) {
            if isSeeded {
                GridRow {
                    modelField.gridCellColumns(2)
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
                    modelField.gridCellColumns(2)
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

    /// The role's effort and speed ride on its model; "default" is the
    /// profile's, and the effort the phase is usually worth is marked on the
    /// slider, so the recommendation sits where the choice is made.
    private var modelField: some View {
        ModelField(
            placeholder: L("Agent's model"),
            text: $role.model,
            inherited: inheritedModel(effectiveAgent),
            providerKey: effectiveAgent,
            route: "agent:\(effectiveAgent)",
            load: { refresh in try await loadModels(effectiveAgent, refresh) },
            tuning: ModelTuning(
                effort: $role.effort,
                speed: $role.speed,
                runtime: runtime(effectiveAgent),
                inheritedEffort: profileReasoning.effort,
                inheritedSpeed: profileReasoning.speed,
                inheritedFrom: L("the profile"),
                recommended: advice.effort == "default" ? nil : advice.effort
            )
        )
    }

    private var webField: some View {
        FieldLabel(L("Web tools")) {
            Picker(L("Web tools"), selection: $role.tools.web) {
                Text(L("Follow the profile")).tag("inherit")
                Text(L("On (unless the workspace is off)")).tag("on")
                Text(L("Off")).tag("off")
            }
            .labelsHidden()
            .disabled(webOff || enforced?.switchesWeb == false)
        }
    }

    private var turnsField: some View {
        FieldLabel(L("Turns per session")) {
            TextField(L("Template's"), value: defaulted($role.maxTurns), format: .number)
                .disabled(enforced?.capsTurns == false)
                .help(L("Empty uses the page template's cap."))
        }
    }

    @ViewBuilder
    private var fanoutField: some View {
        if role.phase == "research" {
            FieldLabel(L("Parallel sessions")) {
                TextField(String(researchers), value: defaulted($role.parallel), format: .number)
                    .help(L("How many sections are researched at the same time — one session per section either way. Empty runs %@ at a time.", String(researchers)))
            }
        } else {
            FieldLabel(L("Revision rounds")) {
                TextField(String(roundsFallback), value: defaulted($role.rounds), format: .number)
                    .help(L("How many times a page may go back from review to this role before it is accepted or rejected. Empty allows %@.", String(roundsFallback)))
            }
        }
    }

    /// A role's 0 means "the default", so it shows as an empty field with the
    /// default as its placeholder rather than as a literal 0.
    private func defaulted(_ value: Binding<Int>) -> Binding<Int?> {
        Binding(
            get: { value.wrappedValue == 0 ? nil : value.wrappedValue },
            set: { value.wrappedValue = max(0, $0 ?? 0) }
        )
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
