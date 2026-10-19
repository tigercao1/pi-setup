#!/bin/bash
# Single holder of the pi sleep assertion: `caffeinate -dis` while an
# interactive marker in run/active/<pid> is live, `-is` while only spawned
# teammates are, released when neither is. Dead pids are ignored and their
# markers deleted. See README.md "Sleep protection".

TEAMS_DIR="$HOME/.pi/orchestrator-teams"
ACTIVE_DIR="${PI_CAFFEINATE_ACTIVE_DIR:-$HOME/.pi/agent/run/active}"
LOG="$HOME/.pi/agent/logs/agent-caffeinate.log"
POLL_SECONDS="${PI_CAFFEINATE_POLL:-5}"
RUN_DIR="$HOME/.pi/agent/run"
PID_FILE="$RUN_DIR/caffeinate.pid"
CAFF_PID=""
CAFF_MODE=""

mkdir -p "$(dirname "$LOG")" "$ACTIVE_DIR" "$RUN_DIR"

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >>"$LOG"
  # keep the log from growing without bound
  if [ "$(wc -c <"$LOG" 2>/dev/null || echo 0)" -gt 262144 ]; then
    tail -n 500 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  fi
}

live_holders() {
  TEAMS_DIR="$TEAMS_DIR" ACTIVE_DIR="$ACTIVE_DIR" python3 - <<'PY'
import glob, json, os, subprocess

PI_COMMS = {"pi", "node"}


def alive_pi(pid):
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    try:
        comm = subprocess.run(
            ["ps", "-o", "comm=", "-p", str(pid)],
            capture_output=True, text=True, timeout=5,
        ).stdout.strip()
    except Exception:
        return False
    return os.path.basename(comm) in PI_COMMS


markers = []
active_dir = os.environ["ACTIVE_DIR"]
for entry in sorted(os.listdir(active_dir)) if os.path.isdir(active_dir) else []:
    path = os.path.join(active_dir, entry)
    if not entry.isdigit():
        continue
    pid = int(entry)
    if alive_pi(pid):
        markers.append(str(pid))
    else:
        try:
            os.unlink(path)
        except OSError:
            pass

agents = []
for cfg in glob.glob(os.path.join(os.environ["TEAMS_DIR"], "*", "config.json")):
    try:
        with open(cfg) as fh:
            data = json.load(fh)
    except Exception:
        continue
    for agent in data.get("agents", []):
        pane = str(agent.get("paneId") or "")
        if not pane.startswith("pid:"):
            continue
        try:
            pid = int(pane.split(":", 1)[1])
        except ValueError:
            continue
        if alive_pi(pid):
            agents.append(f"{agent.get('name', '?')}({pid})")

print(" ".join(sorted(set(markers))))
print(" ".join(sorted(set(agents))))
PY
}

reap_previous() {
  [ -f "$PID_FILE" ] || return 0
  read -r prev_watcher prev_caff <"$PID_FILE" 2>/dev/null
  rm -f "$PID_FILE"
  case "$prev_caff" in ''|*[!0-9]*) return 0 ;; esac
  [ "$prev_watcher" = "$$" ] && return 0
  kill -0 "$prev_caff" 2>/dev/null || return 0
  [ "$(basename "$(ps -o comm= -p "$prev_caff" 2>/dev/null)")" = "caffeinate" ] || return 0
  kill "$prev_caff" 2>/dev/null
  log "reaped stray caffeinate $prev_caff from watcher $prev_watcher"
}

release() {
  local why="$1"
  kill "$CAFF_PID" 2>/dev/null
  rm -f "$PID_FILE"
  log "RELEASE pid=$CAFF_PID ($why)"
  CAFF_PID=""
  CAFF_MODE=""
}

cleanup() {
  if [ -n "$CAFF_PID" ] && kill -0 "$CAFF_PID" 2>/dev/null; then
    kill "$CAFF_PID" 2>/dev/null
    log "watcher exiting - released caffeinate $CAFF_PID"
  fi
  rm -f "$PID_FILE"
  exit 0
}
trap cleanup TERM INT

log "watcher started (poll ${POLL_SECONDS}s)"
reap_previous

while true; do
  if ! HOLDERS="$(live_holders)"; then
    log "ERROR live_holders failed; keeping mode=${CAFF_MODE:--} pid=${CAFF_PID:--}"
    sleep "$POLL_SECONDS"
    continue
  fi
  MARKERS="$(echo "$HOLDERS" | sed -n 1p)"
  AGENTS="$(echo "$HOLDERS" | sed -n 2p)"

  if [ -n "$MARKERS" ]; then
    WANT_MODE="dis"
  elif [ -n "$AGENTS" ]; then
    WANT_MODE="is"
  else
    WANT_MODE=""
  fi

  REASON="markers: ${MARKERS:--} agents: ${AGENTS:--}"

  # the assertion died out from under us (crash, manual kill)
  if [ -n "$CAFF_PID" ] && ! kill -0 "$CAFF_PID" 2>/dev/null; then
    log "caffeinate $CAFF_PID vanished; will respawn if work is still up"
    CAFF_PID=""
    CAFF_MODE=""
  fi

  if [ -z "$WANT_MODE" ]; then
    if [ -n "$CAFF_PID" ]; then
      release "no live markers or agents"
    fi
  elif [ -n "$CAFF_PID" ] && [ "$CAFF_MODE" != "$WANT_MODE" ]; then
    release "mode change $CAFF_MODE -> $WANT_MODE"
  fi

  if [ -n "$WANT_MODE" ] && [ -z "$CAFF_PID" ]; then
    caffeinate "-$WANT_MODE" -w $$ &
    CAFF_PID=$!
    CAFF_MODE="$WANT_MODE"
    echo "$$ $CAFF_PID" >"$PID_FILE"
    log "HOLD   pid=$CAFF_PID mode=-$WANT_MODE $REASON"
  fi

  sleep "$POLL_SECONDS"
done
