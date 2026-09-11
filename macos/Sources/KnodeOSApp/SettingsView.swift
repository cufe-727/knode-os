import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var config: KnodeConfig?
    @State private var testResult: ConfigTestResponse?
    @State private var statusMessage = ""
    @State private var statusIsError = false
    @State private var isLoading = true
    @State private var isWorking = false
    @State private var defaultExpanded = false
    @State private var showingClearConfirmation = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                hero
                if isLoading && config == nil {
                    ProgressView("Loading model routes…")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 80)
                } else if config != nil {
                    routeSummary
                    embeddingSection
                    extractionSection
                    defaultModelSection
                    if let testResult { testResults(testResult) }
                    if !statusMessage.isEmpty {
                        Label(statusMessage, systemImage: statusIsError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                            .font(.callout)
                            .foregroundStyle(statusIsError ? Color.knodeBad : Color.knodeGood)
                            .knodeCard()
                    }
                    workspaceDangerSection
                } else {
                    EmptyState(symbol: "slider.horizontal.3", title: "Could not load settings", message: "The local service is unavailable. Retry to start it and reload this workspace's routes.", actionTitle: "Retry", action: { Task { await retry() } })
                }
            }
            .padding(28)
            .frame(maxWidth: 1040)
            .frame(maxWidth: .infinity)
        }
        .background(Color(nsColor: .textBackgroundColor).opacity(0.22))
        .task { await load() }
        .onChange(of: model.connectionState) { _, state in
            if case .connected = state, config == nil {
                Task { await load() }
            }
        }
        .confirmationDialog(
            "Clear \(model.activeWorkspace?.displayName ?? "this workspace")?",
            isPresented: $showingClearConfirmation,
            titleVisibility: .visible
        ) {
            Button("Clear workspace", role: .destructive) { Task { await clearWorkspace() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This permanently deletes every file, index, graph, trace, suggestion, and model setting in the workspace. The empty workspace itself remains available.")
        }
    }

    private var hero: some View {
        HStack(alignment: .bottom, spacing: 24) {
            VStack(alignment: .leading, spacing: 8) {
                Eyebrow(text: "Model routing")
                Text("Give each knowledge job the right model.")
                    .font(.system(size: 34, weight: .bold))
                    .tracking(-0.8)
                Text("Configure retrieval, document vision, entity extraction, and concept synthesis independently for \(model.activeWorkspace?.displayName ?? "this workspace").")
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button("Test routes") { Task { await test() } }
                .disabled(config == nil || isWorking)
            Button("Save & apply") { Task { await save() } }
                .buttonStyle(.borderedProminent)
                .tint(.knodeCyan)
                .disabled(config == nil || isWorking)
            if isWorking { ProgressView().controlSize(.small) }
        }
    }

    private var routeSummary: some View {
        HStack(spacing: 0) {
            SummaryRoute(label: "Retrieval", value: embeddingSummary, detail: "Embedding", color: .knodeCyan)
            Divider().frame(height: 54)
            SummaryRoute(label: "Structure", value: routeSummary(\.extraction.entityLlm), detail: "Entity extraction", color: .knodeViolet)
            Divider().frame(height: 54)
            SummaryRoute(label: "Synthesis", value: routeSummary(\.extraction.conceptLlm), detail: "Concept model", color: .knodeViolet)
            Divider().frame(height: 54)
            SummaryRoute(label: "Vision", value: routeSummary(\.extraction.documentLlm), detail: "PDF & image conversion", color: .knodeViolet)
        }
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
        .overlay { RoundedRectangle(cornerRadius: 12).stroke(Color.white.opacity(0.08)) }
    }

    private var embeddingSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionHeader(index: "01 · Retrieval", title: "Embedding model", detail: "Turns every chunk into vectors for semantic and hybrid recall.", badge: "Required", color: .knodeCyan)
            VStack(alignment: .leading, spacing: 14) {
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 12) {
                    GridRow {
                        FieldLabel("Provider") {
                            Picker("Provider", selection: binding(\.embedding.provider)) {
                                Text("Local hashing · offline").tag("local")
                                Text("OpenAI-compatible API").tag("openai")
                            }
                            .labelsHidden()
                        }
                        FieldLabel("Model") {
                            TextField("text-embedding-3-small", text: binding(\.embedding.model))
                                .disabled(config?.embedding.provider == "local")
                        }
                    }
                    GridRow {
                        FieldLabel("Base URL") {
                            TextField("https://api.openai.com/v1", text: binding(\.embedding.baseUrl))
                                .disabled(config?.embedding.provider == "local")
                        }
                        FieldLabel("API key") {
                            SecureField("env:OPENAI_API_KEY", text: binding(\.embedding.apiKey))
                                .disabled(config?.embedding.provider == "local")
                        }
                    }
                    GridRow {
                        FieldLabel("Dimensions") {
                            TextField("Dimensions", value: binding(\.embedding.dimensions), format: .number)
                        }
                        Toggle("Send dimensions with API requests", isOn: binding(\.embedding.sendDimensions))
                            .toggleStyle(.checkbox)
                            .disabled(config?.embedding.provider == "local")
                    }
                }
                Text(config?.embedding.provider == "local"
                    ? "The local hashing embedder is private, offline, and ready immediately."
                    : "Changing the API model or dimensions re-embeds the corpus after saving. Use env:VAR_NAME to keep keys out of the config file.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .knodeCard(padding: 18)
        }
    }

    private var extractionSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionHeader(index: "02 · Knowledge pipeline", title: "Conversion, extraction & synthesis", detail: "Route document vision, fast structure work and deeper concept writing to different models.", badge: "Independent", color: .knodeViolet)
            HStack(alignment: .top, spacing: 14) {
                RouteCard(
                    marker: "A",
                    title: "Entity extraction",
                    detail: "Names entities, relations, and factual claims from changed documents.",
                    route: binding(\.extraction.entityLlm)
                )
                RouteCard(
                    marker: "B",
                    title: "Concept synthesis",
                    detail: "Turns hot entity clusters into readable, linked Concept pages.",
                    route: binding(\.extraction.conceptLlm)
                )
                RouteCard(
                    marker: "C",
                    title: "Document vision",
                    detail: "Converts images and scanned PDF pages into searchable Markdown.",
                    route: binding(\.extraction.documentLlm),
                    allowCursor: false
                )
            }

            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Pipeline controls").font(.headline)
                    Text("Bound background work without changing the selected models.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 10) {
                    GridRow {
                        FieldLabel("Daily token budget") {
                            TextField("Budget", value: binding(\.extraction.dailyTokenBudget), format: .number)
                        }
                        FieldLabel("Documents per pass") {
                            TextField("Batch", value: binding(\.extraction.batchSize), format: .number)
                        }
                        FieldLabel("Parallel calls") {
                            TextField("Concurrency", value: binding(\.extraction.concurrency), format: .number)
                        }
                    }
                }
                Toggle("Extract factual claims alongside entities", isOn: binding(\.extraction.claims))
                    .toggleStyle(.checkbox)
            }
            .knodeCard(padding: 18)
        }
    }

    private var defaultModelSection: some View {
        DisclosureGroup(isExpanded: $defaultExpanded) {
            VStack(alignment: .leading, spacing: 14) {
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 12) {
                    GridRow {
                        FieldLabel("Provider") {
                            Picker("Provider", selection: binding(\.llm.provider)) {
                                Text("OpenAI-compatible API").tag("openai")
                                Text("Codex CLI").tag("codex-cli")
                                Text("Claude Code CLI").tag("claude-cli")
                                Text("Cursor Agent CLI").tag("cursor-cli")
                            }
                            .labelsHidden()
                        }
                        FieldLabel("Model") {
                            TextField(config?.llm.provider == "openai" ? "gpt-4.1-mini" : "Use CLI default", text: binding(\.llm.model))
                        }
                    }
                    if config?.llm.provider == "openai" {
                        GridRow {
                            FieldLabel("Base URL") { TextField("https://api.openai.com/v1", text: binding(\.llm.baseUrl)) }
                            FieldLabel("API key") { SecureField("env:OPENAI_API_KEY", text: binding(\.llm.apiKey)) }
                        }
                    } else {
                        GridRow {
                            FieldLabel("CLI executable") { TextField("Use command from PATH", text: binding(\.llm.cliPath)) }
                        }
                    }
                }
                Text(defaultModelNote)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.top, 14)
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Default reasoning model").font(.headline)
                    Text("Fallback for inherited routes, Ask, Wiki summaries, and Dream analysis")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(defaultModelSummary)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
        }
        .knodeCard(padding: 18)
    }

    private var workspaceDangerSection: some View {
        HStack(spacing: 24) {
            VStack(alignment: .leading, spacing: 5) {
                Eyebrow(text: "Danger zone", color: .knodeBad)
                Text("Clear \(model.activeWorkspace?.displayName ?? "this workspace")")
                    .font(.headline)
                Text("Remove all workspace content and derived data, then leave behind a fresh empty directory tree.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button("Clear workspace", role: .destructive) { showingClearConfirmation = true }
                .buttonStyle(.bordered)
                .tint(.knodeBad)
                .disabled(isWorking)
        }
        .padding(18)
        .background(Color.knodeBad.opacity(0.045), in: RoundedRectangle(cornerRadius: 12))
        .overlay { RoundedRectangle(cornerRadius: 12).stroke(Color.knodeBad.opacity(0.3)) }
    }

    private func testResults(_ result: ConfigTestResponse) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Route test results").font(.headline)
            TestResultRow(label: "Embedding", result: result.embedding)
            TestResultRow(label: "Default model", result: result.llm)
            TestResultRow(label: "Entity route", result: result.entityLlm)
            TestResultRow(label: "Concept route", result: result.conceptLlm)
            TestResultRow(label: "Document vision", result: result.documentLlm)
        }
        .knodeCard()
    }

    private func sectionHeader(index: String, title: String, detail: String, badge: String, color: Color) -> some View {
        HStack(alignment: .bottom) {
            VStack(alignment: .leading, spacing: 3) {
                Eyebrow(text: index, color: color)
                Text(title).font(.title3.bold())
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            RouteBadge(label: badge, color: color)
        }
    }

    private func binding<Value>(_ keyPath: WritableKeyPath<KnodeConfig, Value>) -> Binding<Value> {
        Binding(
            get: { config![keyPath: keyPath] },
            set: { config![keyPath: keyPath] = $0 }
        )
    }

    private var embeddingSummary: String {
        guard let config else { return "Loading…" }
        return config.embedding.provider == "local"
            ? "Local hashing · \(config.embedding.dimensions)d"
            : (config.embedding.model.isEmpty ? "API model not set" : config.embedding.model)
    }

    private func routeSummary(_ keyPath: KeyPath<KnodeConfig, RoutedLLMConfig>) -> String {
        guard let route = config?[keyPath: keyPath] else { return "Loading…" }
        let provider = providerName(route.provider)
        return route.model.isEmpty ? provider : "\(provider) · \(route.model)"
    }

    private var defaultModelSummary: String {
        guard let config else { return "Not configured" }
        return config.llm.model.isEmpty ? providerName(config.llm.provider) : "\(providerName(config.llm.provider)) · \(config.llm.model)"
    }

    private var defaultModelNote: String {
        guard let provider = config?.llm.provider else { return "" }
        return switch provider {
        case "codex-cli": "Uses your existing Codex login for a read-only one-shot request."
        case "claude-cli": "Uses your existing Claude Code login for one non-interactive turn."
        case "cursor-cli": "Uses your existing Cursor Agent login in headless print mode."
        default: "An empty model disables general LLM features while deterministic features remain available."
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            config = try await model.client().config()
            statusMessage = ""
            testResult = nil
        } catch {
            config = nil
            model.showError(error, prefix: "Settings failed")
        }
    }

    private func retry() async {
        await model.checkConnection()
        await load()
    }

    private func test() async {
        guard let config else { return }
        isWorking = true
        statusMessage = "Testing configured routes…"
        statusIsError = false
        defer { isWorking = false }
        do {
            testResult = try await model.client().testConfig(config)
            statusMessage = "Route tests complete"
        } catch {
            statusMessage = "Test failed: \(error.localizedDescription)"
            statusIsError = true
        }
    }

    private func save() async {
        guard let config else { return }
        isWorking = true
        model.globalActivity = "Applying model routes…"
        statusMessage = "Saving routes… re-embedding if retrieval changed."
        statusIsError = false
        defer {
            isWorking = false
            model.globalActivity = nil
        }
        do {
            let response = try await model.client().saveConfig(config)
            self.config = response.config
            if response.reembedded, let reindex = response.reindex {
                statusMessage = "Configuration saved · re-embedded \(reindex.indexed) docs and \(reindex.chunks) chunks"
            } else if response.reconverted == true, let reindex = response.reindex {
                statusMessage = "Configuration saved · refreshed document conversion for \(reindex.indexed) docs"
            } else {
                statusMessage = "Configuration saved and routes applied"
            }
            model.showToast("Configuration saved for \(model.activeWorkspace?.displayName ?? "workspace")")
            await model.refreshStats()
        } catch {
            statusMessage = "Save failed: \(error.localizedDescription)"
            statusIsError = true
        }
    }

    private func clearWorkspace() async {
        isWorking = true
        statusMessage = "Clearing workspace…"
        statusIsError = false
        defer { isWorking = false }
        do {
            try await model.clearActiveWorkspace()
            config = try await model.client().config()
            testResult = nil
            statusMessage = "Workspace cleared. A fresh empty directory tree is ready."
        } catch {
            statusMessage = "Clear failed: \(error.localizedDescription)"
            statusIsError = true
        }
    }
}

private struct SummaryRoute: View {
    let label: String
    let value: String
    let detail: String
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Eyebrow(text: label, color: color)
            Text(value).font(.callout.weight(.semibold)).lineLimit(1)
            Text(detail).font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
    }
}

private struct FieldLabel<Content: View>: View {
    let label: String
    @ViewBuilder let content: Content

    init(_ label: String, @ViewBuilder content: () -> Content) {
        self.label = label
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            content
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: .infinity)
        }
    }
}

private struct RouteCard: View {
    let marker: String
    let title: String
    let detail: String
    @Binding var route: RoutedLLMConfig
    var allowCursor = true

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack(alignment: .top, spacing: 10) {
                Text(marker)
                    .font(.caption.monospaced().bold())
                    .foregroundStyle(Color.knodeViolet)
                    .frame(width: 28, height: 28)
                    .background(Color.knodeViolet.opacity(0.12), in: RoundedRectangle(cornerRadius: 7))
                    .overlay { RoundedRectangle(cornerRadius: 7).stroke(Color.knodeViolet.opacity(0.28)) }
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.headline)
                    Text(detail).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
            FieldLabel("Run with") {
                Picker("Run with", selection: $route.provider) {
                    Text("Default reasoning model").tag("inherit")
                    Text("OpenAI-compatible API").tag("openai")
                    Text("Codex CLI").tag("codex-cli")
                    Text("Claude Code CLI").tag("claude-cli")
                    if allowCursor { Text("Cursor Agent CLI").tag("cursor-cli") }
                }
                .labelsHidden()
            }
            FieldLabel("Model") { TextField(route.provider == "openai" ? "Model name" : "Optional · use provider default", text: $route.model) }
            if route.provider == "openai" {
                FieldLabel("Base URL") { TextField("Inherit default endpoint", text: $route.baseUrl) }
                FieldLabel("API key") { SecureField("Inherit default key", text: $route.apiKey) }
            } else if route.provider != "inherit" {
                FieldLabel("CLI executable") { TextField("Use command from PATH", text: $route.cliPath) }
            }
            Text(routeNote)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(minHeight: 32, alignment: .topLeading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .knodeCard(padding: 18)
    }

    private var routeNote: String {
        switch route.provider {
        case "inherit": "Uses the default provider, endpoint, credentials, and model unless overridden here."
        case "openai": "Endpoint and key may stay empty to reuse the default API connection."
        case "codex-cli": "Runs codex exec with your existing Codex login."
        case "claude-cli": "Runs claude -p with your existing Claude Code login."
        default: "Runs cursor-agent -p with your existing Cursor Agent login."
        }
    }
}

private struct TestResultRow: View {
    let label: String
    let result: RouteTestResult?

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .foregroundStyle(color)
            Text(label).fontWeight(.semibold).frame(width: 120, alignment: .leading)
            Text(detail).foregroundStyle(.secondary)
            Spacer()
        }
        .font(.callout)
        .padding(.vertical, 3)
    }

    private var icon: String {
        guard let result else { return "minus.circle" }
        return result.ok ? "checkmark.circle.fill" : "xmark.circle.fill"
    }

    private var color: Color {
        guard let result else { return .secondary }
        return result.ok ? .knodeGood : .knodeBad
    }

    private var detail: String {
        guard let result else { return "Not tested" }
        if let error = result.error { return error }
        if result.enabled == false { return result.note ?? "Route disabled" }
        var parts: [String] = []
        if result.inherited == true { parts.append("inherited") }
        if let model = result.model { parts.append(model) }
        if let dimensions = result.dimensions { parts.append("\(dimensions)d") }
        if let ms = result.ms { parts.append("\(ms)ms") }
        return parts.isEmpty ? "Connected" : parts.joined(separator: " · ")
    }
}

private func providerName(_ provider: String) -> String {
    switch provider {
    case "inherit": "Default model"
    case "openai": "OpenAI-compatible API"
    case "codex-cli": "Codex CLI"
    case "claude-cli": "Claude Code CLI"
    case "cursor-cli": "Cursor Agent CLI"
    default: provider
    }
}
