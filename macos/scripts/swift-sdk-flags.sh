#!/usr/bin/env bash
# Prints the flags `swift build` and `swift test` need on this machine, for
# package-app.sh and for anyone building by hand:
#
#     swift build -c release $(scripts/swift-sdk-flags.sh)
#     swift test $(scripts/swift-sdk-flags.sh)
#
# Command Line Tools ship SDKs without the compiler plugins some of them need.
# Since the macOS 27.0 SDK, SwiftUI's @State is a macro whose implementation
# (SwiftUIMacros) only Xcode carries, so against that SDK every @State in the
# app fails with "external macro implementation type 'SwiftUIMacros.StateMacro'
# could not be found", followed by misleading errors about assigning to the
# views' properties — while the 26.5 SDK installed next to it builds fine.
# So: compile a one-line @State view against the default SDK and, when that
# fails, fall back to the newest installed SDK that passes, saying so on
# stderr. Nothing is printed when the default SDK is fine.
#
# KNODE_OS_SWIFT_FLAGS, when set, is printed as is: the manual override, for an
# SDK or toolchain of your own choosing.
set -euo pipefail

if [[ -n "${KNODE_OS_SWIFT_FLAGS:-}" ]]; then
  echo "$KNODE_OS_SWIFT_FLAGS"
  exit 0
fi

PROBE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/knode-sdk-probe.XXXXXX")"
trap 'rm -rf "$PROBE_DIR"' EXIT
cat > "$PROBE_DIR/probe.swift" <<'SWIFT'
import SwiftUI
struct Probe: View {
    @State private var n = 0
    var body: some View { Text("\(n)") }
}
SWIFT
# the app's own deployment target (Package.swift), so the probe sees what the build sees
TARGET="$(uname -m)-apple-macos14.0"

# 0 when a @State view compiles against the SDK at $1; the compiler's output stays in $PROBE_DIR/out
probe() {
  swiftc -typecheck -target "$TARGET" -sdk "$1" "$PROBE_DIR/probe.swift" >"$PROBE_DIR/out" 2>&1
}

DEFAULT_SDK="$(xcrun --show-sdk-path)"
DEFAULT_REAL="$(cd "$DEFAULT_SDK" && pwd -P)"
if probe "$DEFAULT_REAL"; then
  exit 0
fi
reason="$(grep -m1 -o "plugin for module '[A-Za-z0-9_]*' not found" "$PROBE_DIR/out" || grep -m1 -o "error: .*" "$PROBE_DIR/out" || true)"
echo "swift-sdk-flags: the default SDK ($DEFAULT_SDK) cannot compile a @State view (${reason:-no diagnostics}); trying the other installed SDKs, newest first" >&2

# every MacOSX<version>.sdk beside the default one, newest version first, each real directory once
SDK_DIR="$(dirname "$DEFAULT_REAL")"
seen="$DEFAULT_REAL"
for sdk in $(ls -d "$SDK_DIR"/MacOSX[0-9]*.sdk 2>/dev/null | sed 's#.*/MacOSX##; s#\.sdk$##' | sort -t. -k1,1nr -k2,2nr -k3,3nr); do
  real="$(cd "$SDK_DIR/MacOSX$sdk.sdk" && pwd -P)"
  case " $seen " in *" $real "*) continue ;; esac
  seen="$seen $real"
  if probe "$real"; then
    echo "swift-sdk-flags: building with --sdk $real" >&2
    echo "--sdk $real"
    exit 0
  fi
done

echo "swift-sdk-flags: no installed SDK compiles a @State view. Set KNODE_OS_SWIFT_FLAGS (for example --sdk <path>) or build with Xcode's toolchain." >&2
sed -n '1,6p' "$PROBE_DIR/out" >&2
exit 1
