#!/usr/bin/env bash
# scripts/db-backup.sh — P4-OPS-07 SQLite nightly backup.
#
# Runs the Node backup command under the same canonical SQLite writer
# supervisor as every other database operation. The supervisor serializes the
# backup with API/studio/maintenance writers and performs the final checkpoint
# before releasing the lease.
#
# Retention is handled by trimming files older than the configured
# window. Default 90 days; override via `BACKUP_RETENTION_DAYS`. Every
# snapshot includes the append-only logs and step artifacts in a matching
# `agentic-<timestamp>-evidence/` directory.
#
# Suitable for `cron` (any timezone) or a Kubernetes CronJob. Exits
# non-zero on any failure so the orchestrator can alert.
#
# Restore drill:
#   1. Stop the api service (or take it out of the LB rotation).
#   2. `cp data/backups/agentic-YYYYMMDD-HHMMSS.db data/agentic.db`
#   3. Remove WAL artifacts: `rm -f data/agentic.db-wal data/agentic.db-shm`
#   4. Start the api; check `/health` reports sqlite.ok=true.
#   Verified procedure is in `docs/RUNBOOK.md §7`.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="${AGENTIC_DATA_DIR:-$ROOT_DIR/data}"
DB_FILE="${DATA_DIR}/agentic.db"

if [[ ! -f "$DB_FILE" ]]; then
  echo "[db-backup] FATAL: $DB_FILE not found" >&2
  exit 1
fi

export AGENTIC_DATA_DIR="$DATA_DIR"
if [[ -z "${DATABASE_URL:-}" ]]; then
  export DATABASE_URL="file:$DB_FILE"
fi

exec node "$ROOT_DIR/scripts/run-db-command.mjs" backup
