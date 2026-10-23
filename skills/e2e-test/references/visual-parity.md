# Visual parity: baseline build vs change build

Adapted from pstack's visual-parity playbook (MIT, Lauren Tan).

Use this when a change must not alter what the user sees (a refactor, a component or CSS migration,
a dependency upgrade), or must alter it only in named regions. Equivalence is proven by image diff,
not by eye.

## Rules

1. **The baseline is the spec.** The baseline is the build without the change (usually current
   `main`). Capture it first, before judging the change. No baseline, no parity claim.
2. **No shortcuts.** Do not edit the capture script between the baseline and the change run, do not
   recapture or touch the baseline images to make a diff pass, do not restructure the component to
   make a diff pass, and do not raise `--fuzz` or add masks after seeing a diff. If the baseline looks
   wrong, stop and ask the human.
3. **One surface at a time.** When several components or pages migrate, take each to zero diff
   before the next. Shared primitives (buttons, typography, layout) go first, because every other
   surface depends on them. Parallel work on separate surfaces uses separate worktrees, one owner
   per surface.

## Capture

Write the list of surfaces × states before any capture: each page or component, and each state
that renders differently (empty, filled, error, loading finished, open menu, hover, narrow viewport).
This list is the parity answer key; a state not on it is not covered.

Capture both builds with the same script, `scripts/capture-states.js`:

```bash
node scripts/capture-states.js <baseline-url> states.json <evidence>/baseline [storage-state.json]
node scripts/capture-states.js <baseline-url> states.json <evidence>/baseline-2 [storage-state.json]
node scripts/capture-states.js <change-url>   states.json <evidence>/change   [storage-state.json]
```

It fixes the viewport, device scale 1, reduced motion, light scheme, `en-US`, UTC, disabled
animations and a hidden caret, waits for network idle and fonts, and masks the selectors listed per
state. Mask only content that is dynamic by nature (clocks, relative dates, random IDs, avatars
from a CDN), and decide the masks before the first capture.

Keep everything else identical between the two runs: same machine, same browser build, same
account, same data (a DB copy restored to the same snapshot for both), same feature flags. Run the
builds one after the other on separate ports, or on two deployed environments only if both are
seeded identically.

The MCP Playwright server is fine for exploring a page and finding selectors. For the parity capture
itself use the script: an MCP screenshot does not pin scale, motion, fonts or masks, so two of them
can differ with no code change.

## Prove the harness is stable

Diff the baseline against the second baseline capture:

```bash
scripts/visual-diff.sh --expect <state-count> <evidence>/baseline <evidence>/baseline-2 <evidence>/noise
```

It must report 0 differing pixels on every image. If it does not, the capture is nondeterministic:
fix the cause (an unmasked dynamic region, an animation, a late-loading font or image) and recapture
both. Do not compensate with a threshold.

## Diff and threshold

```bash
scripts/visual-diff.sh --expect <state-count> <evidence>/baseline <evidence>/change <evidence>/diff
```

Each row is `name  verdict  diff_pixels  total_pixels`; verdicts are SAME, DIFF, SIZE (page height
or width changed), MISSING and EXTRA. It writes a highlighted `<name>.diff.png` per differing image
and `summary.tsv`, then a `STATES expected=… baseline=… change=… same=…` line. Pass `--expect` the
number of states in `states.json`; exit 0 only when everything is SAME and both directories hold
exactly that many images. An empty baseline or change directory exits 2, so zero images can never
pass. `capture-states.js` likewise refuses an empty or unnamed state list and ends with
`STATES expected=… captured=… failed=…`.

- **Parity change** (must look identical): the threshold is 0 pixels at `--fuzz 0`. Any DIFF or
  SIZE is a fail. Open the diff image, find the element that moved or changed color, and fix the
  change, then recapture the change build only.
- **Intended visual change**: write down beforehand which states and which region of each should
  change. A diff inside those regions is expected and goes in the report with its image; a diff in
  any other state or region is a fail, exactly as above.
- `--fuzz <percent>` (per-channel tolerance) is only for a documented rendering difference between
  two machines or browser builds, agreed with the human before the run and stated in the report.

## Report

One table per surface: state · verdict · differing pixels / total · diff image path. Then the
baseline and change SHAs, the capture command and states file path, the masks used, the
baseline-vs-baseline result, any fuzz used and why, and what is left unverified (states not
captured, surfaces not migrated). Give full absolute paths to the evidence directory.
