import maplibregl from "maplibre-gl";
import { LayerExtension } from "@deck.gl/core";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { GeoJsonLayer, SolidPolygonLayer } from "@deck.gl/layers";
import {
  buildDefaultLayerState,
  getChannelTarget,
  getLayerVisibility,
  normalizeLayerState,
  normalizeRenderOrder,
} from "./core/layer-config.js";
import { createPaletteStore, normalizeHexColor } from "./core/palette-store.js";
import { mountColorControl } from "./ui/color-control.js";
import "./styles.css";

const LAND_LOW_URL = "/data/world-atlas/ne_110m_land.geojson";
const GRATICULES_URL = "/data/graticules/world-graticules-10deg.geojson";
const OCEAN_RING = [[
  [-180, -90],
  [180, -90],
  [180, 90],
  [-180, 90],
  [-180, -90],
]];

const STORAGE_KEY = "earthlab.earth.style.v1";
const HORIZON_CLIP_EPSILON = 0.002;
const PALETTE_BINDINGS = [
  { controlId: "oceanColorControl", layerId: "ocean", channelId: "fill" },
  { controlId: "graticulesColorControl", layerId: "graticules", channelId: "line" },
  { controlId: "landFillColorControl", layerId: "land", channelId: "fill" },
  { controlId: "landLineColorControl", layerId: "land", channelId: "line" },
];

const state = {
  map: null,
  overlay: null,
  landLow: null,
  land: null,
  graticules: null,
  layerState: readLayerState(),
  expandedRows: {
    ocean: false,
    graticules: false,
    land: false,
  },
  activeChildPanelByRow: {
    land: null,
  },
  drag: null,
  panelCollapsed: false,
  earthLayersExpanded: true,
  earthExpanded: true,
};

const paletteStore = createPaletteStore();
const paletteControls = new Map();

function setBootStage(stage) {
  document.body.dataset.earthlabStage = stage;
}

const hemisphereClipModule = {
  name: "hemisphereClip",
  vs: `\
layout(std140) uniform hemisphereClipUniforms {
  float enabled;
  float horizonEpsilon;
  vec3 cameraPosition;
} hemisphereClip;
`,
  fs: `\
layout(std140) uniform hemisphereClipUniforms {
  float enabled;
  float horizonEpsilon;
  vec3 cameraPosition;
} hemisphereClip;
`,
  uniformTypes: {
    enabled: "f32",
    horizonEpsilon: "f32",
    cameraPosition: "vec3<f32>",
  },
};

class HemisphereClipExtension extends LayerExtension {
  static extensionName = "HemisphereClipExtension";
  static defaultProps = {
    clipEnabled: true,
    clipHorizonEpsilon: HORIZON_CLIP_EPSILON,
  };

  getShaders() {
    return {
      modules: [hemisphereClipModule],
      inject: {
        "vs:#decl": `
out vec3 hemisphereClip_surfacePosition;
`,
        "vs:DECKGL_FILTER_GL_POSITION": `
hemisphereClip_surfacePosition = project_position(vec3(geometry.worldPosition.xy, 0.0));
`,
        "fs:#decl": `
in vec3 hemisphereClip_surfacePosition;
`,
        "fs:DECKGL_FILTER_COLOR": `
if (hemisphereClip.enabled > 0.5) {
  vec3 clipSurfacePoint = hemisphereClip_surfacePosition;
  vec3 clipViewDirection = normalize(hemisphereClip.cameraPosition - clipSurfacePoint);
  float clipFacing = dot(normalize(clipSurfacePoint), clipViewDirection);
  if (clipFacing < hemisphereClip.horizonEpsilon) {
    discard;
  }
}
`,
      },
    };
  }

  draw({}) {
    const viewport = this.context.viewport;
    this.setShaderModuleProps({
      hemisphereClip: {
        enabled: this.props.clipEnabled ? 1 : 0,
        horizonEpsilon: this.props.clipHorizonEpsilon,
        cameraPosition: viewport?.cameraPosition ?? [0, 0, 1],
      },
    });
  }
}

const hemisphereClipExtension = new HemisphereClipExtension();

const controls = {
  panel: document.querySelector(".earthlab-panel"),
  panelCloseBtn: document.getElementById("panelCloseBtn"),
  earthLayersBtn: document.getElementById("earthLayersBtn"),
  layerStack: document.querySelector(".earthlab-layer-stack"),
  earthSwatch: document.getElementById("earthSwatch"),
  earthToggle: document.getElementById("earthToggle"),
  earthChildren: document.getElementById("earthChildren"),
  rows: document.getElementById("earthRows"),
  oceanSwatch: document.getElementById("oceanSwatch"),
  graticulesSwatch: document.getElementById("graticulesSwatch"),
  landSwatch: document.getElementById("landSwatch"),
  landFillSwatch: document.getElementById("landFillSwatch"),
  landLineSwatch: document.getElementById("landLineSwatch"),
  oceanToggle: document.getElementById("oceanToggle"),
  graticulesToggle: document.getElementById("graticulesToggle"),
  landToggle: document.getElementById("landToggle"),
  landFillToggle: document.getElementById("landFillToggle"),
  landLineToggle: document.getElementById("landLineToggle"),
  oceanStyle: document.getElementById("oceanStyle"),
  graticulesStyle: document.getElementById("graticulesStyle"),
  landChildren: document.getElementById("landChildren"),
  landFillStyle: document.getElementById("landFillStyle"),
  landLineStyle: document.getElementById("landLineStyle"),
  oceanColorValue: document.getElementById("oceanColorValue"),
  oceanOpacitySlider: document.getElementById("oceanOpacitySlider"),
  oceanOpacityValue: document.getElementById("oceanOpacityValue"),
  graticulesColorValue: document.getElementById("graticulesColorValue"),
  graticulesOpacitySlider: document.getElementById("graticulesOpacitySlider"),
  graticulesOpacityValue: document.getElementById("graticulesOpacityValue"),
  graticulesWidthSlider: document.getElementById("graticulesWidthSlider"),
  graticulesWidthValue: document.getElementById("graticulesWidthValue"),
  landFillColorValue: document.getElementById("landFillColorValue"),
  landFillOpacitySlider: document.getElementById("landFillOpacitySlider"),
  landFillOpacityValue: document.getElementById("landFillOpacityValue"),
  landLineColorValue: document.getElementById("landLineColorValue"),
  landLineOpacitySlider: document.getElementById("landLineOpacitySlider"),
  landLineOpacityValue: document.getElementById("landLineOpacityValue"),
  landLineWidthSlider: document.getElementById("landLineWidthSlider"),
  landLineWidthValue: document.getElementById("landLineWidthValue"),
};

function readLayerState() {
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    return normalizeLayerState(raw ? JSON.parse(raw) : buildDefaultLayerState());
  } catch {
    return buildDefaultLayerState();
  }
}

function persistLayerState() {
  try {
    window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state.layerState));
  } catch {
    // Ignore storage failures to keep the runtime usable.
  }
}

function hexToRgb(hex, fallback = { r: 255, g: 255, b: 255 }) {
  const normalized = String(hex ?? "").trim().replace(/^#/, "");
  if (!/^[\da-f]{6}$/i.test(normalized)) {
    return fallback;
  }
  const value = Number.parseInt(normalized, 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

function toDeckColor(hex, alpha = 255) {
  const { r, g, b } = hexToRgb(hex);
  return [r, g, b, alpha];
}

function percentToAlpha(percent = 100) {
  const normalized = Math.max(0, Math.min(100, Number(percent) || 0));
  return Math.round((normalized / 100) * 255);
}

function clampOpacity(percent = 100) {
  return Math.max(0, Math.min(100, Number(percent) || 0));
}

function loadJson(url) {
  return fetch(url).then((response) => {
    if (!response.ok) {
      throw new Error(`Failed to load ${url}: ${response.status}`);
    }
    return response.json();
  });
}

function defer(task) {
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(() => task(), { timeout: 1200 });
    return;
  }
  window.setTimeout(task, 0);
}

function getElementTarget(event) {
  return event.target instanceof Element ? event.target : null;
}

function getLayer(layerId) {
  return state.layerState.layers[layerId];
}

function getChannel(layerId, channelId) {
  return getLayer(layerId)?.channels?.[channelId] ?? null;
}

function isLayerVisible(layerId) {
  return getLayerVisibility(state.layerState, layerId);
}

function isLandGroupVisible() {
  return Boolean(getChannel("land", "fill")?.visible || getChannel("land", "line")?.visible);
}

function getLandChildOrder(renderOrder = state.layerState.order) {
  return normalizeRenderOrder(renderOrder).filter((layerId) => layerId.startsWith("land."));
}

function getTopRowOrder(renderOrder = state.layerState.order) {
  const topRowIds = [];
  normalizeRenderOrder(renderOrder).forEach((renderLayerId) => {
    const target = getChannelTarget(renderLayerId);
    if (!target) {
      return;
    }
    const topRowId = target.layerId;
    if (!topRowIds.includes(topRowId)) {
      topRowIds.push(topRowId);
    }
  });
  return topRowIds;
}

function syncRowOrderFromState() {
  getTopRowOrder().forEach((rowId) => {
    const rowElement = controls.earthChildren.querySelector(`:scope > [data-reorder-id="${rowId}"]`);
    if (rowElement) {
      controls.earthChildren.append(rowElement);
    }
  });

  getLandChildOrder().forEach((layerId) => {
    const rowElement = controls.landChildren.querySelector(`:scope > [data-reorder-id="${layerId}"]`);
    if (rowElement) {
      controls.landChildren.append(rowElement);
    }
  });
}

function rebuildRenderOrderFromDom() {
  const nextOrder = [];

  controls.earthChildren.querySelectorAll(':scope > [data-reorder-scope="earth"]').forEach((rowElement) => {
    const rowId = rowElement.dataset.reorderId;
    if (rowId === "land") {
      controls.landChildren.querySelectorAll(':scope > [data-reorder-scope="land"]').forEach((childRow) => {
        nextOrder.push(childRow.dataset.reorderId);
      });
      return;
    }

    if (rowId === "ocean") nextOrder.push("ocean.fill");
    if (rowId === "graticules") nextOrder.push("graticules.line");
  });

  state.layerState.order = normalizeRenderOrder(nextOrder);
}

function svgEl(name) {
  return document.createElementNS("http://www.w3.org/2000/svg", name);
}

function getLegendSpec(rowId) {
  if (rowId === "earth") {
    return null;
  }

  if (rowId === "ocean") {
    const fill = getChannel("ocean", "fill");
    return {
      kind: "polygon",
      fillColor: fill?.color ?? "#ffffff",
      fillOpacity: fill?.visible ? fill.opacity : 0,
      lineColor: "#ffffff",
      lineOpacity: 0,
      lineWidth: 0,
    };
  }

  if (rowId === "land") {
    const fill = getChannel("land", "fill");
    const line = getChannel("land", "line");
    const drawOrder = [...getLandChildOrder()]
      .reverse()
      .map((layerId) => (layerId === "land.fill" ? "fill" : "line"));
    return {
      kind: "polygon",
      fillColor: fill?.color ?? "#ffffff",
      fillOpacity: fill?.visible ? fill.opacity : 0,
      lineColor: line?.color ?? "#ffffff",
      lineOpacity: line?.visible ? line.opacity : 0,
      lineWidth: line?.visible ? line.width : 0,
      drawOrder,
    };
  }

  if (rowId === "landFill") {
    const fill = getChannel("land", "fill");
    return {
      kind: "polygon",
      fillColor: fill?.color ?? "#ffffff",
      fillOpacity: fill?.visible ? fill.opacity : 0,
      lineColor: "#ffffff",
      lineOpacity: 0,
      lineWidth: 0,
    };
  }

  if (rowId === "landLine") {
    const line = getChannel("land", "line");
    return {
      kind: "line",
      color: line?.color ?? "#ffffff",
      opacity: line?.visible ? line.opacity : 0,
      width: line?.visible ? line.width : 0,
    };
  }

  if (rowId === "graticules") {
    const line = getChannel("graticules", "line");
    return {
      kind: "line",
      color: line?.color ?? "#ffffff",
      opacity: line?.visible ? line.opacity : 0,
      width: line?.visible ? line.width : 0,
    };
  }

  return null;
}

function createLegendSvg(spec) {
  const svg = svgEl("svg");
  svg.setAttribute("viewBox", "0 0 42 18");
  svg.setAttribute("width", "42");
  svg.setAttribute("height", "18");
  svg.classList.add("earthlab-row-swatch-svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  if (!spec) {
    return svg;
  }

  if (spec.kind === "line") {
    const line = svgEl("line");
    line.setAttribute("x1", "3");
    line.setAttribute("x2", "39");
    line.setAttribute("y1", "9");
    line.setAttribute("y2", "9");
    line.setAttribute("stroke", normalizeHexColor(spec.color) ?? "#ffffff");
    line.setAttribute("stroke-opacity", String(clampOpacity(spec.opacity) / 100));
    line.setAttribute("stroke-width", String(Math.max(1, Number(spec.width) || 0)));
    line.setAttribute("stroke-linecap", "round");
    svg.append(line);
    return svg;
  }

  if (spec.kind === "point") {
    const circle = svgEl("circle");
    circle.setAttribute("cx", "21");
    circle.setAttribute("cy", "9");
    circle.setAttribute("r", String(Math.max(3, Math.min(6, Number(spec.radius) || 4))));
    circle.setAttribute("fill", normalizeHexColor(spec.fillColor) ?? "#ffffff");
    circle.setAttribute("fill-opacity", String(clampOpacity(spec.fillOpacity) / 100));
    circle.setAttribute("stroke", normalizeHexColor(spec.lineColor) ?? "#ffffff");
    circle.setAttribute("stroke-opacity", String(clampOpacity(spec.lineOpacity) / 100));
    circle.setAttribute("stroke-width", String(Math.max(0, Number(spec.lineWidth) || 0)));
    svg.append(circle);
    return svg;
  }

  const rect = svgEl("rect");
  const drawOrder = Array.isArray(spec.drawOrder) && spec.drawOrder.length
    ? spec.drawOrder
    : ["fill", "line"];

  drawOrder.forEach((part) => {
    const shape = svgEl("rect");
    shape.setAttribute("x", "8");
    shape.setAttribute("y", "2");
    shape.setAttribute("width", "26");
    shape.setAttribute("height", "14");
    shape.setAttribute("rx", "2.5");
    shape.setAttribute("ry", "2.5");

    if (part === "line") {
      shape.setAttribute("fill", "none");
      shape.setAttribute("stroke", normalizeHexColor(spec.lineColor) ?? "#ffffff");
      shape.setAttribute("stroke-opacity", String(clampOpacity(spec.lineOpacity) / 100));
      shape.setAttribute("stroke-width", String(Math.max(0, Number(spec.lineWidth) || 0)));
    } else {
      shape.setAttribute("fill", normalizeHexColor(spec.fillColor) ?? "#ffffff");
      shape.setAttribute("fill-opacity", String(clampOpacity(spec.fillOpacity) / 100));
      shape.setAttribute("stroke", "none");
    }

    svg.append(shape);
  });
  return svg;
}

function renderLegendButton(button, spec) {
  if (!button) {
    return;
  }
  button.replaceChildren(createLegendSvg(spec));
}

function renderPaletteControls() {
  paletteControls.forEach((control) => control.render());
}

function mountPaletteControls() {
  PALETTE_BINDINGS.forEach(({ controlId, layerId, channelId }) => {
    const mount = document.getElementById(controlId);
    if (!mount || paletteControls.has(controlId)) {
      return;
    }
    const control = mountColorControl({
      mount,
      initialValue: getChannel(layerId, channelId)?.color,
      paletteStore,
      onChange(nextColor) {
        const channel = getChannel(layerId, channelId);
        if (!channel) {
          return;
        }
        channel.color = nextColor;
        persistLayerState();
        updateOverlay();
      },
    });
    paletteControls.set(controlId, control);
  });
  renderPaletteControls();
}

function syncControlsFromState() {
  const oceanFill = getChannel("ocean", "fill");
  const graticulesLine = getChannel("graticules", "line");
  const landFill = getChannel("land", "fill");
  const landLine = getChannel("land", "line");

  renderLegendButton(controls.earthSwatch, getLegendSpec("earth"));
  renderLegendButton(controls.oceanSwatch, getLegendSpec("ocean"));
  renderLegendButton(controls.graticulesSwatch, getLegendSpec("graticules"));
  renderLegendButton(controls.landSwatch, getLegendSpec("land"));
  renderLegendButton(controls.landFillSwatch, getLegendSpec("landFill"));
  renderLegendButton(controls.landLineSwatch, getLegendSpec("landLine"));

  controls.earthToggle.setAttribute("aria-checked", String(getLayer("earth")?.visible !== false));
  controls.oceanToggle.setAttribute("aria-checked", String(getLayer("ocean")?.visible !== false));
  controls.graticulesToggle.setAttribute("aria-checked", String(getLayer("graticules")?.visible !== false));
  controls.landToggle.setAttribute("aria-checked", String(isLandGroupVisible()));
  controls.landFillToggle.setAttribute("aria-checked", String(getChannel("land", "fill")?.visible !== false));
  controls.landLineToggle.setAttribute("aria-checked", String(getChannel("land", "line")?.visible !== false));

  controls.oceanStyle.hidden = !state.expandedRows.ocean;
  controls.graticulesStyle.hidden = !state.expandedRows.graticules;
  controls.landChildren.hidden = !state.expandedRows.land && state.drag?.scope !== "land";
  controls.landFillStyle.hidden = state.activeChildPanelByRow.land !== "fill";
  controls.landLineStyle.hidden = state.activeChildPanelByRow.land !== "line";

  controls.oceanOpacitySlider.value = String(oceanFill?.opacity ?? 100);

  controls.graticulesOpacitySlider.value = String(graticulesLine?.opacity ?? 100);
  controls.graticulesWidthSlider.value = String(graticulesLine?.width ?? 1);

  controls.landFillOpacitySlider.value = String(landFill?.opacity ?? 100);

  controls.landLineOpacitySlider.value = String(landLine?.opacity ?? 100);
  controls.landLineWidthSlider.value = String(landLine?.width ?? 1);

  controls.oceanColorValue.textContent = oceanFill?.color ?? "";
  controls.oceanOpacityValue.textContent = `${Math.round(Number(oceanFill?.opacity ?? 100))}%`;
  controls.graticulesColorValue.textContent = graticulesLine?.color ?? "";
  controls.graticulesOpacityValue.textContent = `${Math.round(Number(graticulesLine?.opacity ?? 100))}%`;
  controls.graticulesWidthValue.textContent = `${Number(graticulesLine?.width ?? 1).toFixed(1)} px`;
  controls.landFillColorValue.textContent = landFill?.color ?? "";
  controls.landFillOpacityValue.textContent = `${Math.round(Number(landFill?.opacity ?? 100))}%`;
  controls.landLineColorValue.textContent = landLine?.color ?? "";
  controls.landLineOpacityValue.textContent = `${Math.round(Number(landLine?.opacity ?? 100))}%`;
  controls.landLineWidthValue.textContent = `${Number(landLine?.width ?? 1).toFixed(1)} px`;

  paletteControls.get("oceanColorControl")?.setValue(oceanFill?.color);
  paletteControls.get("graticulesColorControl")?.setValue(graticulesLine?.color);
  paletteControls.get("landFillColorControl")?.setValue(landFill?.color);
  paletteControls.get("landLineColorControl")?.setValue(landLine?.color);
  renderPaletteControls();
}

function updateStatus() {
  return;
}

function buildLayers() {
  const clippedLayerProps = {
    clipEnabled: true,
    clipHorizonEpsilon: HORIZON_CLIP_EPSILON,
    extensions: [hemisphereClipExtension],
  };

  const oceanFill = getChannel("ocean", "fill");
  const graticulesLine = getChannel("graticules", "line");
  const landFill = getChannel("land", "fill");
  const landLine = getChannel("land", "line");

  const layerBuilders = {
    "ocean.fill": () => new SolidPolygonLayer({
      id: "earthlab-ocean",
      data: [{ polygon: OCEAN_RING }],
      getPolygon: (entry) => entry.polygon,
      getFillColor: toDeckColor(oceanFill?.color, percentToAlpha(oceanFill?.opacity)),
      visible: isLayerVisible("ocean") && oceanFill?.visible !== false,
      pickable: false,
      parameters: { depthTest: false },
    }),
    "graticules.line": () => new GeoJsonLayer({
      id: "earthlab-graticules",
      ...clippedLayerProps,
      data: state.graticules ?? { type: "FeatureCollection", features: [] },
      filled: false,
      stroked: true,
      getLineColor: toDeckColor(graticulesLine?.color, percentToAlpha(graticulesLine?.opacity)),
      getLineWidth: Number(graticulesLine?.width) || 0,
      lineWidthUnits: "pixels",
      lineWidthMinPixels: Number(graticulesLine?.width) || 0,
      jointRounded: true,
      capRounded: true,
      visible: isLayerVisible("graticules") && graticulesLine?.visible !== false,
      pickable: false,
      parameters: { depthTest: false },
    }),
    "land.line": () => new GeoJsonLayer({
      id: "earthlab-land-line",
      ...clippedLayerProps,
      data: state.land ?? { type: "FeatureCollection", features: [] },
      filled: false,
      stroked: true,
      getLineColor: toDeckColor(landLine?.color, percentToAlpha(landLine?.opacity)),
      getLineWidth: Number(landLine?.width) || 0,
      lineWidthUnits: "pixels",
      lineWidthMinPixels: Number(landLine?.width) || 0,
      jointRounded: true,
      capRounded: true,
      visible: isLayerVisible("land") && landLine?.visible !== false,
      pickable: false,
      parameters: { depthTest: false },
    }),
    "land.fill": () => new GeoJsonLayer({
      id: "earthlab-land-fill",
      ...clippedLayerProps,
      data: state.land ?? { type: "FeatureCollection", features: [] },
      filled: true,
      stroked: false,
      getFillColor: toDeckColor(landFill?.color, percentToAlpha(landFill?.opacity)),
      visible: isLayerVisible("land") && landFill?.visible !== false,
      pickable: false,
      parameters: { depthTest: false },
    }),
  };

  return [...normalizeRenderOrder(state.layerState.order)]
    .reverse()
    .map((layerId) => layerBuilders[layerId]?.())
    .filter(Boolean);
}

function updateOverlay() {
  if (!state.overlay) {
    return;
  }
  syncControlsFromState();
  state.overlay.setProps({ layers: buildLayers() });
  updateStatus();
}

function syncPanelCollapsed() {
  controls.panel.dataset.collapsed = String(state.panelCollapsed);
  controls.panelCloseBtn.textContent = state.panelCollapsed ? "+" : "×";
  controls.panelCloseBtn.setAttribute("aria-label", state.panelCollapsed ? "Open panel" : "Close panel");
}

function syncEarthLayers() {
  controls.rows.hidden = !state.earthLayersExpanded;
  controls.earthLayersBtn.setAttribute("aria-label", state.earthLayersExpanded ? "Collapse earth layers" : "Expand earth layers");
  controls.earthLayersBtn.dataset.active = String(state.earthLayersExpanded);
  controls.earthChildren.hidden = !state.earthExpanded;
  controls.earthToggle.setAttribute("aria-checked", String(getLayer("earth")?.visible !== false));
}

function toggleStyleRow(rowId) {
  if (rowId === "ocean" || rowId === "graticules") {
    state.expandedRows[rowId] = !state.expandedRows[rowId];
    syncControlsFromState();
    return;
  }

  if (rowId === "land") {
    const nextExpanded = !state.expandedRows.land;
    state.expandedRows.land = nextExpanded;
    if (!nextExpanded) {
      state.activeChildPanelByRow.land = null;
    }
    syncControlsFromState();
    return;
  }

  if (rowId === "landFill" || rowId === "landLine") {
    const panelId = rowId === "landFill" ? "fill" : "line";
    state.expandedRows.land = true;
    state.activeChildPanelByRow.land = state.activeChildPanelByRow.land === panelId ? null : panelId;
  }
  syncControlsFromState();
}

function getReorderContainer(scope) {
  if (scope === "land") return controls.landChildren;
  if (scope === "earth") return controls.earthChildren;
  return controls.rows;
}

function getAdjacentReorderRow(rowElement, direction) {
  let sibling = direction === "up"
    ? rowElement.previousElementSibling
    : rowElement.nextElementSibling;

  while (sibling && sibling.dataset?.reorderScope !== rowElement.dataset.reorderScope) {
    sibling = direction === "up"
      ? sibling.previousElementSibling
      : sibling.nextElementSibling;
  }

  return sibling ?? null;
}

function moveDraggedRow(drag, direction) {
  const container = getReorderContainer(drag.scope);
  const adjacentRow = getAdjacentReorderRow(drag.rowElement, direction);
  if (!adjacentRow) return null;

  const adjacentHeight = adjacentRow.getBoundingClientRect().height;
  const previousSibling = drag.rowElement.previousElementSibling;
  const previousParent = drag.rowElement.parentElement;

  if (direction === "up") {
    container.insertBefore(drag.rowElement, adjacentRow);
  } else {
    container.insertBefore(drag.rowElement, adjacentRow.nextElementSibling);
  }

  const positionChanged =
    drag.rowElement.parentElement !== previousParent ||
    drag.rowElement.previousElementSibling !== previousSibling;

  if (!positionChanged) return null;

  if (direction === "up") drag.startY -= adjacentHeight;
  else drag.startY += adjacentHeight;

  rebuildRenderOrderFromDom();
  const orderKey = state.layerState.order.join("|");
  if (orderKey !== drag.lastOrderKey) {
    drag.lastOrderKey = orderKey;
    persistLayerState();
    updateOverlay();
  }

  return { adjacentHeight };
}

function bindRowReordering() {
  let suppressRowClickUntil = 0;
  let holdTimer = null;

  function cancelHold() {
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  }

  function activateDrag(drag) {
    drag.dragging = true;
    const rowId = drag.rowElement.dataset.rowId;
    if (rowId === "ocean" || rowId === "graticules") {
      state.expandedRows[rowId] = false;
    }
    if (rowId === "land") {
      state.expandedRows.land = false;
      state.activeChildPanelByRow.land = null;
    }
    if (rowId === "landFill" && state.activeChildPanelByRow.land === "fill") {
      state.activeChildPanelByRow.land = null;
    }
    if (rowId === "landLine" && state.activeChildPanelByRow.land === "line") {
      state.activeChildPanelByRow.land = null;
    }
    syncControlsFromState();
    if (drag.scope === "land") controls.landChildren.hidden = false;
    drag.rowElement.classList.add("earthlab-row-dragging");
    const rect = drag.rowElement.getBoundingClientRect();
    drag.anchorTop = rect.top;
    drag.anchorBottom = rect.bottom;
    drag.provisional = null;
    navigator.vibrate?.(10);
  }

  document.addEventListener("click", (event) => {
    if (Date.now() <= suppressRowClickUntil) {
      event.stopPropagation();
      event.preventDefault();
    }
  }, true);

  controls.rows.querySelectorAll(".earthlab-row").forEach((rowElement) => {
    rowElement.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;

      const target = getElementTarget(event);
      if (!target) return;
      if (target.closest(".earthlab-row") !== rowElement) return;
      if (
        target.closest(".earthlab-row-style") ||
        target.closest(".earthlab-row-toggle") ||
        target.closest(".earthlab-color-swatch")
      ) return;

      const pending = {
        pointerId: event.pointerId,
        rowElement,
        scope: rowElement.dataset.reorderScope,
        startX: event.clientX,
        startY: event.clientY,
        dragging: false,
        lastOrderKey: null,
        anchorTop: 0,
        anchorBottom: 0,
        provisional: null,
      };

      if (event.pointerType === "touch") {
        holdTimer = setTimeout(() => {
          holdTimer = null;
          rowElement.setPointerCapture(pending.pointerId);
          state.drag = pending;
          activateDrag(pending);
        }, 250);

        const cancelOnMove = (moveEvent) => {
          if (moveEvent.pointerId !== pending.pointerId) return;
          const dist = Math.hypot(moveEvent.clientX - pending.startX, moveEvent.clientY - pending.startY);
          if (dist > 8) {
            cancelHold();
            document.removeEventListener("pointermove", cancelOnMove);
          }
        };
        const cancelOnUp = (upEvent) => {
          if (upEvent.pointerId !== pending.pointerId) return;
          cancelHold();
          document.removeEventListener("pointermove", cancelOnMove);
          document.removeEventListener("pointerup", cancelOnUp);
        };
        document.addEventListener("pointermove", cancelOnMove);
        document.addEventListener("pointerup", cancelOnUp);
      } else {
        state.drag = pending;
      }
    });
  });

  document.addEventListener("pointermove", (event) => {
    const drag = state.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;

    if (!drag.dragging && event.pointerType !== "touch") {
      const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (distance < 6) return;
      activateDrag(drag);
    }

    if (!drag.dragging) return;

    drag.rowElement.style.transform = "";

    if (drag.provisional) {
      if (drag.provisional.direction === "down") {
        if (event.clientY <= drag.provisional.boundary) {
          const result = moveDraggedRow(drag, "up");
          if (result) {
            drag.provisional = null;
          }
        } else if (event.clientY >= drag.provisional.commitBoundary) {
          drag.anchorTop += drag.provisional.adjacentHeight;
          drag.anchorBottom += drag.provisional.adjacentHeight;
          drag.provisional = null;
        }
      } else if (drag.provisional.direction === "up") {
        if (event.clientY >= drag.provisional.boundary) {
          const result = moveDraggedRow(drag, "down");
          if (result) {
            drag.provisional = null;
          }
        } else if (event.clientY <= drag.provisional.commitBoundary) {
          drag.anchorTop -= drag.provisional.adjacentHeight;
          drag.anchorBottom -= drag.provisional.adjacentHeight;
          drag.provisional = null;
        }
      }
    }

    if (!drag.provisional) {
      let direction = null;
      if (event.clientY < drag.anchorTop) direction = "up";
      else if (event.clientY > drag.anchorBottom) direction = "down";

      if (direction) {
        const result = moveDraggedRow(drag, direction);
        if (result) {
          drag.provisional = {
            direction,
            boundary: direction === "up" ? drag.anchorTop : drag.anchorBottom,
            commitBoundary:
              direction === "up"
                ? drag.anchorTop - result.adjacentHeight
                : drag.anchorBottom + result.adjacentHeight,
            adjacentHeight: result.adjacentHeight,
          };
        }
      }
    }

    drag.rowElement.style.transform = `translateY(${event.clientY - drag.startY}px)`;
  });

  document.addEventListener("pointerup", (event) => {
    cancelHold();
    const drag = state.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;

    if (drag.dragging) {
      drag.rowElement.style.transform = "";
      drag.rowElement.classList.remove("earthlab-row-dragging");
      syncRowOrderFromState();
      suppressRowClickUntil = Date.now() + 180;
    }

    state.drag = null;
  });

  document.addEventListener("pointercancel", (event) => {
    cancelHold();
    const drag = state.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;

    if (drag.dragging) {
      drag.rowElement.style.transform = "";
      drag.rowElement.classList.remove("earthlab-row-dragging");
      syncRowOrderFromState();
    }

    state.drag = null;
  });
}

function setLayerVisible(layerId, visible) {
  const layer = getLayer(layerId);
  if (layer) {
    layer.visible = visible;
  }
}

function setChannelVisible(layerId, channelId, visible) {
  const channel = getChannel(layerId, channelId);
  if (channel) {
    channel.visible = visible;
  }
}

function updateLandVisibilityFromChannels() {
  setLayerVisible("land", isLandGroupVisible());
}

function bindControls() {
  [
    ["earthToggle", () => {
      setLayerVisible("earth", !(getLayer("earth")?.visible !== false));
    }],
    ["oceanToggle", () => {
      const nextVisible = !(getLayer("ocean")?.visible !== false);
      setLayerVisible("ocean", nextVisible);
      setChannelVisible("ocean", "fill", nextVisible);
    }],
    ["graticulesToggle", () => {
      const nextVisible = !(getLayer("graticules")?.visible !== false);
      setLayerVisible("graticules", nextVisible);
      setChannelVisible("graticules", "line", nextVisible);
    }],
    ["landToggle", () => {
      const nextVisible = !isLandGroupVisible();
      setLayerVisible("land", nextVisible);
      setChannelVisible("land", "fill", nextVisible);
      setChannelVisible("land", "line", nextVisible);
    }],
    ["landFillToggle", () => {
      setChannelVisible("land", "fill", !(getChannel("land", "fill")?.visible !== false));
      updateLandVisibilityFromChannels();
    }],
    ["landLineToggle", () => {
      setChannelVisible("land", "line", !(getChannel("land", "line")?.visible !== false));
      updateLandVisibilityFromChannels();
    }],
  ].forEach(([controlKey, onToggle]) => {
    controls[controlKey].addEventListener("click", (event) => {
      event.stopPropagation();
      onToggle();
      persistLayerState();
      updateOverlay();
    });
  });

  [
    ["oceanOpacitySlider", { layerId: "ocean", channelId: "fill", key: "opacity", numeric: true }],
    ["graticulesOpacitySlider", { layerId: "graticules", channelId: "line", key: "opacity", numeric: true }],
    ["graticulesWidthSlider", { layerId: "graticules", channelId: "line", key: "width", numeric: true }],
    ["landFillOpacitySlider", { layerId: "land", channelId: "fill", key: "opacity", numeric: true }],
    ["landLineOpacitySlider", { layerId: "land", channelId: "line", key: "opacity", numeric: true }],
    ["landLineWidthSlider", { layerId: "land", channelId: "line", key: "width", numeric: true }],
  ].forEach(([controlKey, target]) => {
    controls[controlKey].addEventListener("input", (event) => {
      const channel = getChannel(target.layerId, target.channelId);
      if (!channel) {
        return;
      }
      channel[target.key] = target.numeric ? Number(event.currentTarget.value) : event.currentTarget.value;
      persistLayerState();
      updateOverlay();
    });
  });

  controls.rows.querySelectorAll(".earthlab-row").forEach((rowElement) => {
    const rowId = rowElement.dataset.rowId;
    const toggleButton = rowElement.querySelector(":scope > .earthlab-row-toggle");
    const stylePanel = rowElement.querySelector(":scope > .earthlab-row-style");

    rowElement.addEventListener("click", (event) => {
      const target = getElementTarget(event);
      if (!rowId) {
        return;
      }

      if (!target || target.closest(".earthlab-row") !== rowElement) {
        return;
      }

      if (toggleButton?.contains(target) || stylePanel?.contains(target)) {
        return;
      }

      if (rowId === "earth") {
        state.earthExpanded = !state.earthExpanded;
        syncEarthLayers();
        return;
      }

      toggleStyleRow(rowId);
    });
  });

  controls.panelCloseBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    state.panelCollapsed = !state.panelCollapsed;
    syncPanelCollapsed();
  });

  controls.earthLayersBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    state.earthLayersExpanded = !state.earthLayersExpanded;
    syncEarthLayers();
  });

  document.addEventListener("pointerdown", (event) => {
    const target = getElementTarget(event);
    if (!target) return;

    let withinPaletteControl = false;
    paletteControls.forEach((control) => {
      if (control.contains(target)) {
        withinPaletteControl = true;
      } else {
        control.close();
      }
    });

    if (!controls.panel.contains(target)) {
      if (!state.panelCollapsed) {
        state.panelCollapsed = true;
        syncPanelCollapsed();
      }
      state.expandedRows.ocean = false;
      state.expandedRows.graticules = false;
      state.expandedRows.land = false;
      state.activeChildPanelByRow.land = null;
      syncControlsFromState();
      return;
    }

    if (!controls.rows.contains(target) && !withinPaletteControl) {
      state.expandedRows.ocean = false;
      state.expandedRows.graticules = false;
      state.expandedRows.land = false;
      state.activeChildPanelByRow.land = null;
      syncControlsFromState();
    }
  });

  bindRowReordering();
}

async function bootstrap() {
  setBootStage("boot");
  syncRowOrderFromState();
  syncControlsFromState();
  syncPanelCollapsed();
  syncEarthLayers();
  mountPaletteControls();
  bindControls();
  bindReloadControls();

  state.map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      projection: { type: "globe" },
      sources: {},
      layers: [
        {
          id: "background",
          type: "background",
          paint: {
            "background-color": "#061018",
          },
        },
      ],
    },
    center: [0, 18],
    zoom: 1.3,
    bearing: 0,
    pitch: 0,
    attributionControl: false,
  });

  state.map.on("move", () => {
    updateStatus();
  });
  state.map.on("load", () => {
    state.overlay = new MapboxOverlay({
      interleaved: false,
      layers: buildLayers(),
    });
    state.map.addControl(state.overlay);
    setBootStage("shell");
    updateStatus();

    void loadJson(LAND_LOW_URL)
      .then((landLow) => {
        state.landLow = landLow;
        state.land = landLow;
        setBootStage("ready");
        updateOverlay();
        defer(() => {
          void loadJson(GRATICULES_URL)
            .then((graticules) => {
              state.graticules = graticules;
              updateOverlay();
            })
            .catch((error) => {
              console.warn("[earthlab] Failed to load graticules.", error);
            });
        });
      })
      .catch((error) => {
        console.warn("[earthlab] Failed to load low-detail land.", error);
        defer(() => {
          void loadJson(GRATICULES_URL)
            .then((graticules) => {
              state.graticules = graticules;
              updateOverlay();
            })
            .catch((graticulesError) => {
              console.warn("[earthlab] Failed to load graticules.", graticulesError);
            });
        });
      });
  });
}

function bindReloadControls() {
  const reloadBtn = document.getElementById("reloadBtn");
  const reloadMenu = document.getElementById("reloadMenu");
  const hardReloadBtn = document.getElementById("hardReloadBtn");
  const clearReloadBtn = document.getElementById("clearReloadBtn");

  reloadBtn.addEventListener("click", () => {
    window.location.reload();
  });

  reloadBtn.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    reloadMenu.hidden = !reloadMenu.hidden;
  });

  hardReloadBtn.addEventListener("click", () => {
    reloadMenu.hidden = true;
    window.location.reload(true);
  });

  clearReloadBtn.addEventListener("click", async () => {
    reloadMenu.hidden = true;
    localStorage.clear();
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
    window.location.reload(true);
  });

  document.addEventListener("pointerdown", (event) => {
    if (!reloadBtn.contains(event.target) && !reloadMenu.contains(event.target)) {
      reloadMenu.hidden = true;
    }
  });
}

bootstrap().catch((error) => {
  console.error(error);
});
