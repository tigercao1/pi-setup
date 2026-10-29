#!/bin/bash
# Assemble the pi-starter hosted package into dist/ from the live extensions, with an explicit
# allowlist, then check it against the registry's hosted-package rules and for personal strings.
#
#   ./build.sh            build dist/ and check it
#   (cd dist && hb-registry publish --dry-run)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SRC="$ROOT/extensions"
OUT="$HERE/dist"

EXTENSIONS=(
  _shared
  agent-orchestrator
  session-bus
  session-fork
  tab-title
  no-sleep-while-working
  context-watcher
  lead-output-cap
  worktree
  notify
  jev
)
FORBIDDEN='ycao|tigercao1|/Users/|tiger-voice|pioneerworks'
MAX_FILES=200
MAX_FILE_BYTES=$((512 * 1024))
MAX_TOTAL_BYTES=$((5 * 1024 * 1024))

die() { echo "build.sh: $*" >&2; exit 1; }
for tool in git jq python3; do command -v "$tool" >/dev/null || die "needs $tool"; done

copy_file() {
  local from="$1" to="$2"
  [ -f "$from" ] && [ ! -L "$from" ] || die "missing or not a regular file: $from"
  mkdir -p "$(dirname "$to")"
  cp "$from" "$to"
}

rm -rf "$OUT"
mkdir -p "$OUT"

for ext in "${EXTENSIONS[@]}"; do
  [ -d "$SRC/$ext" ] || die "extension $ext not found in $SRC"
  found=0
  while IFS= read -r -d '' file; do
    rel="${file#"$SRC/"}"
    copy_file "$file" "$OUT/extensions/$rel"
    found=$((found + 1))
  done < <(find "$SRC/$ext" \( -name node_modules -o -name tests -o -name '.*' \) -prune -o \
    -type f \( -name '*.ts' -o -name '*.md' -o -name 'models.example.json' \) -print0)
  [ "$found" -gt 0 ] || die "nothing copied from $SRC/$ext"
done

copy_file "$ROOT/bin/pi-pause-facts" "$OUT/bin/pi-pause-facts"
copy_file "$ROOT/bin/wt" "$OUT/extensions/worktree/bin/wt"
chmod 755 "$OUT/bin/pi-pause-facts" "$OUT/extensions/worktree/bin/wt"
copy_file "$HERE/skills/recall/SKILL.md" "$OUT/skills/recall/SKILL.md"
for f in hb-registry.json package.json README.md; do copy_file "$HERE/$f" "$OUT/$f"; done

python3 - "$OUT" <<'PY'
import sys
out = sys.argv[1]
strips = {
    "extensions/agent-orchestrator/config.ts": [
        ('skills: ["pr-approval-review", "github-cli", "tiger-voice", "clear-message"],',
         'skills: ["pr-approval-review", "github-cli", "clear-message"],'),
        ('"and tiger-voice + clear-message for drafted comments",', '"and clear-message for drafted comments",'),
    ],
    "extensions/agent-orchestrator/README.md": [
        ("`pr-approval-review`, `github-cli`, `tiger-voice`, `clear-message`,",
         "`pr-approval-review`, `github-cli`, `clear-message`,"),
    ],
}
for rel, pairs in strips.items():
    path = f"{out}/{rel}"
    text = open(path, encoding="utf-8").read()
    for old, new in pairs:
        if text.count(old) != 1:
            sys.exit(f"build.sh: strip target not found exactly once in {rel}: {old!r}")
        text = text.replace(old, new)
    open(path, "w", encoding="utf-8").write(text)
PY

SHA="$(git -C "$ROOT" rev-parse HEAD)"
DIRTY="$(git -C "$ROOT" status --porcelain -- extensions bin/pi-pause-facts bin/wt bundles/pi-starter | wc -l | tr -d ' ')"
{
  echo "source_commit: $SHA"
  echo "source_branch: $(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
  echo "source_uncommitted_paths: $DIRTY"
} >"$OUT/BUILD_INFO"
[ "$DIRTY" = 0 ] || echo "build.sh: WARNING: $DIRTY uncommitted source path(s); dist does not match $SHA exactly" >&2

PROBLEMS=()

NAME_VERSION_PKG="$(jq -r '"\(.name)@\(.version)"' "$OUT/package.json")"
NAME_VERSION_MANIFEST="$(jq -r '"\(.name)@\(.version)"' "$OUT/hb-registry.json")"
[ "$NAME_VERSION_PKG" = "$NAME_VERSION_MANIFEST" ] || PROBLEMS+=("package.json is $NAME_VERSION_PKG but hb-registry.json is $NAME_VERSION_MANIFEST")
[ "$(jq -r '.description | length <= 300' "$OUT/hb-registry.json")" = true ] || PROBLEMS+=("hb-registry.json description is over 300 characters")

WANT_ENTRIES="$(for ext in "${EXTENSIONS[@]}"; do [ "$ext" = _shared ] || echo "./extensions/$ext/index.ts"; done | sort)"
HAVE_ENTRIES="$(jq -r '.pi.extensions[]' "$OUT/package.json" | sort)"
[ "$WANT_ENTRIES" = "$HAVE_ENTRIES" ] || PROBLEMS+=("pi.extensions does not list exactly the allowlisted extensions (minus _shared)")
while IFS= read -r entry; do
  [ -f "$OUT/$entry" ] || PROBLEMS+=("pi.extensions entry $entry is missing from dist")
done <<<"$HAVE_ENTRIES"
[ ! -e "$OUT/extensions/_shared/index.ts" ] || PROBLEMS+=("_shared has an index.ts and would load as an extension")

check_imports() {
  python3 - "$OUT" <<'PY'
import json, os, re, sys
out = sys.argv[1]
peers = set(json.load(open(f"{out}/package.json"))["peerDependencies"])
builtin = set(json.loads(os.popen("node -p 'JSON.stringify(require(\"module\").builtinModules)'").read() or "[]"))
spec_re = re.compile(
    r"""^\s*(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"'\n]+)["']|^\s*import\s*["']([^"'\n]+)["']|\bimport\(\s*["']([^"'\n]+)["']\s*\)""",
    re.M,
)
for root, _, files in os.walk(out):
    for f in files:
        if not f.endswith(".ts"):
            continue
        path = os.path.join(root, f)
        for groups in spec_re.findall(open(path, encoding="utf-8").read()):
            spec = next(g for g in groups if g)
            rel = os.path.relpath(path, out)
            if spec.startswith("."):
                target = os.path.normpath(os.path.join(os.path.dirname(path), spec))
                if not os.path.isfile(target):
                    print(f"{rel} imports {spec}, which is not in dist")
            elif spec.startswith("node:") or spec.split("/")[0] in builtin:
                continue
            else:
                pkg = "/".join(spec.split("/")[:2]) if spec.startswith("@") else spec.split("/")[0]
                if pkg not in peers:
                    print(f"{rel} imports {spec}, which is not a peerDependency")
PY
}
IMPORT_PROBLEMS="$(check_imports)"
[ -z "$IMPORT_PROBLEMS" ] || PROBLEMS+=("unresolved imports:"$'\n'"$IMPORT_PROBLEMS")

BAD_ENTRIES="$(cd "$OUT" && find . \( -type l -o -name node_modules -o -name .git -o -name .DS_Store -o -name registry.json -o -name tests \) | sed 's|^\./||')"
[ -z "$BAD_ENTRIES" ] || PROBLEMS+=("forbidden entries in dist:"$'\n'"$BAD_ENTRIES")

LEAKS="$(cd "$OUT" && grep -rniE "$FORBIDDEN" . || true)"
[ -z "$LEAKS" ] || PROBLEMS+=("personal strings ($FORBIDDEN) in dist:"$'\n'"$LEAKS")

FILE_COUNT="$(cd "$OUT" && find . -type f | wc -l | tr -d ' ')"
TOTAL_BYTES=0
BIGGEST=0
BIGGEST_FILE=""
while IFS= read -r -d '' file; do
  size="$(wc -c <"$file" | tr -d ' ')"
  TOTAL_BYTES=$((TOTAL_BYTES + size))
  if [ "$size" -gt "$BIGGEST" ]; then BIGGEST="$size"; BIGGEST_FILE="${file#"$OUT/"}"; fi
  [ "$size" -le "$MAX_FILE_BYTES" ] || PROBLEMS+=("${file#"$OUT/"} is $size bytes, over $MAX_FILE_BYTES")
done < <(find "$OUT" -type f -print0)
[ "$FILE_COUNT" -le "$MAX_FILES" ] || PROBLEMS+=("$FILE_COUNT files, over $MAX_FILES")
[ "$TOTAL_BYTES" -le "$MAX_TOTAL_BYTES" ] || PROBLEMS+=("$TOTAL_BYTES bytes in all, over $MAX_TOTAL_BYTES")

echo "dist: $OUT"
echo "source: $SHA ($DIRTY uncommitted source paths)"
echo "files: $FILE_COUNT (limit $MAX_FILES)"
echo "total: $TOTAL_BYTES bytes, $(((TOTAL_BYTES + 1023) / 1024)) KB (limit $((MAX_TOTAL_BYTES / 1024)) KB)"
echo "largest: $BIGGEST_FILE, $BIGGEST bytes (limit $MAX_FILE_BYTES)"

if [ "${#PROBLEMS[@]}" -gt 0 ]; then
  printf 'build.sh: FAIL: %s\n' "${PROBLEMS[@]}" >&2
  exit 1
fi
echo "checks: passed (allowlist, pi.extensions, imports, no symlinks/node_modules/.git, personal strings, registry limits)"
