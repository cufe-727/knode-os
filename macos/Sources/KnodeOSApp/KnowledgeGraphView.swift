import SwiftUI

struct KnowledgeGraphView: View {
    @EnvironmentObject private var model: AppModel
    @State private var query = ""
    @State private var depth = 2
    @State private var graph: GraphResponse?
    @State private var selectedNodeID: String?
    @State private var insights: GraphInsights?
    @State private var isLoading = true
    @State private var showingInsights = false

    private var selectedNode: GraphNode? {
        graph?.nodes.first(where: { $0.id == selectedNodeID })
    }

    var body: some View {
        VStack(spacing: 0) {
            graphBar
            Divider()
            if isLoading && graph == nil {
                ProgressView("Building graph view…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let graph, !graph.nodes.isEmpty {
                HSplitView {
                    ZStack(alignment: .bottomLeading) {
                        GraphCanvas(nodes: graph.nodes, edges: graph.edges, selectedID: selectedNodeID) { node in
                            selectedNodeID = node.id
                        }
                        graphLegend
                            .padding(14)
                    }
                    .frame(minWidth: 500, maxWidth: .infinity, maxHeight: .infinity)
                    entityPanel(graph)
                        .frame(minWidth: 330, idealWidth: 390, maxWidth: 480)
                }
            } else {
                EmptyState(
                    symbol: "point.3.connected.trianglepath.dotted",
                    title: "The graph is empty",
                    message: "Index documents with wikilinks or configure entity extraction to create nodes and relations.",
                    actionTitle: "Go to Files",
                    action: { model.selectedSection = .files }
                )
            }
        }
        .background(Color(nsColor: .textBackgroundColor).opacity(0.22))
        .task { await loadGraph() }
        .sheet(isPresented: $showingInsights) {
            InsightsSheet(insights: insights)
        }
    }

    private var graphBar: some View {
        HStack(spacing: 10) {
            Image(systemName: "point.3.connected.trianglepath.dotted")
                .foregroundStyle(Color.knodeViolet)
            TextField("Graph search — entity, product, concept…", text: $query)
                .textFieldStyle(.plain)
                .font(.title3)
                .onSubmit { Task { await loadGraph() } }
            Picker("Depth", selection: $depth) {
                Text("1 hop").tag(1)
                Text("2 hops").tag(2)
                Text("3 hops").tag(3)
            }
            .frame(width: 110)
            Button("Explore") { Task { await loadGraph() } }
                .buttonStyle(.borderedProminent)
                .tint(.knodeViolet)
                .disabled(isLoading)
            Button("Insights", systemImage: "chart.bar.xaxis") { Task { await loadInsights() } }
                .disabled(isLoading)
            if isLoading { ProgressView().controlSize(.small) }
        }
        .padding(.horizontal, 18)
        .frame(height: 60)
        .background(.bar)
    }

    private var graphLegend: some View {
        HStack(spacing: 10) {
            ForEach(["person", "organization", "technology", "concept"], id: \.self) { type in
                HStack(spacing: 4) {
                    Circle().fill(nodeColor(type)).frame(width: 7, height: 7)
                    Text(type).font(.caption2)
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(.thickMaterial, in: Capsule())
    }

    private func entityPanel(_ graph: GraphResponse) -> some View {
        VStack(spacing: 0) {
            if let selectedNode {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        RouteBadge(label: selectedNode.type, color: nodeColor(selectedNode.type))
                        Spacer()
                        Text("\(selectedNode.mentionCount) mentions")
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                    }
                    Text(selectedNode.name).font(.title2.bold())
                    if !selectedNode.description.isEmpty {
                        Text(selectedNode.description).font(.callout).foregroundStyle(.secondary)
                    }
                    Button("Explore from this entity", systemImage: "arrow.triangle.branch") {
                        query = selectedNode.name
                        Task { await loadGraph() }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.knodeViolet)
                    .controlSize(.small)
                }
                .padding(16)
                .background(Color.knodeViolet.opacity(0.07))
                Divider()
            }

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text("Entities").font(.headline)
                        Spacer()
                        Text("\(graph.nodes.count) nodes · \(graph.edges.count) relations")
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                    }
                    ForEach(graph.nodes.prefix(40)) { node in
                        Button { selectedNodeID = node.id } label: {
                            VStack(alignment: .leading, spacing: 6) {
                                HStack {
                                    RouteBadge(label: node.type, color: nodeColor(node.type))
                                    Text(node.name).font(.callout.weight(.semibold)).lineLimit(1)
                                    Spacer()
                                    Text(node.score, format: .number.precision(.fractionLength(2)))
                                        .font(.caption2.monospaced())
                                        .foregroundStyle(.secondary)
                                }
                                if !node.description.isEmpty {
                                    Text(node.description).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                }
                                ForEach(claims(for: node).prefix(2)) { claim in
                                    Label(claim.statement, systemImage: "seal")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(2)
                                }
                            }
                            .padding(11)
                            .contentShape(Rectangle())
                            .background(selectedNodeID == node.id ? Color.knodeViolet.opacity(0.12) : Color.white.opacity(0.025), in: RoundedRectangle(cornerRadius: 9))
                            .overlay { RoundedRectangle(cornerRadius: 9).stroke(Color.white.opacity(0.07)) }
                        }
                        .buttonStyle(.plain)
                    }

                    if !graph.chunks.isEmpty {
                        Divider().padding(.vertical, 8)
                        Text("Grounded in").font(.headline)
                        ForEach(graph.chunks) { chunk in
                            Button { model.openFile(chunk.path) } label: {
                                Label(chunk.path, systemImage: "doc.text")
                                    .font(.caption.monospaced())
                                    .lineLimit(1)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(Color.knodeCyan)
                        }
                    }
                }
                .padding(14)
            }
        }
        .background(.ultraThinMaterial)
    }

    private func claims(for node: GraphNode) -> [Claim] {
        (graph?.claims ?? []).filter { $0.subject == node.name }
    }

    private func loadGraph() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let response = try await model.client().graph(query: query.trimmingCharacters(in: .whitespacesAndNewlines), depth: depth)
            graph = response
            selectedNodeID = response.nodes.first?.id
            await model.refreshStats()
        } catch {
            graph = nil
            selectedNodeID = nil
            model.showError(error, prefix: "Graph failed")
        }
    }

    private func loadInsights() async {
        isLoading = true
        defer { isLoading = false }
        do {
            insights = try await model.client().graphInsights()
            showingInsights = true
        } catch {
            model.showError(error, prefix: "Insights failed")
        }
    }
}

private struct GraphCanvas: View {
    let nodes: [GraphNode]
    let edges: [GraphEdge]
    let selectedID: String?
    let onSelect: (GraphNode) -> Void

    var body: some View {
        GeometryReader { geometry in
            let positions = layout(in: geometry.size)
            Canvas { context, size in
                for edge in edges {
                    guard let start = positions[edge.source], let end = positions[edge.target] else { continue }
                    var path = Path()
                    path.move(to: start)
                    path.addLine(to: end)
                    context.stroke(path, with: .color(.secondary.opacity(0.22)), lineWidth: max(0.6, min(2.4, edge.weight)))
                }

                for node in nodes {
                    guard let point = positions[node.id] else { continue }
                    let radius = CGFloat(5 + min(10, sqrt(Double(node.mentionCount + 1)) * 2.1))
                    if selectedID == node.id {
                        let ring = CGRect(x: point.x - radius - 5, y: point.y - radius - 5, width: (radius + 5) * 2, height: (radius + 5) * 2)
                        context.stroke(Path(ellipseIn: ring), with: .color(.white.opacity(0.75)), lineWidth: 2)
                    }
                    let rect = CGRect(x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2)
                    context.fill(Path(ellipseIn: rect), with: .color(nodeColor(node.type)))
                    let label = Text(String(node.name.prefix(22)))
                        .font(.system(size: 10, weight: selectedID == node.id ? .semibold : .regular))
                        .foregroundColor(.primary)
                    context.draw(label, at: CGPoint(x: point.x + radius + 5, y: point.y), anchor: .leading)
                }
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onEnded { value in
                        let positions = layout(in: geometry.size)
                        let hit = nodes.min { lhs, rhs in
                            distance(positions[lhs.id] ?? .zero, value.location) < distance(positions[rhs.id] ?? .zero, value.location)
                        }
                        if let hit, distance(positions[hit.id] ?? .zero, value.location) < 28 { onSelect(hit) }
                    }
            )
        }
        .background(Color(red: 0.045, green: 0.052, blue: 0.066))
    }

    private func layout(in size: CGSize) -> [String: CGPoint] {
        guard !nodes.isEmpty else { return [:] }
        let center = CGPoint(x: size.width / 2, y: size.height / 2)
        let minSide = min(size.width, size.height)
        var result: [String: CGPoint] = [:]
        for (index, node) in nodes.enumerated() {
            let progress = Double(index) / Double(max(1, nodes.count))
            let angle = progress * Double.pi * 2 * 2.35
            let ring = 0.22 + 0.68 * sqrt(progress)
            let xRadius = max(80, size.width * 0.42) * ring
            let yRadius = max(80, minSide * 0.39) * ring
            result[node.id] = CGPoint(
                x: center.x + cos(angle) * xRadius,
                y: center.y + sin(angle) * yRadius
            )
        }
        return result
    }

    private func distance(_ a: CGPoint, _ b: CGPoint) -> CGFloat {
        hypot(a.x - b.x, a.y - b.y)
    }
}

private struct InsightsSheet: View {
    let insights: GraphInsights?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Eyebrow(text: "Graph health", color: .knodeViolet)
                    Text("Knowledge graph insights").font(.title.bold())
                }
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
            if let insights {
                HStack(spacing: 12) {
                    InsightMetric(value: insights.totals.entities, label: "Entities")
                    InsightMetric(value: insights.totals.relations, label: "Relations")
                    InsightMetric(value: insights.totals.mentions, label: "Mentions")
                }
                HStack(alignment: .top, spacing: 18) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Hubs").font(.headline)
                        ForEach(insights.hubs) { hub in
                            HStack { Text(hub.name); Spacer(); Text("degree \(hub.degree)").font(.caption.monospaced()).foregroundStyle(.secondary) }
                        }
                    }
                    .knodeCard()
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Entity types").font(.headline)
                        ForEach(insights.typeCounts) { item in
                            HStack { RouteBadge(label: item.type, color: nodeColor(item.type)); Spacer(); Text(item.n.formatted()).monospacedDigit() }
                        }
                    }
                    .knodeCard()
                }
                if !insights.isolated.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Isolated entities").font(.headline)
                        Text(insights.isolated.map(\.name).joined(separator: " · "))
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    .knodeCard()
                }
            } else {
                ProgressView()
            }
        }
        .padding(26)
        .frame(width: 720)
    }
}

private struct InsightMetric: View {
    let value: Int
    let label: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(value.formatted()).font(.system(size: 28, weight: .bold, design: .rounded))
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .knodeCard()
    }
}

private func nodeColor(_ type: String) -> Color {
    switch type.lowercased() {
    case "person": .knodeGood
    case "organization": .orange
    case "product": .pink
    case "project": .red
    case "component": .blue
    case "technology": .knodeCyan
    case "concept": .knodeViolet
    case "event": .purple
    case "location": .mint
    default: .gray
    }
}
