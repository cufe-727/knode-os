import SwiftUI

/**
 * The legend over the graph: two rows of chips that wrap onto new lines
 * instead of squeezing their text, one for the entity types in the reply and
 * one for the relation families, each with its count. A click hides or shows
 * that type or family. The co-occurrence chip is the settings' own switch, so
 * an overview stops (or starts again) asking the service for it.
 */
struct GraphLegend: View {
    let typeCounts: [(type: String, count: Int)]
    let familyCounts: [(family: GraphPalette.Family, count: Int)]
    @Binding var settings: GraphSettings

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            FlowLayout(spacing: 6) {
                ForEach(typeCounts, id: \.type) { item in
                    Button { toggle(type: item.type) } label: {
                        chip(hidden: settings.hiddenTypes.contains(item.type)) {
                            TypeSwatch(color: GraphPalette.typeRGB(item.type), glow: settings.glow)
                            Text("\(item.type) · \(item.count.formatted())")
                        }
                    }
                    .buttonStyle(.plain)
                    .help(L("Hide or show this type"))
                }
            }
            FlowLayout(spacing: 6) {
                ForEach(familyCounts, id: \.family.id) { item in
                    Button { toggle(family: item.family) } label: {
                        chip(hidden: isHidden(item.family)) {
                            RelationSwatch(family: item.family)
                            Text(item.count > 0 ? "\(L(item.family.label)) · \(item.count.formatted())" : L(item.family.label))
                        }
                    }
                    .buttonStyle(.plain)
                    .help(L("Hide or show this relation family"))
                }
            }
        }
        .frame(maxWidth: 640, alignment: .leading)
    }

    /// A chip whose text never wraps.
    private func chip<Content: View>(hidden: Bool, @ViewBuilder content: () -> Content) -> some View {
        HStack(spacing: 5) { content() }
            .font(.caption2)
            .strikethrough(hidden)
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(.thickMaterial, in: Capsule())
            .opacity(hidden ? 0.5 : 1)
    }

    private func toggle(type: String) {
        if let i = settings.hiddenTypes.firstIndex(of: type) {
            settings.hiddenTypes.remove(at: i)
        } else {
            settings.hiddenTypes.append(type)
        }
    }

    private func isHidden(_ family: GraphPalette.Family) -> Bool {
        family.id == GraphPalette.cooccurrence.id ? !settings.cooccur : settings.hiddenRelations.contains(family.id)
    }

    /// Co-occurrence is the settings' own switch, refetch included; the other families filter what is drawn.
    private func toggle(family: GraphPalette.Family) {
        if family.id == GraphPalette.cooccurrence.id {
            settings.cooccur.toggle()
        } else if let i = settings.hiddenRelations.firstIndex(of: family.id) {
            settings.hiddenRelations.remove(at: i)
        } else {
            settings.hiddenRelations.append(family.id)
        }
    }
}

/// A type's swatch, drawn like its nodes: the type's ring round a dark disc, glowing when glow is on.
struct TypeSwatch: View {
    let color: GraphRGB
    let glow: Bool

    var body: some View {
        Circle()
            .fill((glow ? GraphRGB(0x0d1019).mix(color, 0.13) : GraphRGB(0x131822)).color())
            .overlay { Circle().strokeBorder((glow ? color.lighter(0.12) : color).color(), lineWidth: 1.5) }
            .frame(width: 9, height: 9)
            .shadow(color: glow ? color.color(0.7) : .clear, radius: glow ? 3 : 0)
    }
}

/// A relation family's swatch: a short line in its colour and pattern.
struct RelationSwatch: View {
    let family: GraphPalette.Family

    var body: some View {
        Path { path in
            path.move(to: CGPoint(x: 1, y: 3))
            path.addLine(to: CGPoint(x: 15, y: 3))
        }
        .stroke(family.color, style: StrokeStyle(lineWidth: 2, lineCap: family.dash.isEmpty ? .butt : .round, dash: family.dash))
        .frame(width: 16, height: 6)
    }
}

/// Lays its views out left to right at their natural sizes, wrapping onto a new row when one would not fit.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var row: CGFloat = 0
        var widest: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width {
                x = 0
                y += row + spacing
                row = 0
            }
            widest = max(widest, x + size.width)
            x += size.width + spacing
            row = max(row, size.height)
        }
        return CGSize(width: widest, height: y + row)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var row: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX {
                x = bounds.minX
                y += row + spacing
                row = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            row = max(row, size.height)
        }
    }
}
