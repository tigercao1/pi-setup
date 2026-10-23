#!/bin/bash
# Rebuild this pi setup on a macOS machine. Idempotent: every step checks before it acts.
# Never writes a secret; the logins to do by hand are printed at the end.
set -euo pipefail

AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_PACKAGE="@earendil-works/pi-coding-agent"
QMD_PACKAGE="@tobilu/qmd"
NODE_MAJOR=22
PLIST_LABEL="com.ycao.pi-agent-caffeinate"
PLIST_TEMPLATE="$AGENT_DIR/templates/$PLIST_LABEL.plist.tmpl"
PLIST_TARGET="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
LAYER_DIR="$AGENT_DIR/../homebase"
SETTINGS="$AGENT_DIR/settings.json"
SHARED_NODE_MODULES="../agent-orchestrator/node_modules"

step() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '    WARNING: %s\n' "$*" >&2; }

[ "$(uname -s)" = "Darwin" ] || { echo "bootstrap.sh supports macOS only" >&2; exit 1; }

usage() { echo "usage: bootstrap.sh [--company-repo owner/repo]" >&2; exit 2; }
COMPANY_REPO_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --company-repo) [ $# -ge 2 ] || usage; COMPANY_REPO_ARG="$2"; shift 2 ;;
    --company-repo=*) COMPANY_REPO_ARG="${1#*=}"; shift ;;
    -h | --help) usage ;;
    *) usage ;;
  esac
done
if [ -n "$COMPANY_REPO_ARG" ]; then
  [[ "$COMPANY_REPO_ARG" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "--company-repo wants owner/repo" >&2; exit 2; }
  printf 'COMPANY_LAYER_REPO=%s\n' "$COMPANY_REPO_ARG" >"$AGENT_DIR/company.env"
  export COMPANY_LAYER_REPO="$COMPANY_REPO_ARG"
fi

COMPANY_KEYS=(COMPANY_LAYER_REPO COMPANY_REGISTRY_REPO COMPANY_REGISTRY_CLI COMPANY_REGISTRY_INSTALL)
COMPANY_ENV_OVERRIDES=()
for key in "${COMPANY_KEYS[@]}"; do
  if [ -n "${!key+x}" ]; then COMPANY_ENV_OVERRIDES+=("$key=${!key}"); fi
done
load_company_env() {
  local file pair key
  for file in "$AGENT_DIR/company.env" "$AGENT_DIR/../homebase/company.env"; do
    if [ -f "$file" ]; then
      set -a
      # shellcheck disable=SC1090
      . "$file"
      set +a
    fi
  done
  for pair in "${COMPANY_ENV_OVERRIDES[@]+"${COMPANY_ENV_OVERRIDES[@]}"}"; do
    printf -v "${pair%%=*}" '%s' "${pair#*=}"
  done
  for key in "${COMPANY_KEYS[@]}"; do
    printf -v "$key" '%s' "${!key-}"
  done
}
load_company_env

step "Homebrew packages (Brewfile)"
if ! command -v brew >/dev/null 2>&1; then
  for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    [ -x "$candidate" ] && eval "$("$candidate" shellenv)" && break
  done
fi
if ! command -v brew >/dev/null 2>&1; then
  note "Homebrew missing; running the official installer"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
fi
if brew bundle check --no-upgrade --file="$AGENT_DIR/Brewfile" >/dev/null 2>&1; then
  note "all Brewfile entries installed"
else
  brew bundle install --no-upgrade --file="$AGENT_DIR/Brewfile"
fi

step "gh extension github/gh-stack"
if ! gh auth status >/dev/null 2>&1; then
  note "gh is not signed in; skipped (re-run after gh auth login)"
elif gh extension list 2>/dev/null | grep -q 'github/gh-stack'; then
  note "already installed"
else
  gh extension install github/gh-stack
fi

step "nvm, node $NODE_MAJOR, pi"
export NVM_DIR="$HOME/.nvm"
mkdir -p "$NVM_DIR"
set +u
# shellcheck disable=SC1091
. "$(brew --prefix nvm)/nvm.sh"
if ! nvm ls "$NODE_MAJOR" >/dev/null 2>&1; then
  nvm install "$NODE_MAJOR"
fi
nvm use "$NODE_MAJOR" >/dev/null
nvm alias default "$NODE_MAJOR" >/dev/null
set -u
note "node $(node --version)"

PI_WANTED="$(tr -d '[:space:]' <"$AGENT_DIR/pi-version")"
PI_HAVE="$(pi --version 2>/dev/null || true)"
if [ "$PI_HAVE" = "$PI_WANTED" ]; then
  note "pi $PI_HAVE already installed"
else
  note "pi ${PI_HAVE:-missing} -> $PI_WANTED"
  npm install -g "$PI_PACKAGE@$PI_WANTED" --no-audit --no-fund
fi

step "qmd"
QMD_WANTED="$(tr -d '[:space:]' <"$AGENT_DIR/qmd-version")"
QMD_HAVE="$(qmd --version 2>/dev/null | awk '{print $2}' || true)"
if [ "$QMD_HAVE" = "$QMD_WANTED" ]; then
  note "qmd $QMD_HAVE already installed"
else
  note "qmd ${QMD_HAVE:-missing} -> $QMD_WANTED"
  npm install -g "$QMD_PACKAGE@$QMD_WANTED" --no-audit --no-fund
fi

step "extension dependencies"
has_dependencies() {
  jq -e '((.dependencies // {}) + (.devDependencies // {}) + (.peerDependencies // {})) | length > 0' "$1/package.json" >/dev/null
}
for ext in "$AGENT_DIR"/extensions/*/; do
  ext="${ext%/}"
  name="$(basename "$ext")"
  [ -f "$ext/package.json" ] || continue
  if has_dependencies "$ext"; then
    if [ -d "$ext/node_modules" ] && (cd "$ext" && npm ls --depth=0 >/dev/null 2>&1); then
      note "$name: node_modules up to date"
    else
      note "$name: npm install"
      (cd "$ext" && npm install --no-audit --no-fund)
    fi
  elif [ -e "$ext/node_modules" ]; then
    note "$name: node_modules present"
  else
    note "$name: no dependencies; linking $SHARED_NODE_MODULES"
    ln -sfn "$SHARED_NODE_MODULES" "$ext/node_modules"
  fi
done
EXT_MANAGER="$AGENT_DIR/extensions/ext-manager"
if [ -d "$EXT_MANAGER" ]; then
  if [ "$(readlink "$EXT_MANAGER/node_modules" 2>/dev/null)" = "$SHARED_NODE_MODULES" ]; then
    note "ext-manager: node_modules symlink in place"
  elif [ -e "$EXT_MANAGER/node_modules" ] && [ ! -L "$EXT_MANAGER/node_modules" ]; then
    warn "ext-manager/node_modules is a real directory; leaving it"
  else
    ln -sfn "$SHARED_NODE_MODULES" "$EXT_MANAGER/node_modules"
    note "ext-manager: node_modules symlink created"
  fi
fi

step "sleep guard launchd agent ($PLIST_LABEL)"
mkdir -p "$AGENT_DIR/logs" "$AGENT_DIR/run" "$(dirname "$PLIST_TARGET")"
RENDERED="$(mktemp)"
sed "s|\$HOME|$HOME|g" "$PLIST_TEMPLATE" >"$RENDERED"
plutil -lint "$RENDERED" >/dev/null
GUI_DOMAIN="gui/$(id -u)"
if [ -f "$PLIST_TARGET" ] && cmp -s "$RENDERED" "$PLIST_TARGET"; then
  rm -f "$RENDERED"
  note "plist unchanged"
else
  mv "$RENDERED" "$PLIST_TARGET"
  note "plist written to $PLIST_TARGET"
  launchctl bootout "$GUI_DOMAIN/$PLIST_LABEL" 2>/dev/null || true
fi
if launchctl print "$GUI_DOMAIN/$PLIST_LABEL" >/dev/null 2>&1; then
  note "loaded"
else
  launchctl bootstrap "$GUI_DOMAIN" "$PLIST_TARGET"
  note "loaded now"
fi

step "third-party skill find-skills"
if [ -f "$HOME/.agents/skills/find-skills/SKILL.md" ]; then
  note "already installed in ~/.agents/skills"
else
  npx -y skills add vercel-labs/skills --skill find-skills --global --yes
fi

step "company layer"
LAYER_ACTIVE=0
if [ -d "$LAYER_DIR/.git" ]; then
  LAYER_ACTIVE=1
  note "present at $LAYER_DIR"
elif [ -n "$COMPANY_LAYER_REPO" ] && gh repo view "$COMPANY_LAYER_REPO" --json name >/dev/null 2>&1; then
  gh repo clone "$COMPANY_LAYER_REPO" "$LAYER_DIR"
  LAYER_ACTIVE=1
  note "cloned $COMPANY_LAYER_REPO to $LAYER_DIR"
  load_company_env
elif [ -n "$COMPANY_LAYER_REPO" ]; then
  note "gh cannot read $COMPANY_LAYER_REPO (not signed in, or no access)"
else
  note "not configured (run bootstrap.sh --company-repo owner/repo, or set COMPANY_LAYER_REPO)"
fi

step "Shell commands"
mkdir -p "$HOME/.local/bin"
if [ -e "$HOME/.local/bin/wt" ] && [ "$(readlink "$HOME/.local/bin/wt")" != "$AGENT_DIR/bin/wt" ]; then
  note "~/.local/bin/wt exists and is not ours; left alone"
else
  ln -sfn "$AGENT_DIR/bin/wt" "$HOME/.local/bin/wt"
  note "~/.local/bin/wt -> $AGENT_DIR/bin/wt"
fi
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) note "add ~/.local/bin to PATH to use wt from a shell" ;; esac

if [ ! -f "$SETTINGS" ]; then
  cp "$AGENT_DIR/settings.base.json" "$SETTINGS"
  note "settings.json created from settings.base.json"
fi
SETTINGS_MERGE='def merge($a; $b): if ($a|type)=="object" and ($b|type)=="object" then reduce ($b|keys_unsorted[]) as $k ($a; .[$k] = merge($a[$k]; $b[$k])) elif ($a|type)=="array" and ($b|type)=="array" then $a + ($b - $a) elif $b == null then $a else $b end; merge(.[0]; .[1])'
if [ "$LAYER_ACTIVE" = 1 ]; then
  FRAGMENT="$LAYER_DIR/settings-fragment.json"
  if [ -f "$FRAGMENT" ]; then
    tmp="$(mktemp)"
    jq -s "$SETTINGS_MERGE" "$SETTINGS" "$FRAGMENT" >"$tmp"
    if jq -S . "$tmp" | cmp -s - <(jq -S . "$SETTINGS"); then
      rm -f "$tmp"; note "settings.json already includes the company layer's settings-fragment.json"
    else
      mv "$tmp" "$SETTINGS"; note "settings.json: merged the company layer's settings-fragment.json"
    fi
  else
    warn "company layer has no settings-fragment.json; its skills/extensions are not loaded"
  fi

  if [ -n "$COMPANY_REGISTRY_CLI" ] && ! command -v "$COMPANY_REGISTRY_CLI" >/dev/null 2>&1 &&
    [ ! -x "$HOME/.local/bin/$COMPANY_REGISTRY_CLI" ]; then
    if [ -n "$COMPANY_REGISTRY_INSTALL" ]; then
      bash -c "$COMPANY_REGISTRY_INSTALL"
    else
      warn "COMPANY_REGISTRY_INSTALL not set in ../homebase/company.env; registry CLI not installed"
    fi
  elif [ -n "$COMPANY_REGISTRY_CLI" ]; then
    note "$COMPANY_REGISTRY_CLI already installed"
  fi

  if [ ! -f "$AGENT_DIR/models.json" ] && [ -f "$LAYER_DIR/templates/models.json" ]; then
    cp "$LAYER_DIR/templates/models.json" "$AGENT_DIR/models.json"
    chmod 600 "$AGENT_DIR/models.json"
    note "models.json copied from the company layer template"
  elif [ -f "$AGENT_DIR/models.json" ]; then
    note "models.json already present"
  fi
else
  if jq -e '[.. | strings | select(startswith("../homebase"))] | length > 0' "$SETTINGS" >/dev/null; then
    tmp="$(mktemp)"
    jq 'walk(if type == "array" then map(select((type != "string") or (startswith("../homebase") | not))) else . end)' \
      "$SETTINGS" >"$tmp" && mv "$tmp" "$SETTINGS"
    note "settings.json: removed ../homebase entries"
  fi
  cat <<'EOF'
    Personal machine: no company layer. Configure a model provider yourself:
      - run pi and use /login for a subscription provider, or
      - write ~/.pi/agent/models.json for a custom provider (key via a command such as
        "!security find-generic-password -s <name> -w", never the key itself), then set
        defaultProvider / defaultModel in ~/.pi/agent/settings.json.
EOF
fi

step "qmd indexes from the company layer and qmd/"
QMD_CONFIG_DIR_OUT="${QMD_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/qmd}"
QMD_INDEXES=()
while IFS= read -r name; do QMD_INDEXES+=("$name"); done < <("$AGENT_DIR/qmd/render" --list)
if [ ${#QMD_INDEXES[@]} -eq 0 ]; then
  note "no ../homebase/qmd/*.yml.tmpl or qmd/*.yml.tmpl; skipped"
else
  mkdir -p "$QMD_CONFIG_DIR_OUT"
  for name in "${QMD_INDEXES[@]}"; do
    out="$QMD_CONFIG_DIR_OUT/$name.yml"
    rendered="$(mktemp)"
    "$AGENT_DIR/qmd/render" "$name" >"$rendered"
    if [ -f "$out" ] && cmp -s "$rendered" "$out"; then
      rm -f "$rendered"; note "qmd index '$name' config up to date"
    else
      mv "$rendered" "$out"; note "qmd index '$name' config rendered to $out (run: qmd --index $name update && qmd --index $name embed)"
    fi
  done
fi

step "daily-ledger symlink"
if [ -L "$AGENT_DIR/daily-ledger" ]; then
  note "already linked -> $(readlink "$AGENT_DIR/daily-ledger")"
elif [ -d "$AGENT_DIR/../homebase/data" ]; then
  mkdir -p "$AGENT_DIR/../homebase/data/daily-ledger"
  ln -s ../homebase/data/daily-ledger "$AGENT_DIR/daily-ledger"
  note "linked daily-ledger -> ../homebase/data/daily-ledger"
else
  note "../homebase/data missing; skipped"
fi

step "logins to do by hand (this script never stores secrets)"
cat <<'EOF'
    1. gh auth login                      (then re-run bootstrap.sh to install gh-stack and the company layer)
    2. pi -> /login, or the API key source referenced by ~/.pi/agent/models.json
    3. pi mcp login <server>              for each server in ~/.pi/agent/mcp.json (if you use MCP)
    4. databricks auth login --host <workspace-url>
    5. circleci setup                     (if you use CircleCI)
EOF

step "check"
"$AGENT_DIR/bin/pi-doctor" || warn "pi-doctor reported failures (see above)"
