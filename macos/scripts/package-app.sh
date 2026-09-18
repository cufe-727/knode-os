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
trap 'rm -rf "$DEPLOY_DIR"' EXIT

cd "$REPO_DIR"
npm run build
cd "$MACOS_DIR"
swift build -c release

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
(cd "$REPO_DIR" && pnpm --filter knode-os deploy --prod --legacy --force "$DEPLOY_DIR")
# --prod skips *installing* devDependencies, but pnpm still resolves them, so a
# dev-only package whose build script is not approved outside the workspace
# (esbuild, pulled in by tsx and vitest) aborts the install under pnpm 11's
# strict dep builds. The service runs plain `node dist/cli.js` and needs none of
# them, so drop them from the deployed manifest before installing.
node -e 'const fs=require("fs"); const p=process.argv[1]+"/package.json"; const j=JSON.parse(fs.readFileSync(p,"utf8")); delete j.devDependencies; fs.writeFileSync(p, JSON.stringify(j,null,2)+"\n")' "$DEPLOY_DIR"
# Legacy deploy only copies the published files — since pnpm 11 it installs
# nothing ("Already up to date"), which ships a service that cannot resolve its
# own imports. Install the production tree here, hoisted so the bundle carries
# plain directories instead of links into the developer's store.
(cd "$DEPLOY_DIR" && pnpm install --prod --ignore-workspace --node-linker=hoisted --no-frozen-lockfile)
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
