#!/usr/bin/env bash
#
# restart.sh — the documented entry point for restarting the local dev stack.
#
#   ./restart.sh            gracefully stop the current stack, then `pnpm dev`
#                           under the pinned Node version
#   ./restart.sh --check    validate the restart harness and report the port
#                           contract WITHOUT touching any running process
#
# The actual stop/start logic lives in scripts/restart-dev.sh + scripts/stop-dev.sh;
# this wrapper only adds the read-only `--check` mode and delegates the rest, so
# there is exactly one implementation of "how the stack starts".
#
# Why --check exists: the stack has two independent port contracts — the one
# hard-coded in scripts/stop-dev.sh + package.json's `dev`, and the one your
# local .env files actually configure. When they disagree, `stop` silently fails
# to free the api's real port and the api talks to an Inngest that isn't there.
# --check surfaces that before you spend an afternoon on it.

set -Eeuo pipefail

readonly REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$REPO_ROOT"

readonly BOLD=$'\033[1m' RED=$'\033[31m' GREEN=$'\033[32m' YELLOW=$'\033[33m' DIM=$'\033[2m' RESET=$'\033[0m'
CHECK_FAILURES=0

usage() {
  cat <<'EOF'
Usage: ./restart.sh [--check] [--help]

  (no flags)  Stop the running dev stack, then start it via `pnpm dev`
              under the Node version pinned in .nvmrc.
  --check     Validate Node, pnpm, the native-module binding, and the port
              contract, then list active listeners. Changes nothing.
  --help      Show this message.
EOF
}

ok()   { printf '%s  ok %s %s\n'   "$GREEN" "$RESET" "$1"; }
warn() { printf '%s warn %s %s\n'  "$YELLOW" "$RESET" "$1"; }
fail() { printf '%s fail %s %s\n'  "$RED" "$RESET" "$1"; CHECK_FAILURES=$((CHECK_FAILURES + 1)); }
note() { printf '%s       %s%s\n'  "$DIM" "$1" "$RESET"; }

# Read a KEY=value from a dotenv file, ignoring comments. Empty if absent.
env_value() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 0
  sed -n "s/^[[:space:]]*${key}=\([^#]*\).*/\1/p" "$file" | tail -1 | tr -d '[:space:]"'"'"''
}

# ── restart (default) ────────────────────────────────────────────────────────
do_restart() {
  [ -f scripts/restart-dev.sh ] || {
    printf '%srestart.sh: scripts/restart-dev.sh is missing; cannot restart.%s\n' "$RED" "$RESET" >&2
    exit 1
  }
  # exec so Ctrl-C reaches the stack directly rather than this wrapper.
  exec bash scripts/restart-dev.sh "$@"
}

# ── --check (read-only) ──────────────────────────────────────────────────────
do_check() {
  printf '%s== restart harness check ==%s\n\n' "$BOLD" "$RESET"

  # Node — compare the running interpreter against .nvmrc.
  local pinned current
  pinned="$(tr -d '[:space:]' < .nvmrc 2>/dev/null || true)"
  current="$(node --version 2>/dev/null | sed 's/^v//' || true)"
  if [ -z "$pinned" ]; then
    fail "no .nvmrc found — the Node pin is the better-sqlite3 ABI contract"
  elif [ -z "$current" ]; then
    fail "node is not on PATH (expected $pinned)"
  elif [ "$pinned" = "$current" ]; then
    ok "node $current matches .nvmrc"
  else
    fail "node $current != .nvmrc $pinned — run: nvm use"
  fi

  # pnpm — compare against package.json#packageManager.
  local want_pnpm have_pnpm
  want_pnpm="$(node -p "(require('./package.json').packageManager||'').split('@')[1]||''" 2>/dev/null || true)"
  have_pnpm="$(pnpm --version 2>/dev/null || true)"
  if [ -z "$have_pnpm" ]; then
    warn "pnpm not on PATH — restart falls back to corepack/PNPM_HOME"
  elif [ "$have_pnpm" = "$want_pnpm" ]; then
    ok "pnpm $have_pnpm matches packageManager"
  else
    warn "pnpm $have_pnpm != packageManager $want_pnpm — use: corepack pnpm …"
  fi

  # Native binding — dlopen in a child process, never rebuild (read-only mode).
  if node -e '
      const path = require("node:path");
      const p = require.resolve("better-sqlite3/build/Release/better_sqlite3.node", { paths: ["apps/api", "packages/db", "."] });
      process.dlopen({ exports: {} }, path.resolve(p));
    ' >/dev/null 2>&1; then
    ok "better-sqlite3 binding loads under this Node"
  else
    fail "better-sqlite3 binding fails to load — run: pnpm ensure:native"
  fi

  # Port contract: what the scripts free vs what your env actually configures.
  printf '\n%s-- port contract --%s\n' "$BOLD" "$RESET"
  local declared api_port web_port inngest_port api_url inngest_base
  declared="$(sed -n 's/^PORTS="\([^"]*\)".*/\1/p' scripts/stop-dev.sh 2>/dev/null | head -1)"
  api_port="$(env_value apps/api/.env.local PORT)"
  inngest_base="$(env_value apps/api/.env.local INNGEST_BASE_URL)"
  [ -n "$inngest_base" ] || inngest_base="$(env_value .env INNGEST_BASE_URL)"
  api_url="$(env_value apps/web/.env.local AGENTIC_API_URL)"
  web_port="$(node -p "((require('./package.json').scripts.dev||'').match(/--port (\d+)/)||[])[1]||''" 2>/dev/null || true)"
  inngest_port="$(node -p "((require('./package.json').scripts.dev||'').match(/-p (\d+)/)||[])[1]||''" 2>/dev/null || true)"

  note "stop-dev.sh frees: ${declared:-<unknown>}"
  note "api PORT (apps/api/.env.local): ${api_port:-<unset>}"
  note "web AGENTIC_API_URL:            ${api_url:-<unset>}"
  note "inngest started by \`pnpm dev\`:  ${inngest_port:-<unknown>}"
  note "api INNGEST_BASE_URL:           ${inngest_base:-<unset>}"

  # The api's real port must be in the list stop-dev.sh frees, or a stale api
  # survives every "restart" and the new one dies on EADDRINUSE.
  if [ -n "$api_port" ] && [ -n "$declared" ]; then
    if [[ ",${declared}," == *",${api_port},"* ]]; then
      ok "api port $api_port is freed by stop-dev.sh"
    else
      fail "api port $api_port is NOT in stop-dev.sh's list ($declared) — a stale api survives restart"
    fi
  fi

  # Web must point at the port the api actually binds.
  if [ -n "$api_url" ] && [ -n "$api_port" ]; then
    if [[ "$api_url" == *":${api_port}"* ]]; then
      ok "web AGENTIC_API_URL targets the api's port ($api_port)"
    else
      fail "web targets $api_url but the api binds :$api_port — /v1 proxy + readSession() will ECONNREFUSED"
    fi
  fi

  # The api's Inngest URL must match the Inngest `pnpm dev` actually starts.
  if [ -n "$inngest_base" ] && [ -n "$inngest_port" ]; then
    if [[ "$inngest_base" == *":${inngest_port}"* ]]; then
      ok "api INNGEST_BASE_URL matches the inngest dev port ($inngest_port)"
    else
      fail "api expects Inngest at $inngest_base but \`pnpm dev\` starts it on :$inngest_port — events will not dispatch"
    fi
  fi

  # DATABASE_URL resolution — a relative path here resolves against the api's
  # CWD, which silently creates an empty apps/api/agentic.db.
  printf '\n%s-- database --%s\n' "$BOLD" "$RESET"
  local db_resolved
  db_resolved="$(cd apps/api 2>/dev/null && node --env-file-if-exists=.env.local --env-file-if-exists=../../.env \
      -e 'const p=require("node:path");const u=(process.env.DATABASE_URL||"").replace(/^file:/,"");console.log(u?p.resolve(u):"")' 2>/dev/null || true)"
  if [ -z "$db_resolved" ]; then
    warn "could not resolve DATABASE_URL for the api"
  elif [ "$db_resolved" = "$REPO_ROOT/data/agentic.db" ]; then
    ok "api DATABASE_URL → data/agentic.db"
  else
    fail "api DATABASE_URL → $db_resolved (expected $REPO_ROOT/data/agentic.db)"
  fi

  # Active listeners — informational, never killed here.
  printf '\n%s-- active listeners --%s\n' "$BOLD" "$RESET"
  local watch_ports listeners
  watch_ports="$(printf '%s\n' "${declared:-}" "${api_port:-}" "${inngest_port:-}" \
    | tr ',' '\n' | sed '/^$/d' | sort -un | paste -sd, -)"
  if command -v lsof >/dev/null 2>&1 && [ -n "$watch_ports" ]; then
    # -iTCP:<ports> must carry the port list itself; a separate -i would be OR'd
    # with it and lsof would report every listener on the machine.
    listeners="$(lsof -nP -iTCP:"$watch_ports" -sTCP:LISTEN 2>/dev/null | tail -n +2 || true)"
    if [ -n "$listeners" ]; then
      printf '%s\n' "$listeners" | awk '{printf "       %-12s pid %-8s %s\n", $1, $2, $9}'
    else
      note "nothing listening on ${watch_ports}"
    fi
  else
    warn "lsof unavailable — cannot list listeners"
  fi

  printf '\n'
  if [ "$CHECK_FAILURES" -eq 0 ]; then
    printf '%sharness ok — ./restart.sh is safe to run%s\n' "$GREEN" "$RESET"
    return 0
  fi
  printf '%s%d check(s) failed — fix these before relying on ./restart.sh%s\n' "$RED" "$CHECK_FAILURES" "$RESET"
  return 1
}

main() {
  case "${1:-}" in
    --check) shift; do_check "$@" ;;
    --help|-h) usage ;;
    "") do_restart ;;
    *) printf 'restart.sh: unknown option %s\n\n' "$1" >&2; usage >&2; exit 64 ;;
  esac
}

main "$@"
