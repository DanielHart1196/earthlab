import maplibregl from "maplibre-gl";
import { LayerExtension } from "@deck.gl/core";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { GeoJsonLayer, SolidPolygonLayer } from "@deck.gl/layers";
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
const DEFAULT_RENDER_ORDER = [
  "ocean.fill",
  "graticules.line",
  "land.line",
  "land.fill",
];
const TOP_ROW_TO_LAYER_IDS = {
  ocean: ["ocean.fill"],
  graticules: ["graticules.line"],
  land: ["land.line", "land.fill"],
};
const LAYER_ID_TO_TOP_ROW = {
  "ocean.fill": "ocean",
  "graticules.line": "graticules",
  "land.line": "land",
  "land.fill": "land",
};

const DEFAULT_STYLE = {
  oceanColor: "#2c6f92",
  oceanOpacity: 100,
  landFillColor: "#6eaa6e",
  landFillOpacity: 100,
  landLineColor: "#d9e4da",
  landLineOpacity: 100,
  landLineWidth: 1,
  graticulesColor: "#8fa9bc",
  graticulesOpacity: 100,
  graticulesWidth: 1,
  earthVisible: true,
  oceanVisible: true,
  landFillVisible: true,
  landLineVisible: true,
  graticulesVisible: true,
  renderOrder: DEFAULT_RENDER_ORDER,
};

const state = {
  map: null,
  overlay: null,
  landLow: null,
  land: null,
  graticules: null,
  style: readStyleState(),
  openStyleRow: null,
  drag: null,
  panelCollapsed: false,
  earthLayersExpanded: true,
  earthExpanded: true,
};

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
  oceanColorPicker: document.getElementById("oceanColorPicker"),
  oceanOpacitySlider: document.getElementById("oceanOpacitySlider"),
  graticulesColorPicker: document.getElementById("graticulesColorPicker"),
  graticulesOpacitySlider: document.getElementById("graticulesOpacitySlider"),
  graticulesWidthSlider: document.getElementById("graticulesWidthSlider"),
  landFillColorPicker: document.getElementById("landFillColorPicker"),
  landFillOpacitySlider: document.getElementById("landFillOpacitySlider"),
  landLineColorPicker: document.getElementById("landLineColorPicker"),
  landLineOpacitySlider: document.getElementById("landLineOpacitySlider"),
  landLineWidthSlider: document.getElementById("landLineWidthSlider"),
};

function readStyleState() {
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_STYLE };
    }
    const parsed = JSON.parse(raw);
    const sharedLandVisible = parsed?.landVisible;
    return {
      ...DEFAULT_STYLE,
      ...parsed,
      landFillVisible: parsed?.landFillVisible ?? sharedLandVisible ?? DEFAULT_STYLE.landFillVisible,
      landLineVisible: parsed?.landLineVisible ?? sharedLandVisible ?? DEFAULT_STYLE.landLineVisible,
      renderOrder: normalizeRenderOrder(parsed?.renderOrder),
    };
  } catch {
    return { ...DEFAULT_STYLE };
  }
}

function normalizeRenderOrder(order) {
  const source = Array.isArray(order) ? order : DEFAULT_RENDER_ORDER;
  const allowed = new Set(DEFAULT_RENDER_ORDER);
  const normalized = source.filter((layerId) => allowed.has(layerId));
  DEFAULT_RENDER_ORDER.forEach((layerId) => {
    if (!normalized.includes(layerId)) {
      normalized.push(layerId);
    }
  });
  return normalized;
}

function persistStyleState() {
  try {
    window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state.style));
  } catch {
    // Keep the runtime usable if storage is unavailable.
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

function isLandGroupVisible() {
  return state.style.landFillVisible || state.style.landLineVisible;
}

function getLandChildOrder(renderOrder = state.style.renderOrder) {
  return normalizeRenderOrder(renderOrder).filter((layerId) => layerId.startsWith("land."));
}

function getTopRowOrder(renderOrder = state.style.renderOrder) {
  const topRowIds = [];
  normalizeRenderOrder(renderOrder).forEach((layerId) => {
    const topRowId = LAYER_ID_TO_TOP_ROW[layerId];
    if (topRowId && !topRowIds.includes(topRowId)) {
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

    TOP_ROW_TO_LAYER_IDS[rowId]?.forEach((layerId) => nextOrder.push(layerId));
  });

  state.style.renderOrder = normalizeRenderOrder(nextOrder);
}

function syncControlsFromState() {
  controls.oceanSwatch.style.background = state.style.oceanColor;
  controls.graticulesSwatch.style.background = state.style.graticulesColor;
  controls.landSwatch.style.background = `linear-gradient(135deg, ${state.style.landFillColor} 0 62%, ${state.style.landLineColor} 62% 100%)`;
  controls.landFillSwatch.style.background = state.style.landFillColor;
  controls.landLineSwatch.style.background = state.style.landLineColor;
  controls.earthToggle.setAttribute("aria-checked", String(state.style.earthVisible));
  controls.oceanToggle.setAttribute("aria-checked", String(state.style.oceanVisible));
  controls.graticulesToggle.setAttribute("aria-checked", String(state.style.graticulesVisible));
  controls.landToggle.setAttribute("aria-checked", String(isLandGroupVisible()));
  controls.landFillToggle.setAttribute("aria-checked", String(state.style.landFillVisible));
  controls.landLineToggle.setAttribute("aria-checked", String(state.style.landLineVisible));
  controls.oceanStyle.hidden = state.openStyleRow !== "ocean";
  controls.graticulesStyle.hidden = state.openStyleRow !== "graticules";
  controls.landChildren.hidden = !["land", "landFill", "landLine"].includes(state.openStyleRow) && state.drag?.scope !== "land";
  controls.landFillStyle.hidden = state.openStyleRow !== "landFill";
  controls.landLineStyle.hidden = state.openStyleRow !== "landLine";
  controls.oceanColorPicker.value = state.style.oceanColor;
  controls.oceanOpacitySlider.value = String(state.style.oceanOpacity);
  controls.graticulesColorPicker.value = state.style.graticulesColor;
  controls.graticulesOpacitySlider.value = String(state.style.graticulesOpacity);
  controls.graticulesWidthSlider.value = String(state.style.graticulesWidth);
  controls.landFillColorPicker.value = state.style.landFillColor;
  controls.landFillOpacitySlider.value = String(state.style.landFillOpacity);
  controls.landLineColorPicker.value = state.style.landLineColor;
  controls.landLineOpacitySlider.value = String(state.style.landLineOpacity);
  controls.landLineWidthSlider.value = String(state.style.landLineWidth);
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

  const layerBuilders = {
    "ocean.fill": () => new SolidPolygonLayer({
      id: "earthlab-ocean",
      data: [{ polygon: OCEAN_RING }],
      getPolygon: (entry) => entry.polygon,
      getFillColor: toDeckColor(state.style.oceanColor, percentToAlpha(state.style.oceanOpacity)),
      visible: state.style.earthVisible && state.style.oceanVisible,
      pickable: false,
      parameters: { depthTest: false },
    }),
    "graticules.line": () => new GeoJsonLayer({
      id: "earthlab-graticules",
      ...clippedLayerProps,
      data: state.graticules ?? { type: "FeatureCollection", features: [] },
      filled: false,
      stroked: true,
      getLineColor: toDeckColor(state.style.graticulesColor, percentToAlpha(state.style.graticulesOpacity)),
      getLineWidth: Number(state.style.graticulesWidth) || 0,
      lineWidthUnits: "pixels",
      lineWidthMinPixels: Number(state.style.graticulesWidth) || 0,
      jointRounded: true,
      capRounded: true,
      visible: state.style.earthVisible && state.style.graticulesVisible,
      pickable: false,
      parameters: { depthTest: false },
    }),
    "land.line": () => new GeoJsonLayer({
      id: "earthlab-land-line",
      ...clippedLayerProps,
      data: state.land ?? { type: "FeatureCollection", features: [] },
      filled: false,
      stroked: true,
      getLineColor: toDeckColor(state.style.landLineColor, percentToAlpha(state.style.landLineOpacity)),
      getLineWidth: Number(state.style.landLineWidth) || 0,
      lineWidthUnits: "pixels",
      lineWidthMinPixels: Number(state.style.landLineWidth) || 0,
      jointRounded: true,
      capRounded: true,
      visible: state.style.earthVisible && state.style.landLineVisible,
      pickable: false,
      parameters: { depthTest: false },
    }),
    "land.fill": () => new GeoJsonLayer({
      id: "earthlab-land-fill",
      ...clippedLayerProps,
      data: state.land ?? { type: "FeatureCollection", features: [] },
      filled: true,
      stroked: false,
      getFillColor: toDeckColor(state.style.landFillColor, percentToAlpha(state.style.landFillOpacity)),
      visible: state.style.earthVisible && state.style.landFillVisible,
      pickable: false,
      parameters: { depthTest: false },
    }),
  };

  return [...normalizeRenderOrder(state.style.renderOrder)]
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
  controls.earthToggle.setAttribute("aria-checked", String(state.style.earthVisible));
}

function toggleStyleRow(rowId) {
  state.openStyleRow = state.openStyleRow === rowId ? null : rowId;
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
  const orderKey = state.style.renderOrder.join("|");
  if (orderKey !== drag.lastOrderKey) {
    drag.lastOrderKey = orderKey;
    persistStyleState();
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
    if (state.openStyleRow === drag.rowElement.dataset.rowId) state.openStyleRow = null;
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
        target.closest(".earthlab-row-swatch")
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

        const cancelOnMove = (e) => {
          if (e.pointerId !== pending.pointerId) return;
          const dist = Math.hypot(e.clientX - pending.startX, e.clientY - pending.startY);
          if (dist > 8) {
            cancelHold();
            document.removeEventListener("pointermove", cancelOnMove);
          }
        };
        const cancelOnUp = (e) => {
          if (e.pointerId !== pending.pointerId) return;
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

    // Reset transform before measuring so getBoundingClientRect gives layout position
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

    // Apply visual follow-finger transform
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

function bindControls() {
  [
    ["oceanSwatch", "ocean"],
    ["graticulesSwatch", "graticules"],
    ["landSwatch", "land"],
    ["landFillSwatch", "landFill"],
    ["landLineSwatch", "landLine"],
    ["earthSwatch", "earth"],
  ].forEach(([controlKey, rowId]) => {
    controls[controlKey].addEventListener("click", (event) => {
      event.stopPropagation();
      toggleStyleRow(rowId);
    });
  });

  [
    ["earthToggle", () => {
      state.style.earthVisible = !state.style.earthVisible;
    }],
    ["oceanToggle", () => {
      state.style.oceanVisible = !state.style.oceanVisible;
    }],
    ["graticulesToggle", () => {
      state.style.graticulesVisible = !state.style.graticulesVisible;
    }],
    ["landToggle", () => {
      const nextVisible = !isLandGroupVisible();
      state.style.landFillVisible = nextVisible;
      state.style.landLineVisible = nextVisible;
    }],
    ["landFillToggle", () => {
      state.style.landFillVisible = !state.style.landFillVisible;
    }],
    ["landLineToggle", () => {
      state.style.landLineVisible = !state.style.landLineVisible;
    }],
  ].forEach(([controlKey, onToggle]) => {
    controls[controlKey].addEventListener("click", (event) => {
      event.stopPropagation();
      onToggle();
      persistStyleState();
      updateOverlay();
    });
  });

  [
    ["oceanColorPicker", "oceanColor"],
    ["oceanOpacitySlider", "oceanOpacity"],
    ["graticulesColorPicker", "graticulesColor"],
    ["graticulesOpacitySlider", "graticulesOpacity"],
    ["graticulesWidthSlider", "graticulesWidth"],
    ["landFillColorPicker", "landFillColor"],
    ["landFillOpacitySlider", "landFillOpacity"],
    ["landLineColorPicker", "landLineColor"],
    ["landLineOpacitySlider", "landLineOpacity"],
    ["landLineWidthSlider", "landLineWidth"],
  ].forEach(([controlKey, styleKey]) => {
    controls[controlKey].addEventListener("input", (event) => {
      const { value, type } = event.currentTarget;
      state.style[styleKey] = type === "range" ? Number(value) : value;
      persistStyleState();
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

    if (!controls.panel.contains(target)) {
      if (!state.panelCollapsed) {
        state.panelCollapsed = true;
        syncPanelCollapsed();
      }
      state.openStyleRow = null;
      syncControlsFromState();
      return;
    }

    if (!controls.rows.contains(target)) {
      state.openStyleRow = null;
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
      await Promise.all(keys.map((k) => caches.delete(k)));
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
