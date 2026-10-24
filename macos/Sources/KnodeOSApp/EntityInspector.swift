import SwiftUI

/**
 * The panel a marked entity name opens beside a file: what the graph holds
 * about the entity — its type, aliases and description, its typed relations
 * folded per neighbour, the entities its documents mention alongside it, its
 * claims and the documents that mention it most. A neighbour opens in the
 * same panel and the back button walks the trail. The wiki page and the graph
 * are a button away, so reading stays where it was: most entities have no
 * page, and every one has relations.
 */
struct EntityInspector: View {
    @EnvironmentObject private var model: AppModel
    /// The entities opened in this panel, the one shown last; emptied to close it.
    @Binding var trail: [String]
    var onOpenFile: (String) -> Void

    @State private var detail: EntityDetail?
    @State private var failure: String?
    /// The trail entry `detail` or `failure` answers.
    @State private var loadedFor: String?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Button { trail.removeLast() } label: {
                    Image(systemName: "chevron.left")
                }
                .buttonStyle(.plain)
                .opacity(trail.count < 2 ? 0 : 1)
                .disabled(trail.count < 2)
                .help(L("Back"))
                Eyebrow(text: L("Entity"), color: .knodeViolet)
                Spacer()
                Button { trail = [] } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .help(L("Close"))
            }
            .padding(.horizontal, 14)
            .frame(height: 40)
            Divider()
            if let detail, loadedFor == trail.last {
                ScrollView {
                    content(detail)
                        .padding(14)
                }
            } else if let failure, loadedFor == trail.last {
                EmptyState(symbol: "exclamationmark.triangle", title: L("Entity unavailable"), message: failure)
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(.ultraThinMaterial)
        .task(id: trail.last) { await load() }
    }

    private func load() async {
        guard let id = trail.last else { return }
        do {
            let loaded = try await model.client().entityDetail(id: id)
            guard trail.last == id else { return }
            detail = loaded
            failure = nil
            loadedFor = id
        } catch {
            guard trail.last == id, !Task.isCancelled else { return }
            detail = nil
            failure = error.localizedDescription
            loadedFor = id
        }
    }

    private func open(_ id: String) {
        if trail.last != id { trail.append(id) }
    }

    private func content(_ detail: EntityDetail) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            card(detail.entity)
            relations(detail)
            if !detail.cooccurring.isEmpty { coMentions(detail.cooccurring) }
            if !detail.claims.isEmpty { claims(detail.claims) }
            if !detail.documents.isEmpty { documents(detail.documents) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func card(_ entity: EntityDetail.Entity) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            RouteBadge(label: entity.type, color: nodeColor(entity.type))
            Text(entity.name)
                .font(.title2.bold())
                .textSelection(.enabled)
            if !entity.aliases.isEmpty {
                Text(L("Also %@", entity.aliases.joined(separator: " · ")))
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            if !entity.description.isEmpty {
                Text(entity.description)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            Text(numbers(entity))
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
            HStack(spacing: 8) {
                Button(L("Open wiki page"), systemImage: "book.closed") {
                    if let path = entity.wikiPath { onOpenFile(path) }
                }
                .disabled(entity.wikiPath == nil)
                .help(entity.wikiPath.map { L("Open %@", $0) } ?? L("No wiki page yet"))
                Button(L("Explore in graph"), systemImage: "point.3.connected.trianglepath.dotted") {
                    model.exploreEntity(entity.name)
                }
            }
            .controlSize(.small)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.knodeViolet.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
    }

    private func numbers(_ entity: EntityDetail.Entity) -> String {
        [
            entity.mentionCount == 1 ? L("1 mention") : L("%@ mentions", String(entity.mentionCount)),
            entity.documentCount == 1 ? L("1 document") : L("%@ documents", String(entity.documentCount)),
            L("degree %@", String(entity.degree)),
        ].joined(separator: " · ")
    }

    /// Each neighbour once, with every relation to it: which way it runs, and its family's colour and line.
    private func relations(_ detail: EntityDetail) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(detail.relations.isEmpty ? L("No typed relations yet") : L("Relations · %@", String(detail.relations.count + detail.moreRelations)))
                .font(.headline)
            ForEach(detail.relations) { group in
                Button { open(group.other.id) } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 8) {
                            RouteBadge(label: group.other.type, color: nodeColor(group.other.type))
                            Text(group.other.name)
                                .font(.callout.weight(.semibold))
                                .lineLimit(1)
                            Spacer(minLength: 0)
                        }
                        FlowLayout(spacing: 10) {
                            ForEach(Array(group.relations.enumerated()), id: \.offset) { _, relation in
                                HStack(spacing: 5) {
                                    RelationSwatch(family: GraphPalette.family(of: relation.type))
                                    Text(relationLabel(relation))
                                        .font(.caption.monospaced())
                                        .foregroundStyle(.secondary)
                                }
                                .help(relation.description.isEmpty ? relation.type : relation.description)
                            }
                        }
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                    .background(Color.white.opacity(0.025), in: RoundedRectangle(cornerRadius: 9))
                    .overlay { RoundedRectangle(cornerRadius: 9).stroke(Color.white.opacity(0.07)) }
                }
                .buttonStyle(.plain)
                .help(L("Open %@ in this panel", group.other.name))
            }
            if detail.moreRelations > 0 {
                Text(L("%@ more in the graph", String(detail.moreRelations)))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// A relation as it reads from this entity's side: `→ supplies to`, `← invested in`, `↔ partner of`.
    private func relationLabel(_ relation: EntityDetail.Relation) -> String {
        let way = GraphPalette.undirected.contains(relation.type) ? "↔" : relation.direction == "out" ? "→" : "←"
        return "\(way) \(GraphRenderer.relationName(relation.type))"
    }

    private func coMentions(_ items: [EntityDetail.CoMention]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L("Mentioned alongside"))
                .font(.headline)
            FlowLayout(spacing: 6) {
                ForEach(items) { item in
                    Button { open(item.id) } label: {
                        HStack(spacing: 5) {
                            Circle().fill(nodeColor(item.type)).frame(width: 7, height: 7)
                            Text(item.name)
                                .font(.caption)
                                .lineLimit(1)
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(Color.white.opacity(0.05), in: Capsule())
                        .overlay { Capsule().stroke(Color.white.opacity(0.08)) }
                        .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .help(item.documents == 1 ? L("1 shared document") : L("%@ shared documents", String(item.documents)))
                }
            }
        }
    }

    private func claims(_ claims: [Claim]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(L("Claims"))
                .font(.headline)
            ForEach(claims) { claim in
                Label(claim.statement, systemImage: "seal")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(4)
            }
        }
    }

    private func documents(_ documents: [EntityDetail.Document]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(L("Mentioned in"))
                .font(.headline)
            ForEach(documents) { document in
                Button { onOpenFile(document.path) } label: {
                    Label(document.title ?? document.path, systemImage: "doc.text")
                        .font(.caption)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.knodeCyan)
                .help(document.path)
            }
        }
    }
}
