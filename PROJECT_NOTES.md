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

## Startup and Load Order

Startup should optimize for perceived speed and visual consistency:

- page/app base background should be pure black from first paint
- avoid any inline boot background that disagrees with the eventual map background
- show the collapsed panel header as early as possible
- keep secondary controls hidden until the map is meaningfully ready

Current intended startup hierarchy:

1. black base background
2. collapsed header shell visible as soon as its styling is ready
3. MapLibre background layer initializes
4. low-detail land (`landLow`) loads and becomes the first meaningful globe render
5. full panel body and secondary floating controls reveal at `ready`
6. graticules and other deferred content load after that

Important:

- `ready` should stay tied to the first meaningful Earth render, not to every secondary layer finishing
- `Share` and similar secondary floating controls should not appear before `ready`
- the header (`Layers` / `=`) may be gated separately from the main panel body so it can appear earlier without flashing unstyled UI

## Toolbar vs Sample Icons

Toolbar icons and row samples serve different roles and should not share one renderer by default.

- toolbar icons are stable controls
- row samples are live previews

Current intended behavior:

- top toolbar globe uses fixed default Earth styling and default Earth order
- top toolbar gear uses fixed default styling
- Earth row sample remains live and should update with current Earth styling/order

If a toolbar icon and a row sample ever diverge in behavior, split their render functions rather than forcing one shared renderer to handle both.

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

## Supabase Schema

Reference implementation: `/data/data/com.termux/files/home/layersv2/src/sources/supabase/layer-loader.js`

### Key tables

**`layers`**
- `id` — UUID, primary key
- `name` — display label
- `geometry_type` — legacy single value (`point`, `line`, `area`, `mixed`)
- `geometry_types` — array, preferred over `geometry_type`
- `default_style` — JSONB: `{ color, opacity, lineWidth, pointRadius }`
- `view_access` — `public` | `unlisted` | `private`

**`datasets`**
- `id` — UUID, primary key
- `layer_id` — FK to `layers`
- `name` — display label for this dataset
- `geometry_type` / `geometry_types` — same pattern as layers
- `field_schema` — JSONB array of field definitions: `[{ name, type, label, ... }]`
- `render_format` — e.g. `geojson`, `pmtiles`
- `artifact_url` — URL for derived render artifact (PMTiles etc.)
- `feature_count`
- `created_at`

One layer may have many datasets. By default all datasets for a layer render together as one visual layer.

**`features`**
- `dataset_id` — FK to `datasets`
- `geometry` — PostGIS geometry
- `properties` — JSONB

### Key functions (from v2 layer-loader.js)

- `getSupabaseCatalog()` — fetches all public/unlisted layers (`id`, `name`, `geometry_type`, `geometry_types`)
- `getLayerDatasets(layerId)` — fetches all datasets for a layer with full schema
- `getLayerFields(layerId)` — merges `field_schema` across all datasets for a layer, returns `{ fields }`
- `getLayerFieldValues(layerId, field)` — distinct sorted values for a field (sampled up to 200 features)
- `getLayerTablePreview(layerId, { limit, offset, datasetId })` — paginated feature rows, optionally scoped to one dataset

### Filter panel data model

When building the filter panel for a dynamic layer:

1. Call `getLayerDatasets(layerId)` to get all datasets
2. If >1 dataset → show dataset dropdown (use `dataset.name` as label, `dataset.id` as value)
3. Always show column dropdown — sourced from the selected dataset's `field_schema`, or merged fields if no dataset selected
4. `field_schema` entries have at minimum `name` and `type`; use `label` if present, fall back to `name`

### Field types (from field_schema)

Common values for `type`: `text`, `number`, `integer`, `boolean`, `date`, `timestamp`. Use type to determine appropriate filter UI (range slider for numeric, toggle/select for text/boolean, date picker for temporal).

## Print Projection Architecture

### Direction

Long term, the print renderer should be a separate projection-first pipeline:

- `MapLibre` remains the interactive web renderer
- `Deck` becomes the print renderer
- `d3-geo` owns projection math

### Principle

Do not rely on `geoPath(..., collector)` output as direct polygon geometry for deck fill layers, especially for orthographic and other clipped projections.

Instead:

1. Keep source data as geographic GeoJSON in lon/lat
2. Project geometry through `d3-geo`
3. Clip geometry explicitly to the active projection boundary when needed
4. Rebuild valid projected polygons, lines, and points as normalized XY geometry
5. Pass only that normalized XY geometry into deck layers

### Required Internal Module

Add a dedicated print geometry projection layer, likely something like:

- `src/print/project-geometry.js`

Responsibilities:

- accept geographic GeoJSON plus a projection function
- return normalized projected geometry buckets:
  - `polygons`
  - `lines`
  - `points`
- preserve multipolygons and holes correctly
- handle projection-edge clipping explicitly
- become the shared foundation for land, ocean, graticules, dynamic layers, and filters

### Orthographic Note

For orthographic specifically, the hard part is correct visible-hemisphere clipping and valid ring reconstruction after clipping.

That is the main blocker to a robust long-term print renderer, and it should be solved in the projection pipeline rather than patched at the rendering layer.

### Unified Print Camera Model

Print mode should move toward one shared interaction model for orthographic and flat projections.

Desired behavior:

- all print projections start in a canonical full-map fit state
- this default state is treated as `locked`
- user can explicitly `unlock` the projection to move within that projection
- relocking returns to the canonical full-map fit for that projection

Recommended rules:

- switching projection defaults to locked full-map fit
- unlocked camera state should be stored per projection
- relocking should discard the transient unlocked position and return to the canonical fit

This should replace the current conceptual split where orthographic behaves like a movable globe camera and flat projections behave like a fitted map with pan/zoom layered on top.

### Print Document State

If print mode is going to support undo plus future movable/resizable print elements, it needs a dedicated print document model rather than ad hoc state in DOM nodes and render helpers.

Recommended structure:

- `printDocument.layout`
  - paper ratio
  - frame inset
  - preview overlay visibility
- `printDocument.camera`
  - projection
  - locked/unlocked state
  - per-projection unlocked camera
  - canonical fit state
- `printDocument.items`
  - title
  - legend
  - future annotations / scalebar / north arrow

Example title fields:

- `text`
- `x`
- `y`
- `width`
- `fontSize`
- `fontFamily`
- `fontWeight`
- `color`
- `visible`

### Undo Direction

Undo should be snapshot-based, not command-based.

Recommended undo scope for print mode:

- `printDocument`
- `layerState`
- land quality

Guidelines:

- only capture undo history while in print mode
- restore title and future print annotations through `printDocument`, not through DOM-specific special cases
- do not include derived loaded dataset payloads in history snapshots; restore config/state and reuse loaded data already in memory

This gives a scalable path for future print features like title resizing, title movement, legend placement, and projection unlock state without having to keep bolting special cases onto `print-view.js`.
