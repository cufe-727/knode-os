#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MACOS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$MACOS_DIR/.." && pwd)"
APP_DIR="$MACOS_DIR/build/KnodeOS.app"
BIN_DIR="$APP_DIR/Contents/MacOS"
RESOURCES_DIR="$APP_DIR/Contents/Resources"
SERVICE_DIR="$RESOURCES_DIR/KnodeService"
RESOURCE_BUNDLE="$MACOS_DIR/.build/release/KnodeOS_KnodeOSApp.bundle"
APP_ICON="$MACOS_DIR/App/AppIcon.icns"
NODE_BIN="${KNODE_OS_NODE:-$(command -v node)}"
DEPLOY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/knode-service.XXXXXX")"
PACK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/knode-pack.XXXXXX")"
trap 'rm -rf "$DEPLOY_DIR" "$PACK_DIR"' EXIT

cd "$REPO_DIR"
npm run build
cd "$MACOS_DIR"
# KNODE_OS_SWIFT_FLAGS chooses the SDK or toolchain by hand; without it the
# helper probes the default SDK and falls back to the newest installed one that
# can compile a @State view (Command Line Tools lack the SwiftUI macro plugin
# the macOS 27.0 SDK needs), or fails with the compiler's reason.
SWIFT_FLAGS="$("$SCRIPT_DIR/swift-sdk-flags.sh")"
swift build -c release $SWIFT_FLAGS

if [[ ! -f "$APP_ICON" ]]; then
  echo "Missing app icon: $APP_ICON" >&2
  exit 1
fi

if [[ ! -x "$NODE_BIN" ]]; then
  echo "Node.js executable not found; set KNODE_OS_NODE to package a runtime." >&2
  exit 1
fi

rm -rf "$APP_DIR"
mkdir -p "$BIN_DIR" "$RESOURCES_DIR" "$SERVICE_DIR/bin"
cp "$MACOS_DIR/.build/release/KnodeOS" "$BIN_DIR/KnodeOS"
cp "$MACOS_DIR/App/Info.plist" "$APP_DIR/Contents/Info.plist"
cp "$APP_ICON" "$RESOURCES_DIR/AppIcon.icns"
ditto "$RESOURCE_BUNDLE" "$APP_DIR/KnodeOS_KnodeOSApp.bundle"
# The service's published files — what `pnpm pack` ships per package.json
# `files` — unpacked into the deploy directory. This used to be
# `pnpm deploy --legacy`, which copies the same files and then runs an install.
# That install was a no-op ("Already up to date") only while pnpm's
# optimistic-repeat-install check found node_modules/.pnpm-workspace-state-v1.json
# recorded with --prod settings. An ordinary `pnpm install` in the repo records
# `dev: true`, and the next deploy re-resolved every dependency from the
# registry — offline or not, since KNODE_OS_PNPM_FLAGS never reached it.
(cd "$REPO_DIR" && pnpm pack --pack-destination "$PACK_DIR" >/dev/null)
tar -xzf "$PACK_DIR"/*.tgz -C "$DEPLOY_DIR" --strip-components=1
# tsc never deletes an output whose source is gone, and `files` ships all of
# dist/, so a deleted module would ship on as dead code, the way
# dist/llm/budget.js outlived src/llm/budget.ts. Drop every compiled file that
# no longer has a source, in this copy only.
(cd "$DEPLOY_DIR/dist" && find . -name '*.js' | while read -r out; do
  rel="${out#./}"
  [[ -f "$REPO_DIR/src/${rel%.js}.ts" ]] || rm -f "$out"
done)
# --prod skips *installing* devDependencies, but pnpm still resolves them, so a
# dev-only package whose build script is not approved outside the workspace
# (esbuild, pulled in by tsx and vitest) aborts the install under pnpm 11's
# strict dep builds. The service runs plain `node dist/cli.js` and needs none of
# them, so drop them from the deployed manifest before installing.
node -e 'const fs=require("fs"); const p=process.argv[1]+"/package.json"; const j=JSON.parse(fs.readFileSync(p,"utf8")); delete j.devDependencies; fs.writeFileSync(p, JSON.stringify(j,null,2)+"\n")' "$DEPLOY_DIR"
# The packed files carry no dependencies. Install the production tree here,
# hoisted so the bundle carries plain directories instead of links into the
# developer's store.
# The workspace lockfile comes along, so the bundle carries the versions the
# tests ran against. Without it this resolved every range afresh from registry
# metadata: what shipped drifted as soon as the cached metadata did — dozens of
# untested upgrades, langchain and zod among them — and on a slow or flaky
# registry the 233 packument fetches, one of them 2 MB, stalled for hours. Its
# one importer, `.`, is this package, and --no-frozen-lockfile lets it drop the
# devDependencies removed above. Only tarballs the store lacks are fetched now,
# so KNODE_OS_PNPM_FLAGS=--offline packages from the local store alone. Pass
# flags there: `prefer-offline` in .npmrc or npm_config_* is ignored here.
cp "$REPO_DIR/pnpm-lock.yaml" "$DEPLOY_DIR/pnpm-lock.yaml"
(cd "$DEPLOY_DIR" && pnpm install --prod --ignore-workspace --node-linker=hoisted --no-frozen-lockfile ${KNODE_OS_PNPM_FLAGS:-})
if [[ ! -d "$DEPLOY_DIR/node_modules/commander" ]]; then
  echo "Service dependencies missing from $DEPLOY_DIR — refusing to package a bundle that cannot start." >&2
  exit 1
fi
# The hoisted install leaves its own store behind in node_modules/.pnpm. Inside
# the deploy directory those are hard links, so pnpm reports nothing unusual —
# but `ditto` writes each one out again, which is how the bundle grew to 1.7 GB
# once the agent dependencies arrived. Nothing links into it (every package,
# nested ones included, is a real directory at this point), so it is dead weight.
rm -rf "$DEPLOY_DIR/node_modules/.pnpm"
ditto "$DEPLOY_DIR" "$SERVICE_DIR/app"
cp "$NODE_BIN" "$SERVICE_DIR/bin/node"
chmod +x "$BIN_DIR/KnodeOS"
chmod +x "$SERVICE_DIR/bin/node"

echo "$APP_DIR"
