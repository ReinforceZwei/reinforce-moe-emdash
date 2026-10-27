#!/bin/sh
# Online SQLite backup for this site — the `backup` service in docker-compose.yml runs it with
# the same image as the app, only with this script as the command.
#
# `.backup` uses SQLite's online backup API: it takes a consistent snapshot while the app keeps
# writing, so nothing has to be stopped. Opening the source as `?mode=ro` matters twice over —
# plain sqlite3 *creates* a missing database, so a mistyped path would otherwise "back up" an
# empty file that still passes integrity_check, and a read-only connection can never write into
# the application's volume.
set -eu

DB_PATH="${DB_PATH:-/app/data/emdash.db}"
OUT_DIR="${OUT_DIR:-/app/backups}"
KEEP="${KEEP:-7}"               # backups kept on the volume
INTERVAL="${INTERVAL:-21600}"   # seconds between backups
MIN_TABLES="${MIN_TABLES:-80}"  # an empty or foreign database has 0 tables

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

backup_once() {
	ts=$(date -u +%Y%m%dT%H%M%SZ)
	name="emdash-$ts.db"
	tmp="$OUT_DIR/.$name.partial"
	mkdir -p "$OUT_DIR"

	[ -f "$DB_PATH" ] || { log "FAIL source missing: $DB_PATH"; return 1; }

	sqlite3 "file:$DB_PATH?mode=ro" ".timeout 15000" ".backup '$tmp'" ||
		{ rm -f "$tmp"; log "FAIL .backup step"; return 1; }

	# Verify the snapshot is a real EmDash database, not just structurally intact: an empty
	# database passes `integrity_check`, so that check alone cannot catch a wrong source.
	tables=$(sqlite3 "$tmp" "select count(*) from sqlite_master where type='table'")
	[ "${tables:-0}" -ge "$MIN_TABLES" ] ||
		{ rm -f "$tmp"; log "FAIL copy has only $tables tables"; return 1; }

	check=$(sqlite3 "$tmp" "pragma integrity_check")
	[ "$check" = ok ] || { rm -f "$tmp"; log "FAIL integrity: $check"; return 1; }

	# Publish atomically: a collector must never pick up a half-written file, and a failed run
	# must not leave anything behind that looks like a backup.
	chmod 0644 "$tmp"
	mv "$tmp" "$OUT_DIR/$name"
	( cd "$OUT_DIR" && sha256sum "$name" >"$name.sha256" )
	log "OK $name $(wc -c <"$OUT_DIR/$name") bytes, $tables tables"
	date -u +%s >"$OUT_DIR/LAST_SUCCESS"

	# Retention by count. Keep this well above the collector's worst-case lag: pruning happens
	# here, so a collector that falls further behind than KEEP intervals will lose files.
	ls -1t "$OUT_DIR"/emdash-*.db 2>/dev/null | tail -n +$((KEEP + 1)) |
		while read -r old; do
			rm -f "$old" "$old.sha256"
			log "pruned $(basename "$old")"
		done
}

if [ "${1:-}" = "--once" ]; then
	backup_once
	exit $?
fi

# As PID 1, sh would otherwise swallow nothing and hold docker stop for the full 10s grace.
trap 'exit 0' TERM INT

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR"/.*.partial

# Catch-up: every deploy, image update and container recreate restarts this script, so a plain
# `sleep $INTERVAL` loop can starve the schedule entirely. Back up now if the last success is
# older than one interval (or if LAST_SUCCESS is missing/corrupt).
now=$(date -u +%s)
last=$(cat "$OUT_DIR/LAST_SUCCESS" 2>/dev/null || echo 0)
case "$last" in '' | *[!0-9]*) last=0 ;; esac
if [ $((now - last)) -ge "$INTERVAL" ]; then
	backup_once || log "backup failed; retrying in ${INTERVAL}s"
fi

while :; do
	sleep "$INTERVAL"
	backup_once || log "backup failed; retrying next interval"
done
