#!/usr/bin/env bash
# Replace /Applications/KnodeOS.app with a fresh build, following the local
# installation workflow in AGENTS.md: one installed copy at a fixed path, no
# loose .app bundles left behind for LaunchServices or Spotlight to list.
#
#   ./macos/scripts/install-app.sh              build, then install
#   ./macos/scripts/install-app.sh --no-build   install macos/build/KnodeOS.app as is
#   ./macos/scripts/install-app.sh --backup     also keep the old bundle as
#                                               install-backups/previous.zip
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MACOS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_APP="$MACOS_DIR/build/KnodeOS.app"
TARGET="/Applications/KnodeOS.app"
BUNDLE_ID="dev.knode.os"
HEALTH_URL="${KNODE_OS_HEALTH_URL:-http://127.0.0.1:9100/api/health}"
BACKUP_ZIP="$HOME/Library/Application Support/KnodeOS/install-backups/previous.zip"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

build=1
backup=0
for arg in "$@"; do
  case "$arg" in
    --no-build) build=0 ;;
    --backup) backup=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

log() { echo "[install] $*"; }

# Delete a bundle, then take it out of LaunchServices — in that order. A record
# can outlive an unregister made while the bundle still exists under
# /Applications (two staged old.app copies stayed listed that way, 2026-10-27);
# unregistering the path once nothing is there clears it.
discard() {
  rm -rf "$1"
  "$LSREGISTER" -u "$1" >/dev/null 2>&1 || true
}

if [[ $build == 1 ]]; then
  if ! "$SCRIPT_DIR/package-app.sh"; then
    # A half-built bundle is useless and would show up as another app.
    discard "$BUILD_APP"
    echo "Build failed; $TARGET was left untouched." >&2
    exit 1
  fi
fi

# --- Validate the new bundle before touching the installed one.
[[ -d "$BUILD_APP" ]] || { echo "No build at $BUILD_APP" >&2; exit 1; }
id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$BUILD_APP/Contents/Info.plist")"
[[ "$id" == "$BUNDLE_ID" ]] || { echo "Bundle identifier is $id, expected $BUNDLE_ID" >&2; exit 1; }
for f in Contents/MacOS/KnodeOS Contents/Resources/KnodeService/bin/node; do
  [[ -x "$BUILD_APP/$f" ]] || { echo "Missing executable $f in build" >&2; exit 1; }
done
[[ -f "$BUILD_APP/Contents/Resources/KnodeService/app/dist/cli.js" ]] \
  || { echo "Missing bundled service in build" >&2; exit 1; }

# --- Stage the complete new bundle in a hidden directory beside the target.
STAGE="$(mktemp -d /Applications/.KnodeOS-install.XXXXXX)"
ditto "$BUILD_APP" "$STAGE/new.app"
# Keep the staged copies out of LaunchServices while they exist, and once they are gone.
"$LSREGISTER" -u "$STAGE/new.app" >/dev/null 2>&1 || true
discard_stage() {
  discard "$STAGE/new.app"
  discard "$STAGE/old.app"
  rm -rf "$STAGE"
}

swapped=0
restore() {
  local status=$?
  if [[ $swapped == 1 && -d "$STAGE/old.app" ]]; then
    log "installation failed — restoring the previous bundle"
    stop_app || true
    rm -rf "$TARGET"
    mv "$STAGE/old.app" "$TARGET"
    "$LSREGISTER" -f "$TARGET" >/dev/null 2>&1 || true
    open "$TARGET" || true
  fi
  discard_stage
  exit "$status"
}
trap restore ERR INT TERM

# --- Gracefully stop the app, then its bundled service.
app_pids() { pgrep -f "^$TARGET/Contents/MacOS/KnodeOS" || true; }
service_pids() { pgrep -f "$TARGET/Contents/Resources/KnodeService/" || true; }
wait_gone() { # $1 = function listing pids, $2 = seconds
  local i
  for ((i = 0; i < $2 * 4; i++)); do
    [[ -z "$($1)" ]] && return 0
    sleep 0.25
  done
  return 1
}
stop_app() {
  if [[ -n "$(app_pids)" ]]; then
    osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
    wait_gone app_pids 20 || { kill -TERM $(app_pids) 2>/dev/null || true; wait_gone app_pids 10; }
  fi
  if [[ -n "$(service_pids)" ]]; then
    kill -TERM $(service_pids) 2>/dev/null || true
    wait_gone service_pids 15 || { echo "Bundled service did not stop" >&2; return 1; }
  fi
}
log "stopping the running app"
stop_app

# --- Swap the whole bundle; the old one stays in the stage until health passes.
if [[ -d "$TARGET" ]]; then
  mv "$TARGET" "$STAGE/old.app"
  swapped=1
  "$LSREGISTER" -u "$STAGE/old.app" >/dev/null 2>&1 || true
fi
mv "$STAGE/new.app" "$TARGET"
"$LSREGISTER" -f "$TARGET"

# --- Launch the fixed path and check that it actually came up.
# An app connected over SSH runs no bundled service: its service answers at the
# app's own `ssh -L 127.0.0.1:<free port>:…` forward, a port chosen at launch.
tunnel_health_url() {
  local pid child port
  for pid in $(app_pids); do
    for child in $(pgrep -P "$pid" ssh || true); do
      port="$(ps -o args= -p "$child" 2>/dev/null | sed -nE 's/.* -L 127\.0\.0\.1:([0-9]+):.*/\1/p' || true)"
      if [[ -n "$port" ]]; then
        echo "http://127.0.0.1:$port/api/health"
        return 0
      fi
    done
  done
  return 0
}
answers() { curl -fsS --noproxy '*' -m 2 "$1" >/dev/null 2>&1; }
log "launching $TARGET"
open "$TARGET"
healthy=0
for ((i = 0; i < 120; i++)); do
  if [[ -n "$(app_pids)" ]]; then
    if answers "$HEALTH_URL"; then
      healthy=1
      break
    fi
    tunnel="$(tunnel_health_url)"
    if [[ -n "$tunnel" ]] && answers "$tunnel"; then
      HEALTH_URL="$tunnel"
      healthy=1
      break
    fi
  fi
  sleep 0.5
done
if [[ $healthy != 1 ]]; then
  echo "App did not become healthy (process from $TARGET + $HEALTH_URL)" >&2
  false
fi
if [[ -z "$(service_pids)" ]]; then
  log "note: $HEALTH_URL is answered by a service outside the app bundle"
fi
trap - ERR INT TERM

# --- Success: keep at most one rollback archive, then clean up.
if [[ $backup == 1 && -d "$STAGE/old.app" ]]; then
  mkdir -p "$(dirname "$BACKUP_ZIP")"
  rm -f "$BACKUP_ZIP"
  ditto -c -k --keepParent "$STAGE/old.app" "$BACKUP_ZIP"
  log "previous bundle archived to $BACKUP_ZIP"
fi
discard_stage
discard "$BUILD_APP"
"$LSREGISTER" -f "$TARGET"

# --- Verify a single registered copy. Any other bundle LaunchServices lists
# under a KnodeOS path (a staged copy, a build, a copy elsewhere) is named here,
# not removed; bundles inside the installed app are its own.
registered="$("$LSREGISTER" -dump 2>/dev/null | sed -nE 's/^path: *(.*KnodeOS.*) \(0x[0-9a-f]+\)$/\1/p' | sort -u || true)"
others="$(grep -vxF "$TARGET" <<<"$registered" | grep -vF "$TARGET/" || true)"
if [[ -n "$others" ]]; then
  echo "Warning: LaunchServices lists other KnodeOS bundles:" >&2
  echo "$others" >&2
fi
grep -qxF "$TARGET" <<<"$registered" || echo "Warning: LaunchServices does not list $TARGET" >&2
log "installed and running from $TARGET"
