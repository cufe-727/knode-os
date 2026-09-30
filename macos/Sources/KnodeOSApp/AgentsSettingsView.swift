import SwiftUI

/**
 * Who runs a research job or an Ask turn — the second table on Providers &
 * Agents, under the models its deepagents agents run on.
 *
 * Every agent is one row, whichever runtime it has: the built-in deepagents
 * loop on one of the models above, or a coding-agent CLI on this machine that
 * brings its own loop, path and model. The CLIs used to sit among the models,
 * which made "cursor" the default *LLM* and let the deep agent quietly run
 * Cursor; an agent is not a model endpoint, so they live here now. What the
 * research itself does — effort bar, verification, roles — stays on the
 * Research tab, because that is a property of the research and not of who
 * runs it.
 *
 * So an agent's form is short: who runs, on what model, how hard a CLI
 * thinks and whether Ask may give it the web. It used to hold a turn cap, a
 * timeout, tools, a prompt and a description too — only Ask read them, and
 * Ask now runs every agent the same way — and a "Make default" link: a
 * workspace with no model makes its first CLI agent the default by itself.
 */
struct AgentsSettingsSection: View {
    @Binding var agents: [AgentDefinition]
    /// What runs on each agent — Default, Pipeline, Research, Ask — by agent
    /// name. SettingsView works it out, because the models table needs the
    /// same resolution for its own badges.
    let uses: [String: [RowUse]]
    /// The model endpoints a deepagents agent can run on.
    let connections: [LLMConnection]
    /// What the default is right now in the draft: a model, or a CLI agent.
    let defaultTarget: LLMConnection?
    let cliTools: [String: CliTool]
    let isWorking: Bool
    /// "deepagents", or the CLI a new agent runs.
    let add: (String) -> Void
    let remove: (AgentDefinition) -> Void
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
        VStack(alignment: .leading, spacing: 3) {
            Text(L("Agents")).font(.title3.bold())
            Text(L("Who does the work for Ask and Research: the built-in deepagents loop on one of the models above, or a coding-agent CLI on this machine that brings its own."))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var tableHeader: some View {
        HStack(spacing: 12) {
            // the same give as the rows below (see `row`)
            Text(L("Type")).frame(width: 126, alignment: .leading)
            Text(L("Name")).frame(minWidth: 150, maxWidth: 210, alignment: .leading).layoutPriority(1)
            Text(L("Runs on")).frame(minWidth: 120, maxWidth: 200, alignment: .leading)
            Text(L("Model")).lineLimit(1)
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

                // the name and "runs on" give way first in a narrow window,
                // as they do in the models table, so the badges and the
                // trash button stay whole
                TextField(L("Name this agent"), text: $agents[index].title)
                    .textFieldStyle(.roundedBorder)
                    .frame(minWidth: 150, maxWidth: 210)
                    .layoutPriority(1)

                let target = runsOn(agent)
                HStack(spacing: 4) {
                    Text(target.name).lineLimit(1)
                    if let note = target.note {
                        Text("· \(note)").foregroundStyle(.tertiary).lineLimit(1).fixedSize()
                    }
                }
                .font(.callout)
                .frame(minWidth: 120, maxWidth: 200, alignment: .leading)
                .help(target.help)

                modelSummary(agent)

                Spacer(minLength: 8)

                // what points at it, on the right so the columns stay lined up
                RowUseBadges(uses: uses[agent.name] ?? [])
                if let problem = problem(agent) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(Color.knodeBad)
                        .help(problem)
                }
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
        }
    }

    /// A CLI brings its own loop: which one, its model, how hard it thinks and
    /// whether Ask may give it the web — and where it is, when that is needed.
    private func cliFields(index: Int, agent: AgentDefinition) -> some View {
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
                // how hard and how fast sit at the model's end, as everywhere
                // a model runs on a CLI
                ModelField(
                    placeholder: L("Use CLI default"),
                    text: $agents[index].model,
                    providerKey: "\(agent.executor)|\(agent.cliPath)",
                    route: "agent:\(agent.executor)",
                    load: { refresh in try await loadModels(agents[index], refresh) },
                    tuning: ModelTuning(effort: $agents[index].effort, speed: $agents[index].speed, runtime: agent.executor)
                )
            }
            GridRow {
                FieldLabel(L("Web access")) {
                    Picker(L("Web access"), selection: $agents[index].tools.web) {
                        Text(L("Follow review.external")).tag("inherit")
                        Text(L("On (within review.external)")).tag("on")
                        Text(L("Off")).tag("off")
                    }
                    .labelsHidden()
                }
            }
            if needsPath(agent) {
                GridRow {
                    CliExecutableField(tool: cliTools[agent.executor], path: $agents[index].cliPath)
                        .gridCellColumns(2)
                }
            }
        }
    }

    /// A CLI the service finds on PATH needs no path, and the row's hover
    /// already says where it is. The field shows when it is missing, or when a
    /// path is pinned — which then offers the way back to PATH.
    private func needsPath(_ agent: AgentDefinition) -> Bool {
        !agent.cliPath.isEmpty || cliTools[agent.executor].map { $0.path == nil } ?? false
    }

    // MARK: - Row summaries

    private func typeName(_ agent: AgentDefinition) -> String {
        cliProductName(agent.executor) ?? Self.deepagents
    }

    private func modelEndpoint(_ agent: AgentDefinition) -> LLMConnection? {
        agentEndpoint(agent, connections: connections, defaultTarget: defaultTarget)
    }

    /// Where an agent runs, by the names the tables use: the model a
    /// deepagents agent is on — saying when that is just "the default" — or,
    /// for a CLI, the account it is signed in with. A CLI brings its own
    /// login, so what it spends is that account's subscription, not a model
    /// above; where its binary lives is a hover away, and in the form.
    private func runsOn(_ agent: AgentDefinition) -> (name: String, note: String?, help: String) {
        if agent.isCli {
            let name = L("Your %@ subscription", typeName(agent))
            guard let path = agent.cliPath.isEmpty ? cliTools[agent.executor]?.path : agent.cliPath else {
                return (name, nil, L("%@ was not found on the service PATH", providerName(agent.executor)))
            }
            return (name, nil, L("Uses the account %@ is signed in to, so usage counts against that subscription rather than a model above.", path))
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
        // the effort and Fast a CLI agent sets, the way its model field's chip shows them
        let effort = agent.isCli && agent.effort != "default" ? EffortLevel.name(agent.effort) : nil
        let fast = agent.isCli && agent.speed == "fast"
        return HStack(spacing: 4) {
            Text(text)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(agent.model.isEmpty ? .tertiary : .secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            if effort != nil || fast {
                HStack(spacing: 2) {
                    if fast { Image(systemName: "bolt.fill").font(.system(size: 8, weight: .bold)) }
                    if let effort { Text(effort) }
                }
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .fixedSize()
            }
        }
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

    private func toggle(_ name: String) {
        if expanded.contains(name) { expanded.remove(name) } else { expanded.insert(name) }
    }
}

/// The model endpoint a deepagents agent runs on: the one it pins, or the
/// default while the default is a model. nil for a CLI agent — it brings its
/// own — and for one following a default that is a CLI agent, which cannot
/// run until it names a model (the service's `builtinOnly`).
@MainActor
func agentEndpoint(_ agent: AgentDefinition, connections: [LLMConnection], defaultTarget: LLMConnection?) -> LLMConnection? {
    guard !agent.isCli else { return nil }
    if agent.executor == ResearchSettingsSection.defaultConnection {
        return defaultTarget?.provider == "openai" ? defaultTarget : nil
    }
    return connections.first { $0.id == agent.executor }
}
