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
