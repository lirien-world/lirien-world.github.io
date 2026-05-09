# Echoes — Pipeline & Schema Reference

Lirien's Echoes is the jukebox subsite at `/echoes/`. This file
documents how its data files work and the conventions that the
runtime depends on.

For the full "add a new music track" recipe, see
`assets/music/PIPELINE.md` in the outer repo. This file covers the
echoes-specific bits.

---

## File map

```
website/echoes/
├── index.html               ← the whole UI + runtime, single file
├── tracks.json              ← HAND-AUTHORED track list
├── music_progression.json   ← GENERATED from test.ink — do not edit
├── manifest.webmanifest     ← PWA manifest (Add to Home Screen)
├── sw.js                    ← service worker (cache-as-you-go)
├── apple-touch-icon.png     ← icons (regenerated from canonical
├── favicon-*.png                 source at
├── icon-*.png                    assets/canonical/icons/
├── icon-mask-*.png               lirien_echoes_source_1254.png)
└── spiral.png               ← centerpiece graphic
```

The runtime fetches audio from `../lirien/music/` and atmosphere
images from `../lirien/atmosphere/` — the jukebox does NOT keep its
own copies. One source of truth for the deployed assets.

---

## tracks.json — schema

Hand-authored JSON array. Each entry:

```json
{
  "file":    "<basename>.m4a",   // resolved against MUSIC_BASE
                                 // ("../lirien/music/") unless it
                                 // starts with "../" (root-relative)
  "chapter": <number | "unused" | "minimal">,
  "title":   "<display title>",
  "caption": "<one-line caption shown under the title>",
  "image":   "<basename>.png",   // resolved against ATMOS_BASE
                                 // ("../lirien/atmosphere/"); empty
                                 // string falls back to the wide
                                 // Solrien hero vista
  "loop":    true                // optional; only honoured in
                                 // minimal mode (see anchor)
}
```

### `chapter` field — the three values that matter

| value | meaning | visible in `played` | visible in `all` | visible in `minimal` |
|-------|---------|:-:|:-:|:-:|
| `<number>` (1, 2, 3, …) | first chapter the track plays in test.ink | only if reader has heard it | yes | no |
| `"unused"` | track exists but never plays in test.ink | no | yes | no |
| `"minimal"` | always-on anchor (Lirien Remembers) | **always** | **always** | **only this** |

The `"minimal"` value is overloaded as both the minimal-mode-only
filter AND the "always include in every mode" flag. There is exactly
one entry with this value: Lirien Remembers. If you want a second
always-on track, refactor to a dedicated `"always": true` flag — see
the bottom of this doc for that conversation.

---

## The Lirien Remembers anchor — DO NOT BREAK

The entry:

```json
{"file":"../lirien_theme.mp3", "chapter":"minimal",
 "title":"Lirien Remembers",
 "caption":"the theme song for Lirien",
 "image":"",
 "loop":true}
```

The runtime in `index.html` (function `visibleIndices()`) special-
cases `chapter === "minimal"` to be **always included** across
played + all + minimal modes. This is intentional:

- **minimal** mode: ONLY this track plays, on loop, on the wide
  Solrien vista. This is the default for new visitors with no save.
- **played** mode: this track is the always-on floor. With no save,
  it's the only thing the user gets. With ink-position progress, it
  rides alongside the heard tracks.
- **all** mode: every track including this one.

The `loop:true` flag is honoured **only in minimal mode** (the
runtime gates it with `&& content === "minimal"`). In played/all
rotation, the track ends and yields to `next()` like any other
track — without the gate, it would loop forever and stall the queue.

---

## music_progression.json — generated, never edit

Produced by `tools/extract_music_progression.py` (in the outer
repo). Schema:

```json
{
  "knots":  { "<knot_name>": <line_number_in_test.ink>, ... },
  "tracks": { "<name>.m4a":  <earliest_unlock_line>,    ... },
  "ink_path": "assets/narrative/test.ink",
  "generated_at": "2026-05-09T00:34:11Z"
}
```

The runtime's "played" mode reads it to determine which tracks the
user has actually heard, by comparing the user's saved
`previousContentObject` (knot name) against the track unlock lines.

**Lirien Remembers will never appear in this file.** It is not in
test.ink — it lives purely in the echoes runtime as the theme song.
The always-on anchor in `tracks.json` (chapter:"minimal") is what
surfaces it; this file only knows about story tracks.

To regenerate after editing `test.ink`:

```bash
python3 tools/extract_music_progression.py
```

Wholesale overwrite — safe to re-run any time.

---

## sw.js — when to bump CACHE_NAME

The service worker caches audio + images + the JSON manifests. When
you change `tracks.json` or `music_progression.json`, **bump
`CACHE_NAME`** (e.g. `lirien-jukebox-v3` → `lirien-jukebox-v4`) so
existing clients drop their stale cache and fetch the new version on
next navigation.

`index.html` is **not** SW-cached (HTML passes through). So pure-UI
changes don't need a bump; only data-file or manifest changes do.

The user-facing `?clear-cache` URL parameter purges the cache
without a version bump (handled by the page → SW message channel).
Useful for debugging.

---

## Future: adding a second always-on track

If you ever want a second "always present in every mode" track, the
clean refactor is:

1. Add an `"always": true` flag to the relevant `tracks.json` entries.
2. Replace `chapter === "minimal"` checks in `visibleIndices()`,
   `setBg()`, `applyCaptionForCurrent()`, and the loop gate with
   `track.always` checks.
3. Keep `chapter:"minimal"` as a separate dimension that controls
   which tracks appear in minimal mode specifically.

Until then, the overload is fine — it's exactly one track, and the
schema lives entirely inside one repo.
