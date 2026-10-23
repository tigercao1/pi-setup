#!/bin/bash
# Reviewer-spawn go/no-go and verdict ledger for the PR review gate.
#   pr-gate-spawn.sh check   --state F --lane L --head SHA [--retry]   exit 0 go (prints spawn_id), 3 budget spent,
#                                                                      4 not selected
#   pr-gate-spawn.sh record  --state F --lane L --head SHA --spawn-id ID --verdict V --reviewer NAME --model M
#                            [--flagged p,q] [--blocker "f:l text"]... [--safety-fact proven|unproven]
#                            exit 4 = refused (no unconsumed spawn id for this lane and head), 5 = escalate now
#                            once a spawn id was bound (team_spawn gate path), every record needs a bound id
#   pr-gate-spawn.sh verify  --state F --spawn-id ID [--agent NAME --team T]   read-only: exit 0 the reservation is
#                            open at the recorded head and unbound (or bound to NAME), 4 refused
#   pr-gate-spawn.sh bind    --state F --spawn-id ID --agent NAME [--team T]   verify, then record the agent on it
#   pr-gate-spawn.sh grant   --state F --spawns N [--rounds N] --by NAME --reason TEXT   (resolves budget escalations)
#   pr-gate-spawn.sh resolve --state F --escalation E<n> --by NAME --reason TEXT   human decision on an escalation
#   pr-gate-spawn.sh status  --state F [--head SHA]   gate PASS needs every lane passing and no open escalation
# --state F may be replaced by --dir <mission or ticket plans folder> --pr N (state at <dir>/gate/<pr>.json).
exec python3 -B "$(dirname "$0")/pr_gate_core.py" spawn "$@"
