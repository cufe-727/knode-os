import SwiftUI

func canonicalEmbeddingModel(_ name: String) -> String {
    ["bge-m3", "baai/bge-m3", "@cf/baai/bge-m3"].contains(name.lowercased()) ? "bge-m3" : name
}

func embeddingMatchesPool(_ entry: EmbeddingConnection, _ pool: EmbeddingPoolConfig) -> Bool {
    guard entry.enabled != false, entry.provider == "openai" else { return false }
    let canonical = canonicalEmbeddingModel(pool.model)
    let hasModel = ([entry.model] + (entry.catalog ?? [])).contains { canonicalEmbeddingModel($0) == canonical }
    return hasModel && (canonical == "bge-m3" ? pool.dimensions == 1024 : entry.model == pool.model && entry.dimensions == pool.dimensions)
}

/// Model choice belongs to the workspace; account budgets survive workspace changes.
struct EmbeddingRoutingSection: View {
    @EnvironmentObject private var app: AppModel
    @Binding var config: KnodeConfig?
    @State private var usage: [EmbeddingUsage] = []
    @State private var status = ""
    @State private var working = false
    @State private var showUsage = false

    private var pool: Binding<EmbeddingPoolConfig> {
        Binding(get: { config?.embeddingPool ?? EmbeddingPoolConfig() }, set: { config?.embeddingPool = $0 })
    }
    private var entries: [EmbeddingConnection] { config?.embeddingProviders ?? [] }
    private var members: [EmbeddingConnection] { entries.filter { embeddingMatchesPool($0, pool.wrappedValue) } }
    private var models: [String] {
        Array(Set(entries.flatMap { [$0.model] + ($0.catalog ?? []) }.filter { !$0.isEmpty }.map(canonicalEmbeddingModel))).sorted()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Label(L("Embedding model pool"), systemImage: "arrow.triangle.branch")
                    .font(.headline).foregroundStyle(Color.knodeCyan)
                Spacer()
                Toggle(L("Automatic routing"), isOn: pool.enabled).toggleStyle(.switch)
            }
            Text(L("Choose one model. Compatible keys share the work; lower priorities run first, equal priorities rotate. Rate-limited or unavailable keys cool down automatically."))
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack(alignment: .top, spacing: 16) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(L("Pool model")).font(.caption).foregroundStyle(.secondary)
                    HStack {
                        TextField("bge-m3", text: pool.model)
                        Menu {
                            ForEach(models, id: \.self) { name in
                                Button(name) {
                                    pool.wrappedValue.model = name
                                    if name == "bge-m3" { pool.wrappedValue.dimensions = 1024 }
                                }
                            }
                        } label: { Image(systemName: "chevron.down") }.menuStyle(.borderlessButton).fixedSize()
                    }
                }
                VStack(alignment: .leading, spacing: 5) {
                    Text(L("Dimensions")).font(.caption).foregroundStyle(.secondary)
                    TextField("1024", value: pool.dimensions, format: .number)
                }.frame(width: 95)
                VStack(alignment: .leading, spacing: 5) {
                    Text(L("Texts per request")).font(.caption).foregroundStyle(.secondary)
                    TextField("16", value: pool.batchSize, format: .number)
                }.frame(width: 115)
            }
            .disabled(!pool.wrappedValue.enabled)
            HStack {
                Text(L("%@ compatible keys · %@ configured", String(members.count), String(entries.count)))
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(members.isEmpty && pool.wrappedValue.enabled ? Color.orange : Color.secondary)
                Spacer()
                Button(L("Refresh all models")) { Task { await refreshModels() } }
                Button(L("Test pool")) { Task { await test() } }.disabled(!pool.wrappedValue.enabled)
                Button(L("Refresh usage")) { Task { await refreshUsage() } }
            }.disabled(working)
            if !status.isEmpty { Text(status).font(.caption).textSelection(.enabled) }
            Text(L("Pool vectors are L2-normalized. Only matching models and dimensions participate. Changing the pool model re-embeds the workspace; changing keys or limits does not."))
                .font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            DisclosureGroup(L("Usage today · shared across workspaces"), isExpanded: $showUsage) {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(entries.filter { $0.provider == "openai" }) { entry in
                        usageRow(entry)
                    }
                    Text(L("App usage persists across restarts. Tokens use provider usage when available, otherwise a conservative estimate. Activity in other apps is not included. Zero limits block requests."))
                        .font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }.padding(.top, 8)
            }.font(.caption)
        }
        .padding(18)
        .background(Color.knodeCyan.opacity(0.045), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.knodeCyan.opacity(0.2)))
        .task { await refreshUsage() }
    }

    private func usageRow(_ entry: EmbeddingConnection) -> some View {
        let row = usage.first { $0.id == entry.id }
        let limits = entry.limits ?? EmbeddingLimits()
        let cooling = (row?.cooldownUntil ?? 0) > Date().timeIntervalSince1970 * 1000
        return HStack(spacing: 12) {
            Circle().fill(entry.enabled == false ? Color.gray : cooling ? Color.orange : Color.knodeCyan).frame(width: 6, height: 6)
            Text(entry.label).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
            Text("\(row?.requestsToday ?? 0) / \(limits.requestsPerDay) req")
            Text("\(row?.tokensToday ?? 0) / \(limits.tokensPerDay) tokens")
            Text(cooling ? L("Cooling down") : limits.resetTimezone).foregroundStyle(.secondary)
        }.font(.system(size: 10, design: .monospaced)).help(row?.lastError ?? entry.limitNote ?? "")
    }

    private func refreshUsage() async {
        do { usage = try await app.client().embeddingUsage().entries }
        catch { status = error.localizedDescription }
    }

    private func refreshModels() async {
        guard let draft = config else { return }
        working = true
        defer { working = false }
        var successes = 0
        var failures: [String] = []
        for entry in draft.embeddingProviders where entry.provider == "openai" {
            status = L("Loading models: %@", entry.label)
            do {
                let result = try await app.client().listModels(route: "embedding:\(entry.id)", config: draft, refresh: true)
                if result.ok, let index = config?.embeddingProviders.firstIndex(where: { $0.id == entry.id }) {
                    config?.embeddingProviders[index].catalog = result.models.map(\.id)
                    successes += 1
                } else { failures.append(entry.label) }
            } catch { failures.append(entry.label) }
        }
        status = L("Refreshed %@ keys. Save & apply to keep the catalog.", String(successes))
        if !failures.isEmpty { status += " · " + L("Unavailable") + ": " + failures.joined(separator: ", ") }
    }

    private func test() async {
        guard let draft = config else { return }
        working = true
        defer { working = false }
        do {
            let response = try await app.client().testEmbedding(draft)
            status = response.ok ? L("Pool test passed · %@ dimensions · %@ ms", String(response.dimensions ?? 0), String(response.ms ?? 0)) : response.error ?? L("Unavailable")
        } catch { status = error.localizedDescription }
        await refreshUsage()
    }
}

struct EmbeddingKeyRoutingFields: View {
    @Binding var entry: EmbeddingConnection
    let load: (Bool) async throws -> ModelListResponse
    let test: () async throws -> EmbeddingTestResponse
    @State private var status = ""
    @State private var working = false

    private var limits: Binding<EmbeddingLimits> {
        Binding(get: { entry.limits ?? EmbeddingLimits() }, set: { entry.limits = $0 })
    }
    private func optional<Value>(_ keyPath: WritableKeyPath<EmbeddingConnection, Value?>, _ fallback: Value) -> Binding<Value> {
        Binding(get: { entry[keyPath: keyPath] ?? fallback }, set: { entry[keyPath: keyPath] = $0 })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Divider()
            HStack {
                Toggle(L("Include in model pools"), isOn: optional(\.enabled, true)).toggleStyle(.checkbox)
                Spacer()
                Text(L("Priority · lower first")).font(.caption).foregroundStyle(.secondary)
                TextField("10", value: optional(\.priority, 10), format: .number).frame(width: 65)
                Button(L("Test key")) { Task { await testKey() } }.disabled(working)
            }
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], alignment: .leading, spacing: 10) {
                numberField("Requests / minute", limits.requestsPerMinute)
                numberField("Tokens / minute", limits.tokensPerMinute)
                numberField("Concurrent requests", limits.concurrency)
                numberField("Requests / day", limits.requestsPerDay)
                numberField("Tokens / day", limits.tokensPerDay)
                VStack(alignment: .leading, spacing: 4) {
                    Text(L("Daily reset timezone")).font(.caption).foregroundStyle(.secondary)
                    TextField("UTC", text: limits.resetTimezone)
                }
            }
            HStack(alignment: .top, spacing: 16) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(L("Shared account quota group")).font(.caption).foregroundStyle(.secondary)
                    TextField(L("Same account → same group"), text: optional(\.quotaGroup, ""))
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(L("OpenRouter upstream (optional)")).font(.caption).foregroundStyle(.secondary)
                    TextField("deepinfra/fp32", text: optional(\.upstream, ""))
                }
            }
            if let note = entry.limitNote, !note.isEmpty {
                Text(note).font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Text(L("Available embedding models · %@", String(entry.catalog?.count ?? 0))).font(.caption).bold()
                Spacer()
                Button(L("Refresh models")) { Task { await refresh() } }.disabled(working)
            }
            if let catalog = entry.catalog, !catalog.isEmpty {
                Text(catalog.joined(separator: "   ·   ")).font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            } else {
                Text(L("Refresh to list this key's embedding models. You can also enter its model ID above."))
                    .font(.caption2).foregroundStyle(.secondary)
            }
            if !status.isEmpty { Text(status).font(.caption).textSelection(.enabled) }
        }
    }

    private func numberField(_ title: String, _ binding: Binding<Int>) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(L(title)).font(.caption).foregroundStyle(.secondary)
            TextField("0", value: binding, format: .number)
        }
    }
    private func refresh() async {
        working = true; defer { working = false }
        do {
            let result = try await load(true)
            if result.ok { entry.catalog = result.models.map(\.id); status = L("Catalog updated. Save & apply to keep it.") }
            else { status = result.error ?? result.note ?? L("Unavailable") }
        } catch { status = error.localizedDescription }
    }
    private func testKey() async {
        working = true; defer { working = false }
        do {
            let result = try await test()
            status = result.ok ? L("Key test passed · %@ dimensions", String(result.dimensions ?? 0)) : result.error ?? L("Unavailable")
        } catch { status = error.localizedDescription }
    }
}
