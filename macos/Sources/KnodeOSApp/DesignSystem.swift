import AppKit
import SwiftUI

struct KnodeLogo: View {
    var size: CGFloat = 32

    private var image: NSImage? {
        guard let url = Bundle.module.url(forResource: "favicon", withExtension: "svg", subdirectory: "Resources") else { return nil }
        return NSImage(contentsOf: url)
    }

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
            } else {
                Image(systemName: "circle.hexagongrid.fill")
                    .resizable()
                    .foregroundStyle(Color.knodeCyan)
            }
        }
        .frame(width: size, height: size)
        .accessibilityLabel("knode-os")
    }
}

struct Eyebrow: View {
    var text: String
    var color: Color = .knodeCyan

    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 10, weight: .bold, design: .monospaced))
            .tracking(1.4)
            .foregroundStyle(color)
    }
}

struct InitialsBadge: View {
    let value: String
    var team = false
    var size: CGFloat = 30

    var body: some View {
        Text(value.knodeInitials)
            .font(.system(size: size * 0.35, weight: .bold, design: .rounded))
            .foregroundStyle(team ? Color.knodeViolet : Color.knodeCyan)
            .frame(width: size, height: size)
            .background((team ? Color.knodeViolet : Color.knodeCyan).opacity(0.12), in: RoundedRectangle(cornerRadius: size * 0.25))
            .overlay {
                RoundedRectangle(cornerRadius: size * 0.25)
                    .stroke((team ? Color.knodeViolet : Color.knodeCyan).opacity(0.32))
            }
    }
}

struct StatusDot: View {
    var color: Color
    var size: CGFloat = 7

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .shadow(color: color.opacity(0.5), radius: 3)
    }
}

struct EmptyState: View {
    let symbol: String
    let title: String
    let message: String
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.system(size: 32, weight: .light))
                .foregroundStyle(Color.knodeCyan)
            Text(title)
                .font(.title3.weight(.semibold))
            Text(message)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 380)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(.borderedProminent)
                    .tint(.knodeCyan)
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct MetricPill: View {
    let value: Int
    let label: String

    var body: some View {
        HStack(spacing: 4) {
            Text(value.formatted())
                .foregroundStyle(.primary)
            Text(label)
                .foregroundStyle(.secondary)
        }
        .font(.system(size: 10, weight: .medium, design: .monospaced))
    }
}

struct RouteBadge: View {
    let label: String
    var color: Color = .knodeCyan

    var body: some View {
        Text(label.uppercased())
            .font(.system(size: 9, weight: .bold, design: .monospaced))
            .tracking(0.8)
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(color.opacity(0.1), in: Capsule())
            .overlay { Capsule().stroke(color.opacity(0.28)) }
    }
}

extension View {
    func knodeCard(padding: CGFloat = 16) -> some View {
        self
            .padding(padding)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
            .overlay { RoundedRectangle(cornerRadius: 12).stroke(Color.white.opacity(0.08)) }
    }
}

/// The colour of an entity type, the same in the graph, the entity table's
/// badges and the insights sheet, and the same as the web UI's.
func nodeColor(_ type: String) -> Color {
    GraphPalette.typeColor(type)
}
