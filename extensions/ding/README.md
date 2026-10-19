# Ding Extension

Plays a short pitched tick (`Tink.aiff`) every time the agent finishes a turn — so you know to look back at the terminal.

Each running pi process picks its own pitch from a 10‑note scale (derived from `process.pid`), so when several pi instances are open at once you can tell them apart by ear without looking.

> macOS only — uses the built‑in `afplay`. On other platforms the extension is a no‑op.

## How it works

- Listens for the `agent_settled` lifecycle event (fires once pi is truly idle, not on intermediate retries).
- Plays `/System/Library/Sounds/Tink.aiff` via `afplay -r <rate>`, where `rate` is a playback‑rate multiplier that shifts both pitch and tempo.
- The rate is `RATES[process.pid % 10]` where `RATES` is 10 values log‑spaced from `0.5×` to `4.0×` (each step is **4 semitones / 400 cents / a major third**).

| Slot | Rate | f₀ | Duration |
| ---: | ---: | ---: | ---: |
| 0 | 0.50× | 349 Hz | 1128 ms |
| 1 | 0.63× | 440 Hz | 895 ms |
| 2 | 0.79× | 555 Hz | 711 ms |
| 3 | 1.00× | 699 Hz | 564 ms |
| 4 | 1.26× | 880 Hz | 448 ms |
| 5 | 1.59× | 1109 Hz | 355 ms |
| 6 | 2.00× | 1397 Hz | 282 ms |
| 7 | 2.52× | 1761 Hz | 224 ms |
| 8 | 3.17× | 2218 Hz | 178 ms |
| 9 | 4.00× | 2795 Hz | 141 ms |

The 400‑cent spacing was chosen so each slot sounds distinctly different in isolation — narrower spacings (e.g. 200 cents) only feel distinct when played back‑to‑back, not when heard alone in different terminals.

## Commands

- `/ding` — play this process's tick and report its slot/rate.

## Customising

Edit `extensions/ding/index.ts`:

- **Different sound:** change `SOUND` to any path. macOS ships sounds in `/System/Library/Sounds/` (Glass, Pop, Ping, Frog, etc.).
- **Different scale:** edit `RATES`. Values are `afplay -r` multipliers — `1.0` = unchanged, `2.0` = one octave up, `0.5` = one octave down.
- **Stable per‑project pitch instead of per‑process:** swap `process.pid` for a hash of `process.cwd()`.
