# Earthlab Project Notes

## Current Architecture

Earthlab is intended to be the clean v3 layer system. Use the v2 repo as a behavior reference, not as architecture to copy.

The core model is normalized around layers, channels, and derived rendering:

- Layer state lives under `state.layerState`.
- Layer definitions/defaults live in `src/core/layer-config.js`.
- Style values belong to channels such as `fill` and `line`, not one-off top-level fields.
- UI controls, legend samples, and deck.gl render props should all derive from the same layer/channel state.
- Shared saved colors are handled through `src/core/palette-store.js` and the reusable color control in `src/ui/color-control.js`.

Static layers currently include:

- `earth` as the parent layer/group.
- `ocean.fill`.
- `graticules.line`.
- `land.fill`.
- `land.line`.

## Ordering

`state.layerState.order` is the persisted/UI order. The map paint order is built by reversing that order in `buildLayers()`.

Any derived sample or preview that is supposed to match the map should use the same rule:

```js
[...normalizeRenderOrder(state.layerState.order)].reverse()
```

This matters for the Earth/globe sample, land fill/line legend ordering, and future dynamic layers.

## Appearance

Appearance is separate from layer styling.

Current appearance state:

- `screen`: map/page background color and opacity.
- `settings`: menu/legend surface color, opacity, line color, and line opacity.

The screen background is pre-composited against black and applied as an opaque RGB value to both the page/app background and MapLibre background layer. This avoids mismatch between CSS alpha blending and MapLibre background opacity.

Settings line width is intentionally fixed in CSS at `1.5px`. Do not reintroduce variable settings width unless it is implemented as a non-layout-affecting visual stroke.

## Menu Behavior

The globe button opens the Earth section with children visible.

The gear button opens the Settings section with children visible.

The `Earth` and `Settings` parent rows do not collapse to parent-only mode. Clicking their row surface closes the whole section. Clicking the `Earth` label still toggles Earth visibility.

Rows alternate background by computed DOM depth parity:

- even depth uses `--row-bg-even`
- odd depth uses `--row-bg-odd`

This should scale for future nested rows.

## Add Layer Plan

The first add-layer pass should support Supabase `Add existing`. Upload/create-new can come later.

Recommended modules:

- `src/lib/supabase.js`
- `src/sources/supabase/layer-loader.js`
- `src/ui/add-layer-panel.js`
- optional later: `src/core/dynamic-layer-state.js`

The v2 reference files are:

- `/data/data/com.termux/files/home/layersv2/src/lib/supabase.js`
- `/data/data/com.termux/files/home/layersv2/src/sources/supabase/layer-loader.js`
- `/data/data/com.termux/files/home/layersv2/src/app/create-layer-panel.js`
- `/data/data/com.termux/files/home/layersv2/src/app/bootstrap.js`

Implementation sequence:

1. Add Supabase client/config module.
2. Add catalog loading with `getSupabaseCatalog()`.
3. Add layer loading with `loadLayerFromSupabase()`.
4. Wire `+ Add layer` to open a small panel.
5. List existing Supabase layers.
6. On selection, add a dynamic layer entry under `Earth`.
7. Generate default channels from geometry type:
   - polygon: `fill`, `line`
   - line: `line`
   - point: `point` and optional stroke later
8. Add dynamic render ids to `state.layerState.order`.
9. Extend `buildLayers()` to build dynamic deck.gl layers from the same normalized channel state.
10. Persist dynamic layers and reload them on startup.

Important principle: dynamic layers should use the same pipeline as static layers:

```text
layer/channel state -> derived control rows -> derived legend sample -> derived render spec
```

Avoid recreating v2's separate row model inside Earthlab.

## Share Architecture

The share system should be user-friendly first:

- one click `Share`
- copy a short URL
- visiting that URL later should recreate the exact map configuration from the moment `Share` was clicked

Do not use long encoded URLs as the primary product path. Keep any encoded hash export only as an optional future fallback/dev tool.

### Canonical Model

Use immutable snapshot records.

Each share action should create a new saved snapshot, not mutate an older one. This gives the cleanest user mental model:

- shared URLs are permanent
- shared URLs reproduce exact historical state
- later local edits do not silently change previously shared links

Recommended table shape for now:

- `map_shares`
  - `id`
  - `snapshot`
  - `title`
  - `created_at`

Recommended future fields:

- `user_id`
- `slug`
- `is_public`
- `archived_at`

### Snapshot Contents

The snapshot should include:

- map title
- map view (`center`, `zoom`, `bearing`, `pitch`)
- appearance state
- Earth/static layer state
- dynamic layer order
- dynamic layer visibility
- dynamic layer channel styling

The snapshot should not include:

- raw GeoJSON
- fetched Supabase metadata that can be reloaded by layer id
- transient UI state such as expanded/collapsed panels

Dynamic layers should be restored by layer id and then hydrated through the normal Supabase loading path.

### URL Shape

Use a short share URL, for example:

- `?share=<id>`

Later, this can evolve cleanly to:

- `/m/<slug>`

Keep the underlying snapshot format the same so future custom URLs/slugs build on the same persistence model.

### Product Direction

Short-term:

- unlimited immutable share snapshots
- no management UI required yet
- no user gating required yet

Future:

- per-user share limits
- saved map management
- custom URLs/slugs for paid users
- a higher-level `maps` model on top of immutable published snapshots if needed

### Implementation Sequence

1. Add Supabase helpers for creating/fetching `map_shares`.
2. Reuse the existing snapshot builder as the canonical saved payload.
3. Change the Share button to save a snapshot and copy a short URL.
4. On app boot, if a share id is present, load that snapshot before normal hydration.
5. Apply snapshot state, then let dynamic layers load through the normal layer loader.
6. Keep local storage as the user's local working state, but let shared URLs override it on initial load.

### Principle

The shared URL should represent a published immutable snapshot, not a live mutable working session.
