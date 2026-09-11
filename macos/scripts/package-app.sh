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
ditto "$DEPLOY_DIR" "$SERVICE_DIR/app"
cp "$NODE_BIN" "$SERVICE_DIR/bin/node"
chmod +x "$BIN_DIR/KnodeOS"
chmod +x "$SERVICE_DIR/bin/node"

echo "$APP_DIR"
