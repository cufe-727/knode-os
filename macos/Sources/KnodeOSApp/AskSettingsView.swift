import SwiftUI

/// Settings · Ask: which agent answers, and the two things about a
/// conversation that are not properties of that agent. Its model, effort and
/// web access belong to the agent, under Providers & Agents; the turn cap,
/// timeout and tools are the same whichever agent answers.
///
/// This used to be a card on the Research tab. Research is how knowledge gets
/// written and Ask is how it gets used, so each has a tab of its own.
struct AskSettingsSection: View {
    @Binding var chat: ChatConfig
    /// The named agents from Providers & Agents, so the picker can offer them.
    let agents: [AgentDefinition]
    /// The models and the CLI agents (see `llmTargets`), for naming a spec
    /// written before agents existed.
    let connections: [LLMConnection]
    /// What the default is in the draft, for a legacy `default` selection.
    let defaultTarget: LLMConnection?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 3) {
                Text(L("How questions get answered")).font(.title3.bold())
                Text(L("Ask answers over MCP with an agent from Providers & Agents, and writes what you teach it as a quarantined note."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: 14) {
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 12) {
                    GridRow {
                        FieldLabel(L("Agent")) {
                            AgentPicker(selection: $chat.agent, agents: agents, connections: connections, fallbackLabel: L("The research agent, else the default provider"), defaultName: defaultTarget?.label ?? "")
                        }
                        FieldLabel(L("Messages replayed")) {
                            TextField("12", value: $chat.historyTurns, format: .number)
                        }
                        FieldLabel(L("Conversations kept")) {
                            TextField("200", value: $chat.keep, format: .number)
                        }
                    }
                }
                Text(L("Model, effort and web access come from the agent — edit it under Providers & Agents. The turn cap, timeout and tools are the same whichever agent answers."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(L("Every reply is a fresh session that replays the recent messages — there is no CLI session to resume, so a long conversation costs more input each turn."))
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .knodeCard(padding: 18)
        }
    }
}
