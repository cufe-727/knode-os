import SwiftUI

/// Settings · 03 · Deep research. The runner card says which coding-agent CLI
/// writes wiki pages, how many jobs run at once and which profile they follow;
/// the profile below it sets how hard they think, what they may read from the
/// web and the bar a page has to clear, and lists the sub-agents that do the
/// work — each with its own CLI, model, tools and prompt.
///
/// A profile is a file (`playbooks/research/profiles/<name>.yaml`), so what is
/// edited here can equally be edited by hand; the role prompts travel with it.
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
    let duplicate: () -> Void
    let remove: () -> Void

    /// The providers that can run a research job: a job is a CLI session, not
    /// a chat completion, so an OpenAI-compatible endpoint cannot take one.
    static let cliProviders = ["claude-cli", "codex-cli", "cursor-cli"]

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
                Text("No research profile loaded. Save the settings once, or check that the service is new enough to serve /api/research/profiles.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .knodeCard()
            }
        }
    }

    private var header: some View {
        HStack(alignment: .bottom) {
            VStack(alignment: .leading, spacing: 3) {
                Eyebrow(text: "03 · Deep research", color: .knodeViolet)
                Text("Who writes the wiki, and how hard they think").font(.title3.bold())
                Text("A coding-agent CLI researches a topic through the MCP endpoint and writes the page. A profile sets the reasoning effort, web access and verification bar, and lists the sub-agents — each with its own CLI, model, tools and prompt.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 12)
            RouteBadge(label: "Agents", color: .knodeViolet)
        }
    }

    // MARK: - Runner

    private var runnerCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Research agent").font(.headline)
                    Text("Which CLI runs jobs, how many at once, and which profile it follows. Roles below may override the CLI per phase.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 12)
                RouteBadge(label: "Runner", color: .knodeCyan)
            }
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 12) {
                GridRow {
                    FieldLabel("Agent") {
                        AgentPicker(selection: $research.agent, connections: connections, inheritLabel: inheritLabel)
                    }
                    FieldLabel("Model") {
                        TextField("CLI default", text: $research.model)
                    }
                    FieldLabel("Profile") {
                        Picker("Profile", selection: $profileSelection) {
                            ForEach(summaries) { summary in
                                Text(summary.title == summary.name ? summary.name : "\(summary.name) · \(summary.title)")
                                    .tag(summary.name)
                            }
                        }
                        .labelsHidden()
                    }
                }
                GridRow {
                    FieldLabel("Pipeline") {
                        Picker("Pipeline", selection: $research.pipeline) {
                            Text("Team · plan, research, synthesize, review, revise").tag("team")
                            Text("Native sub-agents · one session").tag("native")
                            Text("Single session").tag("single")
                        }
                        .labelsHidden()
                    }
                    FieldLabel("Parallel jobs") {
                        TextField("1", value: $research.concurrency, format: .number)
                    }
                    FieldLabel("Turns per session") {
                        TextField("40", value: $research.maxTurns, format: .number)
                    }
                }
                GridRow {
                    FieldLabel("Timeout (minutes)") {
                        TextField("20", value: timeoutMinutes, format: .number)
                    }
                    FieldLabel("Researchers (default fan-out)") {
                        TextField("3", value: $research.researchers, format: .number)
                    }
                    FieldLabel("Review rounds (default)") {
                        TextField("1", value: $research.reviewRounds, format: .number)
                    }
                }
            }
            HStack(spacing: 8) {
                Toggle("Accept the top recommendations automatically, up to", isOn: $research.auto.enabled)
                    .toggleStyle(.checkbox)
                TextField("3", value: $research.auto.dailyJobs, format: .number)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 64)
                    .disabled(!research.auto.enabled)
                Text("jobs a day").font(.callout).foregroundStyle(.secondary)
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
            ? "Default LLM provider · \(providerName(defaultProvider))"
            : "Default LLM provider (not a CLI — pick one)"
    }

    private var timeoutMinutes: Binding<Int> {
        Binding(
            get: { max(1, research.timeoutMs / 60_000) },
            set: { research.timeoutMs = max(1, $0) * 60_000 }
        )
    }

    /// What a job will actually do, assembled from the runner and the profile —
    /// the profile may pin its own pipeline, so the two can disagree.
    private var note: String {
        let agentLabel = research.agent.isEmpty
            ? inheritLabel
            : (connections.first { $0.id == research.agent }?.label ?? providerName(research.agent))
        let pinned = profile?.pipeline ?? ""
        let pipeline = pinned.isEmpty ? research.pipeline : pinned
        var parts = ["Agent: \(agentLabel)", "pipeline: \(pipeline)\(pinned.isEmpty ? "" : " (pinned by profile)")"]
        if let profile {
            parts.append("effort: \(profile.reasoning.effort)")
            parts.append("web: \(profile.search.web) / \(profile.search.freshness)")
            parts.append("sources per fact: \(profile.verification.minSourcesPerClaim)")
        }
        if pipeline != "single" {
            let roles = (profile?.roles ?? []).filter(\.enabled).map { role -> String in
                let fanout = role.phase == "research" ? (role.parallel == 0 ? research.researchers : role.parallel) : 0
                return role.id + (fanout > 1 ? " ×\(fanout)" : "") + (role.agent.isEmpty ? "" : " @\(role.agent)")
            }
            parts.append("roles: \(roles.isEmpty ? "none" : roles.joined(separator: ", "))")
        }
        return parts.joined(separator: " · ") + ". Web tools never exceed what review.external allows."
    }

    // MARK: - Profile

    private var profileCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text("Profile").font(.headline)
                        Text(profile?.name ?? "")
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                    Text("Stored as \(profile?.path.isEmpty == false ? profile!.path : "playbooks/research/profiles/<name>.yaml") — edit here or in the file. The profile may pin its own pipeline.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 12)
                Button("Duplicate…") { duplicate() }
                    .disabled(isWorking)
                Button(profile?.builtin == true ? "Reset to built-in" : "Delete", role: .destructive) { remove() }
                    .disabled(isWorking)
            }
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 12) {
                GridRow {
                    FieldLabel("Title") {
                        TextField("Shown in lists", text: bind(\.title))
                    }
                    FieldLabel("Description") {
                        TextField("When to pick this profile", text: bind(\.description))
                    }
                    .gridCellColumns(2)
                }
                GridRow {
                    FieldLabel("Pipeline override") {
                        Picker("Pipeline override", selection: bind(\.pipeline)) {
                            Text("Use the runner's pipeline").tag("")
                            Text("Team").tag("team")
                            Text("Native sub-agents").tag("native")
                            Text("Single session").tag("single")
                        }
                        .labelsHidden()
                    }
                    FieldLabel("Reasoning effort") {
                        Picker("Reasoning effort", selection: bind(\.reasoning.effort)) {
                            ForEach(Self.efforts, id: \.0) { Text($0.1).tag($0.0) }
                        }
                        .labelsHidden()
                    }
                    FieldLabel("Web access") {
                        Picker("Web access", selection: bind(\.search.web)) {
                            Text("Follow review.external").tag("inherit")
                            Text("On for every job").tag("on")
                            Text("Off").tag("off")
                        }
                        .labelsHidden()
                    }
                }
                GridRow {
                    FieldLabel("Search freshness") {
                        Picker("Search freshness", selection: bind(\.search.freshness)) {
                            Text("Live web search").tag("live")
                            Text("Cached search index (codex)").tag("cached")
                        }
                        .labelsHidden()
                    }
                    FieldLabel("Search rounds per section") {
                        TextField("3", value: bind(\.search.maxRounds), format: .number)
                    }
                    FieldLabel("Sources per fact") {
                        TextField("1", value: bind(\.verification.minSourcesPerClaim), format: .number)
                    }
                }
                GridRow {
                    FieldLabel("Conflicting sources") {
                        Picker("Conflicting sources", selection: bind(\.verification.resolveConflicts)) {
                            Text("Flag both sides as disputed").tag("flag")
                            Text("Prefer the primary source").tag("prefer_primary")
                            Text("Prefer the most recent").tag("prefer_recent")
                        }
                        .labelsHidden()
                    }
                    FieldLabel("Max sections") {
                        TextField("8", value: bind(\.stop.maxSections), format: .number)
                    }
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                Toggle("Prefer primary sources", isOn: bind(\.verification.preferPrimarySources))
                Toggle("Stop a section when a search round adds nothing new", isOn: bind(\.stop.marginalGain))
                Toggle("Cite a source on every fact", isOn: bind(\.output.citations))
                Toggle("Mark uncertain claims as suspected", isOn: bind(\.output.uncertainty))
                Toggle("Require an evidence table section", isOn: bind(\.output.evidenceTable))
            }
            .toggleStyle(.checkbox)
        }
        .knodeCard(padding: 18)
    }

    // MARK: - Roles

    private var rolesEditor: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Sub-agents").font(.headline)
                    Text("One card per role. Each has its own CLI, model, effort, tools and prompt; turn a role off to skip its phase. Several roles may share a phase — review roles all run, research roles split the sections.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 12)
                Button("Add role") { addRole() }
            }
            if profile?.roles.isEmpty == true {
                Text("No roles. The team pipeline needs at least a synthesize role; single-session mode ignores roles.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .knodeCard()
            }
            ForEach(Array((profile?.roles ?? []).enumerated()), id: \.element.id) { index, role in
                RoleCard(
                    role: roleBinding(index),
                    phaseDefaults: profile?.phaseDefaults ?? [:],
                    connections: connections,
                    researchers: research.researchers,
                    reviewRounds: research.reviewRounds,
                    remove: { removeRole(id: role.id) }
                )
            }
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
    }

    private func removeRole(id: String) {
        guard var draft = profile else { return }
        draft.roles.removeAll { $0.id == id }
        profile = draft
        dirty = true
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
        Picker("Agent", selection: $selection) {
            Text(inheritLabel).tag("")
            ForEach(cliConnections) { connection in
                Text("\(connection.label) · \(providerName(connection.provider))").tag(connection.id)
            }
            ForEach(ResearchSettingsSection.cliProviders, id: \.self) { provider in
                Text("\(providerName(provider)) · from PATH").tag(provider)
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
private struct RoleCard: View {
    @Binding var role: ResearchRole
    let phaseDefaults: [String: String]
    let connections: [LLMConnection]
    let researchers: Int
    let reviewRounds: Int
    let remove: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            head
            grid
            VStack(alignment: .leading, spacing: 6) {
                Toggle("Writes pages (knode_write / knode_commit)", isOn: $role.tools.write)
                Toggle("Reads files (Read / Grep / Glob)", isOn: $role.tools.files)
                Toggle("Native sub-agent (pipeline: native)", isOn: $role.native)
            }
            .toggleStyle(.checkbox)
            prompt
        }
        .knodeCard(padding: 18)
        .opacity(role.enabled ? 1 : 0.55)
    }

    private var head: some View {
        HStack(spacing: 10) {
            Toggle("On", isOn: $role.enabled)
                .toggleStyle(.checkbox)
            TextField("Role title", text: $role.title)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 240)
            Text("\(role.id) · \(role.phase)\(role.native ? " · native" : "")")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(.tertiary)
            Spacer()
            Button(role: .destructive) { remove() } label: { Image(systemName: "trash") }
                .buttonStyle(.borderless)
                .help("Remove this role")
        }
    }

    private var grid: some View {
        Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 12) {
            GridRow {
                FieldLabel("Phase") {
                    Picker("Phase", selection: phaseBinding) {
                        ForEach(ResearchSettingsSection.phases, id: \.0) { Text($0.1).tag($0.0) }
                    }
                    .labelsHidden()
                }
                FieldLabel("Runs on") {
                    AgentPicker(selection: $role.agent, connections: connections, inheritLabel: "The research agent above")
                }
                FieldLabel("Model") {
                    TextField("Agent's model", text: $role.model)
                }
            }
            GridRow {
                FieldLabel("Effort") {
                    Picker("Effort", selection: $role.effort) {
                        Text("Profile default").tag("default")
                        ForEach(ResearchSettingsSection.efforts.dropFirst(), id: \.0) { Text($0.1).tag($0.0) }
                    }
                    .labelsHidden()
                }
                FieldLabel("Web tools") {
                    Picker("Web tools", selection: $role.tools.web) {
                        Text("Profile setting").tag("inherit")
                        Text("On (within review.external)").tag("on")
                        Text("Off").tag("off")
                    }
                    .labelsHidden()
                }
                FieldLabel("Turns per session") {
                    TextField("Default", value: $role.maxTurns, format: .number)
                }
            }
            GridRow {
                if role.phase == "research" {
                    FieldLabel("Parallel sessions") {
                        TextField("\(researchers)", value: $role.parallel, format: .number)
                    }
                } else if role.phase == "review" || role.phase == "revise" {
                    FieldLabel("Rounds") {
                        TextField("\(reviewRounds)", value: $role.rounds, format: .number)
                    }
                }
                FieldLabel("Description") {
                    TextField("One line the orchestrator reads when picking this sub-agent", text: $role.description)
                }
                .gridCellColumns(role.phase == "plan" || role.phase == "synthesize" ? 3 : 2)
            }
        }
    }

    private var prompt: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text("Prompt").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Text("\(role.promptPath)\(role.promptIsDefault ? " · built-in" : "")")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                Spacer()
                Button("Reset to built-in") { resetPrompt() }
                    .buttonStyle(.borderless)
                    .disabled(role.promptIsDefault)
            }
            TextEditor(text: promptBinding)
                .font(.system(size: 11, design: .monospaced))
                .frame(height: 170)
                .padding(6)
                .background(Color(nsColor: .textBackgroundColor).opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
                .overlay { RoundedRectangle(cornerRadius: 8).stroke(Color.white.opacity(0.08)) }
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
