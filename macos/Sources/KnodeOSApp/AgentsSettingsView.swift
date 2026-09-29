import SwiftUI

/**
 * Who runs a research job or an Ask turn — the second table on 01, under the
 * models its deepagents agents run on.
 *
 * Every agent is one row, whichever runtime it has: the built-in deepagents
 * loop on one of the models above, or a coding-agent CLI on this machine that
 * brings its own loop, path and model. The CLIs used to sit among the models,
 * which made "cursor" the default *LLM* and let the deep agent quietly run
 * Cursor; an agent is not a model endpoint, so they live here now. What the
 * research itself does — effort bar, verification, roles — stays in section
 * 03 · Research, because that is a property of the research and not of who
 * runs it.
 */
struct AgentsSettingsSection: View {
    @Binding var agents: [AgentDefinition]
    /// Which agent research runs on, so a row can show it is the active one.
    let researchAgent: String
    let chatAgent: String
    /// The model endpoints a deepagents agent can run on.
    let connections: [LLMConnection]
    /// What the default is right now in the draft: a model, or a CLI agent.
    let defaultTarget: LLMConnection?
    let llmUse: String
    let cliTools: [String: CliTool]
    let isWorking: Bool
    /// "deepagents", or the CLI a new agent runs.
    let add: (String) -> Void
    let remove: (AgentDefinition) -> Void
    /// Jobs that name no model run on this CLI agent, one-shot.
    let makeDefault: (String) -> Void
    let loadModels: (AgentDefinition, Bool) async throws -> ModelListResponse

    @State private var expanded: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            if agents.isEmpty {
                EmptyState(
                    symbol: "person.2.badge.gearshape",
                    title: L("No agents yet"),
                    message: L("Add one: deepagents on one of the models above, or a coding-agent CLI on this machine."),
                    actionTitle: L("Add a deepagents agent"),
                    action: { add(Self.deepagents) }
                )
                .knodeCard(padding: 0)
            } else {
                VStack(spacing: 0) {
                    tableHeader
                    ForEach(Array(agents.enumerated()), id: \.element.id) { index, agent in
                        Divider()
                        row(index: index, agent: agent)
                    }
                }
                .knodeCard(padding: 0)
            }
        }
    }

    static let deepagents = "deepagents"

    private var header: some View {
        HStack(alignment: .bottom) {
            VStack(alignment: .leading, spacing: 3) {
                Text(L("Agents")).font(.title3.bold())
                Text(L("Who does the work for Ask and Research: the built-in deepagents loop on one of the models above, or a coding-agent CLI on this machine that brings its own."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            RouteBadge(label: L("Named"), color: .knodeViolet)
        }
    }

    private var tableHeader: some View {
        HStack(spacing: 12) {
            Text(L("Type")).frame(width: 126, alignment: .leading)
            Text(L("Name")).frame(width: 210, alignment: .leading)
            Text(L("Runs on")).frame(width: 200, alignment: .leading)
            Text(L("Model"))
            Spacer(minLength: 8)
            // the button itself adds the common case; the arrow offers the CLIs
            Menu {
                Button(L("deepagents · on the default LLM")) { add(Self.deepagents) }
                Divider()
                ForEach(cliProviderNames, id: \.self) { provider in
                    Button(providerName(provider)) { add(provider) }
                }
            } label: {
                Label(L("Add agent"), systemImage: "plus")
            } primaryAction: {
                add(Self.deepagents)
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .disabled(isWorking)
            .help(L("Adds deepagents on the default LLM; the arrow adds a coding-agent CLI"))
        }
        .font(.system(size: 9, weight: .bold, design: .monospaced))
        .tracking(0.8)
        .foregroundStyle(.tertiary)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private func row(index: Int, agent: AgentDefinition) -> some View {
        let color: Color = agent.isCli ? .knodeCyan : .knodeViolet
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                Button {
                    withAnimation(.easeOut(duration: 0.14)) { toggle(agent.name) }
                } label: {
                    Image(systemName: expanded.contains(agent.name) ? "chevron.down" : "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 14)
                }
                .buttonStyle(.plain)

                RouteBadge(label: typeName(agent), color: color)
                    .frame(width: 100, alignment: .leading)

                TextField(L("Name this agent"), text: $agents[index].title)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 210)

                let target = runsOn(agent)
                HStack(spacing: 4) {
                    Text(target.name).lineLimit(1).truncationMode(.middle)
                    if let note = target.note {
                        Text("· \(note)").foregroundStyle(.tertiary).lineLimit(1).fixedSize()
                    }
                }
                .font(.callout)
                .frame(width: 200, alignment: .leading)
                .help(target.help)

                modelSummary(agent)

                Spacer(minLength: 8)

                // what points at it, on the right so the columns stay lined up
                if agent.isCli && agent.name == llmUse { RouteBadge(label: L("Default"), color: .knodeCyan) }
                if agent.name == researchAgent { RouteBadge(label: L("Research"), color: .knodeViolet) }
                if agent.name == chatAgent { RouteBadge(label: L("Ask"), color: .knodeCyan) }
                if let problem = problem(agent) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(Color.knodeBad)
                        .help(problem)
                }
                Text(agent.name)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.tertiary)
                Button(role: .destructive) { remove(agent) } label: {
                    Image(systemName: agent.builtin ? "arrow.counterclockwise" : "trash")
                }
                .buttonStyle(.borderless)
                .help(agent.builtin ? L("Reset this template to its built-in") : L("Remove this agent"))
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 9)

            if expanded.contains(agent.name) {
                Group {
                    if agent.isCli { cliFields(index: index, agent: agent) } else { deepagentsFields(index: index, agent: agent) }
                }
                .padding(.horizontal, 16)
                .padding(.top, 2)
                .padding(.bottom, 16)
            }
        }
        .background(expanded.contains(agent.name) ? color.opacity(0.04) : Color.clear)
    }

    // MARK: - Forms

    /// The built-in loop runs inside the service on a model from the table
    /// above: which one, and which of its models.
    private func deepagentsFields(index: Int, agent: AgentDefinition) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 12) {
                GridRow {
                    FieldLabel(L("Runs on")) {
                        Picker(L("Runs on"), selection: $agents[index].executor) {
                            Text(defaultOption).tag(ResearchSettingsSection.defaultConnection)
                            ForEach(connections) { connection in
                                Text(connectionName(connection)).tag(connection.id)
                            }
                        }
                        .labelsHidden()
                    }
                    ModelField(
                        placeholder: L("Its own default"),
                        text: $agents[index].model,
                        inherited: modelEndpoint(agent)?.model ?? "",
                        providerKey: agent.executor,
                        route: "agent:\(agent.executor)",
                        load: { refresh in try await loadModels(agents[index], refresh) }
                    )
                }
                GridRow {
                    Text(L("The built-in deepagents loop runs inside the service on this model. It has no reasoning-effort switch and no web tool."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .gridCellColumns(2)
                }
                limitsRow(index: index)
                descriptionRow(index: index)
            }
            toolToggles(index: index)
            promptEditor(index: index, agent: agent)
        }
    }

    /// A CLI brings its own loop: which one, where it is, its model and how
    /// hard it thinks — what the models table used to hold for it.
    private func cliFields(index: Int, agent: AgentDefinition) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 12) {
                GridRow {
                    FieldLabel(L("CLI")) {
                        Picker(L("CLI"), selection: $agents[index].executor) {
                            ForEach(cliProviderNames, id: \.self) { provider in
                                Text(providerName(provider)).tag(provider)
                            }
                        }
                        .labelsHidden()
                    }
                    ModelField(
                        placeholder: L("Use CLI default"),
                        text: $agents[index].model,
                        providerKey: "\(agent.executor)|\(agent.cliPath)",
                        route: "agent:\(agent.executor)",
                        load: { refresh in try await loadModels(agents[index], refresh) }
                    )
                }
                GridRow {
                    FieldLabel(L("Reasoning effort")) {
                        Picker(L("Reasoning effort"), selection: $agents[index].effort) {
                            ForEach(EffortLevel.all, id: \.0) { Text(L($0.1)).tag($0.0) }
                        }
                        .labelsHidden()
                    }
                    FieldLabel(L("Web access")) {
                        Picker(L("Web access"), selection: $agents[index].tools.web) {
                            Text(L("Follow review.external")).tag("inherit")
                            Text(L("On (within review.external)")).tag("on")
                            Text(L("Off")).tag("off")
                        }
                        .labelsHidden()
                    }
                }
                GridRow {
                    CliExecutableField(tool: cliTools[agent.executor], path: $agents[index].cliPath)
                        .gridCellColumns(2)
                }
                GridRow {
                    Text(llmProviderNote(agent.executor))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .gridCellColumns(2)
                }
                limitsRow(index: index)
                descriptionRow(index: index)
            }
            toolToggles(index: index)
            promptEditor(index: index, agent: agent)
            if agent.name != llmUse {
                HStack(spacing: 8) {
                    Button(L("Make default")) { makeDefault(agent.name) }
                        .buttonStyle(.link)
                    Text(L("Jobs that name no model run on this CLI instead, one call at a time — for a machine with no model endpoint."))
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
        }
    }

    private func limitsRow(index: Int) -> some View {
        GridRow {
            FieldLabel(L("Turns per session")) {
                TextField(L("0 = the caller's default"), value: $agents[index].maxTurns, format: .number)
            }
            FieldLabel(L("Timeout (minutes)")) {
                TextField(L("0 = the caller's default"), value: timeoutMinutes(index), format: .number)
            }
        }
    }

    private func descriptionRow(index: Int) -> some View {
        GridRow {
            FieldLabel(L("Description")) {
                TextField(L("When to pick this agent"), text: $agents[index].description)
            }
            .gridCellColumns(2)
        }
    }

    private func toolToggles(index: Int) -> some View {
        HStack(spacing: 18) {
            Toggle(L("Writes pages (knode_write / knode_commit)"), isOn: $agents[index].tools.write)
                .toggleStyle(.checkbox)
            Toggle(L("Reads files (Read / Grep / Glob)"), isOn: $agents[index].tools.files)
                .toggleStyle(.checkbox)
        }
    }

    private func promptEditor(index: Int, agent: AgentDefinition) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(L("System prompt")).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            TextEditor(text: $agents[index].prompt)
                .font(.system(size: 11, design: .monospaced))
                .frame(height: 120)
                .padding(6)
                .background(Color.black.opacity(0.22), in: RoundedRectangle(cornerRadius: 8))
                .overlay { RoundedRectangle(cornerRadius: 8).stroke(Color.white.opacity(0.08)) }
            Text(L("Empty = the protocol the run workspace already carries. Stored at %@.", agent.path))
                .font(.caption2)
                .foregroundStyle(.tertiary)
            // who reads the settings above: saying so beats a form that
            // silently does nothing for one of its two callers
            Text(L("Ask runs with these settings. A research run takes effort, turns, timeout, tools and prompt from its profile in section 03 instead."))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - Row summaries

    private func typeName(_ agent: AgentDefinition) -> String {
        switch agent.executor {
        case "claude-cli": "Claude Code"
        case "codex-cli": "Codex"
        case "cursor-cli": "Cursor"
        default: Self.deepagents
        }
    }

    /// The model endpoint a deepagents agent runs on: the one it pins, or
    /// whatever the default is — which may be a CLI agent, and then is not one.
    private func modelEndpoint(_ agent: AgentDefinition) -> LLMConnection? {
        guard !agent.isCli else { return nil }
        if agent.executor == ResearchSettingsSection.defaultConnection {
            return defaultTarget?.provider == "openai" ? defaultTarget : nil
        }
        return connections.first { $0.id == agent.executor }
    }

    /// Where an agent runs, by the names the tables use: the model a
    /// deepagents agent is on — saying when that is just "the default" — or
    /// where a CLI comes from.
    private func runsOn(_ agent: AgentDefinition) -> (name: String, note: String?, help: String) {
        if agent.isCli {
            if agent.cliPath.isEmpty {
                let found = cliTools[agent.executor]?.path
                return (L("From PATH"), nil, found ?? L("%@ was not found on the service PATH", providerName(agent.executor)))
            }
            return (agent.cliPath, nil, agent.cliPath)
        }
        if agent.executor == ResearchSettingsSection.defaultConnection {
            let name = defaultTarget.map(connectionName) ?? L("Default LLM provider")
            return (name, L("follows default"), L("Follows the default LLM — %@ for now. Make another model the default and this agent moves with it.", name))
        }
        if let connection = connections.first(where: { $0.id == agent.executor }) {
            let name = connectionName(connection)
            return (name, nil, "\(name) · \(connection.baseUrl)")
        }
        return (agent.executor.isEmpty ? L("Not configured") : agent.executor, nil, "")
    }

    /// The model a row runs, without opening it: its own, else what its model
    /// endpoint brings, greyed the way the Model field shows an inherited one.
    private func modelSummary(_ agent: AgentDefinition) -> some View {
        var text = agent.model
        var help = agent.model
        if agent.model.isEmpty {
            if let endpoint = modelEndpoint(agent), !endpoint.model.isEmpty {
                text = endpoint.model
                help = L("Inherited from %@", connectionName(endpoint))
            } else {
                text = agent.isCli ? L("CLI default") : L("Its own default")
            }
        }
        return Text(text)
            .font(.system(size: 11, design: .monospaced))
            .foregroundStyle(agent.model.isEmpty ? .tertiary : .secondary)
            .lineLimit(1)
            .truncationMode(.middle)
            .help(help)
    }

    /// Why this agent cannot run, in words that say what to change.
    private func problem(_ agent: AgentDefinition) -> String? {
        if agent.isCli {
            if agent.cliPath.isEmpty, let tool = cliTools[agent.executor], tool.path == nil {
                return L("%@ was not found on the service PATH — install it or pin a path.", providerName(agent.executor))
            }
            return nil
        }
        if agent.executor == ResearchSettingsSection.defaultConnection, modelEndpoint(agent) == nil {
            return L("deepagents runs on a model, and the default is a CLI agent — pick a model for it.")
        }
        guard let endpoint = modelEndpoint(agent) else { return L("Its executor cannot run here — pick another one.") }
        if endpoint.model.isEmpty && agent.model.isEmpty { return L("%@ has no model set.", connectionName(endpoint)) }
        return nil
    }

    private var defaultOption: String {
        guard let target = defaultTarget else { return L("Follow the default LLM") }
        return L("Follow the default LLM · %@", connectionName(target))
    }

    /// A provider someone cleared the name of still has to be called something.
    private func connectionName(_ connection: LLMConnection) -> String {
        connection.label.trimmingCharacters(in: .whitespaces).isEmpty ? providerName(connection.provider) : connection.label
    }

    /// The config stores milliseconds; nobody thinks in them.
    private func timeoutMinutes(_ index: Int) -> Binding<Int> {
        Binding(
            get: { agents[index].timeoutMs / 60_000 },
            set: { agents[index].timeoutMs = max(0, $0) * 60_000 }
        )
    }

    private func toggle(_ name: String) {
        if expanded.contains(name) { expanded.remove(name) } else { expanded.insert(name) }
    }
}
