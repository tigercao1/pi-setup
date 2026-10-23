#!/usr/bin/env bash
# Usage: visual-diff.sh [--fuzz <percent>] [--expect <state-count>] <baseline-dir> <change-dir> <out-dir>
# Compares every PNG in <baseline-dir> with the same file name in <change-dir> using ImageMagick.
# Writes <out-dir>/<name>.diff.png for each differing pair and <out-dir>/summary.tsv.
# Prints one row per image: name, verdict (SAME | DIFF | SIZE | MISSING | EXTRA), differing pixels, total pixels.
# Ends with: STATES expected=<n|-> baseline=<n> change=<n> same=<n>. An empty baseline or change set is an error.
# Exit 0 when every image is SAME and the counts match --expect, 1 when not, 2 on usage, empty sets or tool errors.
set -euo pipefail

fuzz=0
expect=""
while (($#)); do
  case "$1" in
    --fuzz) fuzz="${2:?--fuzz needs a percent}"; shift 2 ;;
    --expect)
      [[ "${2:-}" =~ ^[1-9][0-9]*$ ]] || { echo "--expect needs a positive state count" >&2; exit 2; }
      expect="$2"; shift 2 ;;
    -h|--help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown flag: $1" >&2; exit 2 ;;
    *) break ;;
  esac
done
(($# == 3)) || { echo "usage: visual-diff.sh [--fuzz <percent>] [--expect <state-count>] <baseline-dir> <change-dir> <out-dir>" >&2; exit 2; }
base="$1"; change="$2"; out="$3"
[[ -d "$base" && -d "$change" ]] || { echo "baseline and change must be directories" >&2; exit 2; }

if command -v magick >/dev/null 2>&1; then
  im=(magick); compare_cmd=(magick compare); identify_cmd=(magick identify)
elif command -v compare >/dev/null 2>&1; then
  im=(convert); compare_cmd=(compare); identify_cmd=(identify)
else
  echo "ImageMagick not found (brew install imagemagick)" >&2; exit 2
fi

shopt -s nullglob
base_pngs=("$base"/*.png)
change_pngs=("$change"/*.png)
report_counts() { echo "STATES expected=${expect:--} baseline=${#base_pngs[@]} change=${#change_pngs[@]} same=$1"; }
if ((${#base_pngs[@]} == 0 || ${#change_pngs[@]} == 0)); then
  report_counts 0
  echo "empty capture set: baseline and change must each hold at least one PNG" >&2
  exit 2
fi

mkdir -p "$out"
summary="$out/summary.tsv"
printf 'name\tverdict\tdiff_pixels\ttotal_pixels\n' > "$summary"
status=0
same=0

row() { printf '%s\t%s\t%s\t%s\n' "$@" | tee -a "$summary"; }

for b in "${base_pngs[@]}"; do
  name=$(basename "$b")
  c="$change/$name"
  if [[ ! -f "$c" ]]; then row "$name" MISSING - -; status=1; continue; fi
  bsize=$("${identify_cmd[@]}" -format '%wx%h' "$b")
  csize=$("${identify_cmd[@]}" -format '%wx%h' "$c")
  if [[ "$bsize" != "$csize" ]]; then row "$name" SIZE "$bsize->$csize" -; status=1; continue; fi
  total=$(( ${bsize%x*} * ${bsize#*x} ))
  diff_png="$out/${name%.png}.diff.png"
  pixels=$("${im[@]}" "$b" "$c" -compose difference -composite -separate -evaluate-sequence max \
    -threshold "${fuzz}%" -format '%[fx:round(mean*w*h)]' info:) \
    || { echo "compare failed on $name" >&2; exit 2; }
  if [[ "$pixels" == "0" ]]; then
    rm -f "$diff_png"; row "$name" SAME 0 "$total"; same=$((same + 1))
  else
    "${compare_cmd[@]}" "$b" "$c" "$diff_png" 2>/dev/null || true
    row "$name" DIFF "$pixels" "$total"; status=1
  fi
done

for c in "${change_pngs[@]}"; do
  name=$(basename "$c")
  [[ -f "$base/$name" ]] || { row "$name" EXTRA - -; status=1; }
done

report_counts "$same"
if [[ -n "$expect" ]] && ((${#base_pngs[@]} != expect || ${#change_pngs[@]} != expect)); then
  echo "state count mismatch: expected $expect" >&2
  status=1
fi
exit "$status"
