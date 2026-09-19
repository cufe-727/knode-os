import SwiftUI

/**
 * 03 · Agents — who runs a research job or a chat turn.
 *
 * One row per agent, opening to its own form, the same shape as the providers
 * table above. Two templates ship: a general deep agent (the in-process
 * LangChain deepagents loop) and a deep-research agent (the phases and
 * sub-agents a wiki page is written by). What the research itself does —
 * effort bar, verification, roles — stays in section 04, because that is a
 * property of the research and not of who runs it.
 */
struct AgentsSettingsSection: View {
    @Binding var agents: [AgentDefinition]
    /// Which agent research runs on, so a row can show it is the active one.
    let researchAgent: String
    let chatAgent: String
    let connections: [LLMConnection]
    let cliTools: [String: CliTool]
    let isWorking: Bool
    let add: (String) -> Void
    let remove: (AgentDefinition) -> Void
    let loadModels: (String, Bool) async throws -> ModelListResponse

    @State private var expanded: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            if agents.isEmpty {
                EmptyState(
                    symbol: "person.2.badge.gearshape",
                    title: L("No agents yet"),
                    message: L("Add one from a template: a general deep agent for Chat, or a deep-research agent that writes wiki pages."),
                    actionTitle: L("Add a general agent"),
                    action: { add("general") }
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

    private var header: some View {
        HStack(alignment: .bottom) {
            VStack(alignment: .leading, spacing: 3) {
                Eyebrow(text: L("03 · Agents"), color: .knodeViolet)
                Text(L("Who does the work")).font(.title3.bold())
                Text(L("An agent is an executor with a name: a coding-agent CLI on this machine, or an OpenAI-compatible connection running the built-in deep agent. Research and Chat below point at one."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            // A descriptor, like "Configure once" and "Per stage" above it —
            // the action lives on the table header's button.
            RouteBadge(label: L("Named"), color: .knodeViolet)
        }
    }

    private var tableHeader: some View {
        HStack(spacing: 12) {
            Text(L("Kind")).frame(width: 118, alignment: .leading)
            Text(L("Name")).frame(width: 210, alignment: .leading)
            Text(L("Runs on")).frame(width: 170, alignment: .leading)
            Text(L("Model"))
            Spacer(minLength: 8)
            Menu {
                Button(L("General agent")) { add("general") }
                Button(L("Deep research agent")) { add("deep-research") }
            } label: {
                Label(L("Add agent"), systemImage: "plus")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .disabled(isWorking)
        }
        .font(.system(size: 9, weight: .bold, design: .monospaced))
        .tracking(0.8)
        .foregroundStyle(.tertiary)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private func row(index: Int, agent: AgentDefinition) -> some View {
        let deep = agent.kind == "deep-research"
        let color: Color = deep ? .knodeViolet : .knodeCyan
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

                RouteBadge(label: deep ? L("Deep research") : L("General"), color: color)
                    .frame(width: 100, alignment: .leading)

                TextField(L("Name this agent"), text: $agents[index].title)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 210)

                if agent.name == researchAgent { RouteBadge(label: L("Research"), color: .knodeViolet) }
                if agent.name == chatAgent { RouteBadge(label: L("Ask"), color: .knodeCyan) }

                Text(executorName(agent.executor))
                    .font(.callout)
                    .frame(width: 170, alignment: .leading)
                    .lineLimit(1)

                Text(agent.model.isEmpty ? L("Its own default") : agent.model)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(agent.model.isEmpty ? .tertiary : .secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)

                Spacer(minLength: 8)

                if !agent.runnable {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(Color.knodeBad)
                        .help(L("Its executor cannot run here — pick another one."))
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
                fields(index: index, agent: agent, color: color)
                    .padding(.horizontal, 16)
                    .padding(.top, 2)
                    .padding(.bottom, 16)
            }
        }
        .background(expanded.contains(agent.name) ? color.opacity(0.04) : Color.clear)
    }

    @ViewBuilder
    private func fields(index: Int, agent: AgentDefinition, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 12) {
                GridRow {
                    FieldLabel(L("Runs on")) {
                        Picker(L("Runs on"), selection: $agents[index].executor) {
                            Text(L("Default LLM provider")).tag("default")
                            ForEach(["claude-cli", "codex-cli", "cursor-cli"], id: \.self) { provider in
                                Text(L("%@ · from PATH", providerName(provider))).tag(provider)
                            }
                            ForEach(connections) { connection in
                                Text(connection.label).tag(connection.id)
                            }
                        }
                        .labelsHidden()
                    }
                    ModelField(
                        placeholder: L("Its own default"),
                        text: $agents[index].model,
                        providerKey: agent.executor,
                        route: "agent:\(agent.executor)",
                        load: { refresh in try await loadModels(agent.executor, refresh) }
                    )
                }
                GridRow {
                    Text(runtimeNote(agent))
                        .font(.caption)
                        .foregroundStyle(deep(agent) ? Color.knodeBad.opacity(0.85) : .secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .gridCellColumns(2)
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
                .disabled(deep(agent))
                GridRow {
                    FieldLabel(L("Turns per session")) {
                        TextField(L("0 = the caller's default"), value: $agents[index].maxTurns, format: .number)
                    }
                    FieldLabel(L("Timeout (minutes)")) {
                        TextField(L("0 = the caller's default"), value: timeoutMinutes(index), format: .number)
                    }
                }
                .disabled(deep(agent))
                GridRow {
                    FieldLabel(L("Description")) {
                        TextField(L("When to pick this agent"), text: $agents[index].description)
                    }
                    .gridCellColumns(2)
                }
            }
            HStack(spacing: 18) {
                Toggle(L("Writes pages (knode_write / knode_commit)"), isOn: $agents[index].tools.write)
                    .toggleStyle(.checkbox)
                Toggle(L("Reads files (Read / Grep / Glob)"), isOn: $agents[index].tools.files)
                    .toggleStyle(.checkbox)
            }
            .disabled(deep(agent))
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
            }
            .disabled(deep(agent))
        }
    }

    private func deep(_ agent: AgentDefinition) -> Bool { agent.kind == "deep-research" }

    /// Who actually reads the settings below. A deep-research agent contributes
    /// only its executor and model: the runner takes everything else from the
    /// profile, which is a property of the research and not of who runs it.
    /// Saying so is better than a form that silently does nothing.
    private func runtimeNote(_ agent: AgentDefinition) -> String {
        deep(agent)
            ? L("A research run takes effort, turns, timeout, tools and prompt from its profile in section 03 — these do not apply to a deep-research agent yet.")
            : L("These apply when this agent answers directly, which today means Ask.")
    }

    /// The config stores milliseconds; nobody thinks in them.
    private func timeoutMinutes(_ index: Int) -> Binding<Int> {
        Binding(
            get: { agents[index].timeoutMs / 60_000 },
            set: { agents[index].timeoutMs = max(0, $0) * 60_000 }
        )
    }

    private func executorName(_ executor: String) -> String {
        if executor == "default" { return L("Default LLM provider") }
        if let connection = connections.first(where: { $0.id == executor }) { return connection.label }
        return providerName(executor)
    }

    private func toggle(_ name: String) {
        if expanded.contains(name) { expanded.remove(name) } else { expanded.insert(name) }
    }
}
