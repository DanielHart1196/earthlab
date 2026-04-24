import maplibregl from "maplibre-gl";
import { LayerExtension } from "@deck.gl/core";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { GeoJsonLayer, SolidPolygonLayer } from "@deck.gl/layers";
import {
  buildDefaultLayerState,
  getChannelTarget,
  getLayerVisibility,
  normalizeDynamicLayers,
  normalizeLayerState,
  normalizeRenderOrder,
} from "./core/layer-config.js";
import { createPaletteStore, normalizeHexColor } from "./core/palette-store.js";
import { getSupabaseCatalog, loadLayerFromSupabase } from "./sources/supabase/layer-loader.js";
import { createMapShare, loadMapShare } from "./sources/supabase/map-share-loader.js";
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
const MAP_NAME_KEY = "earthlab.mapName.v1";
const MAP_VIEW_KEY = "earthlab.mapView.v1";
const SHARE_QUERY_KEY = "share";
const HORIZON_CLIP_EPSILON = 0.002;
const DEFAULT_MAP_VIEW = {
  center: [0, 18],
  zoom: 1.3,
  bearing: 0,
  pitch: 0,
};
const SHARE_SNAPSHOT_VERSION = 1;
const PALETTE_BINDINGS = [
  { controlId: "backgroundColorControl", appearanceKind: "screen" },
  { controlId: "settingsColorControl", appearanceKind: "settings" },
  { controlId: "settingsLineColorControl", appearanceKind: "settings", appearanceKey: "lineColor" },
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
  appearanceExpanded: false,
  appearanceGroupExpanded: false,
  activeAppearancePanels: { background: false, settings: false },
  dynamicExpandedLayerIds: new Set(),
  activeDynamicStylePanels: new Map(),
  drag: null,
  panelCollapsed: true,
  earthLayersExpanded: false,
  earthExpanded: false,
  addLayerPanelOpen: false,
  addLayerSearch: "",
  existingLayers: [],
  existingLayersLoaded: false,
  existingLayersLoading: false,
  existingLayersError: "",
  loadingExistingLayerId: "",
  addLayerActionError: "",
  dynamicLayerData: new Map(),
  dynamicDeckLayerCache: new Map(),
  dynamicLayerErrors: new Map(),
  loadingDynamicLayerIds: new Set(),
};

const paletteStore = createPaletteStore();
const paletteControls = new Map();
const dynamicPaletteControls = new Map();

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
  app: document.getElementById("app"),
  panel: document.querySelector(".earthlab-panel"),
  panelCloseBtn: document.getElementById("panelCloseBtn"),
  earthLayersBtn: document.getElementById("earthLayersBtn"),
  appearanceBtn: document.getElementById("appearanceBtn"),
  layerStack: document.querySelector(".earthlab-layer-stack"),
  appearanceRows: document.getElementById("appearanceRows"),
  appearanceSwatch: document.getElementById("appearanceSwatch"),
  appearanceToggle: document.getElementById("appearanceToggle"),
  appearanceChildren: document.getElementById("appearanceChildren"),
  backgroundSwatch: document.getElementById("backgroundSwatch"),
  settingsSwatch: document.getElementById("settingsSwatch"),
  backgroundToggle: document.getElementById("backgroundToggle"),
  settingsToggle: document.getElementById("settingsToggle"),
  backgroundStyle: document.getElementById("backgroundStyle"),
  settingsStyle: document.getElementById("settingsStyle"),
  backgroundColorValue: document.getElementById("backgroundColorValue"),
  settingsColorValue: document.getElementById("settingsColorValue"),
  settingsLineColorValue: document.getElementById("settingsLineColorValue"),
  backgroundOpacitySlider: document.getElementById("backgroundOpacitySlider"),
  settingsOpacitySlider: document.getElementById("settingsOpacitySlider"),
  settingsLineOpacitySlider: document.getElementById("settingsLineOpacitySlider"),
  backgroundOpacityValue: document.getElementById("backgroundOpacityValue"),
  settingsOpacityValue: document.getElementById("settingsOpacityValue"),
  settingsLineOpacityValue: document.getElementById("settingsLineOpacityValue"),
  earthSwatch: document.getElementById("earthSwatch"),
  earthToggle: document.getElementById("earthToggle"),
  earthChildren: document.getElementById("earthChildren"),
  dynamicRows: document.getElementById("dynamicRows"),
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
  addLayerBtn: document.getElementById("addLayerBtn"),
  addLayerPanel: document.getElementById("addLayerPanel"),
  addLayerExistingList: document.getElementById("addLayerExistingList"),
  addLayerSearchInput: document.getElementById("addLayerSearchInput"),
  addNewLayerBtn: document.getElementById("addNewLayerBtn"),
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

function readMapView() {
  try {
    const raw = window.localStorage?.getItem(MAP_VIEW_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    const [lng, lat] = Array.isArray(parsed?.center) ? parsed.center.map(Number) : [];
    const zoom = Number(parsed?.zoom);
    const bearing = Number(parsed?.bearing);
    const pitch = Number(parsed?.pitch);
    if (
      !Number.isFinite(lng) ||
      !Number.isFinite(lat) ||
      !Number.isFinite(zoom) ||
      !Number.isFinite(bearing) ||
      !Number.isFinite(pitch)
    ) {
      return DEFAULT_MAP_VIEW;
    }
    return {
      center: [Math.max(-180, Math.min(180, lng)), Math.max(-85, Math.min(85, lat))],
      zoom: Math.max(0, Math.min(24, zoom)),
      bearing,
      pitch: Math.max(0, Math.min(85, pitch)),
    };
  } catch {
    return DEFAULT_MAP_VIEW;
  }
}

function persistMapView() {
  if (!state.map) {
    return;
  }
  try {
    const center = state.map.getCenter();
    window.localStorage?.setItem(MAP_VIEW_KEY, JSON.stringify({
      center: [center.lng, center.lat],
      zoom: state.map.getZoom(),
      bearing: state.map.getBearing(),
      pitch: state.map.getPitch(),
    }));
  } catch {
    // Ignore storage failures; camera persistence is non-critical.
  }
}

function getCurrentMapView() {
  if (state.map) {
    const center = state.map.getCenter();
    return {
      center: [center.lng, center.lat],
      zoom: state.map.getZoom(),
      bearing: state.map.getBearing(),
      pitch: state.map.getPitch(),
    };
  }
  return readMapView();
}

function normalizeMapView(view = DEFAULT_MAP_VIEW) {
  const [lng, lat] = Array.isArray(view?.center) ? view.center.map(Number) : [];
  const zoom = Number(view?.zoom);
  const bearing = Number(view?.bearing);
  const pitch = Number(view?.pitch);
  if (
    !Number.isFinite(lng) ||
    !Number.isFinite(lat) ||
    !Number.isFinite(zoom) ||
    !Number.isFinite(bearing) ||
    !Number.isFinite(pitch)
  ) {
    return { ...DEFAULT_MAP_VIEW, center: [...DEFAULT_MAP_VIEW.center] };
  }
  return {
    center: [Math.max(-180, Math.min(180, lng)), Math.max(-85, Math.min(85, lat))],
    zoom: Math.max(0, Math.min(24, zoom)),
    bearing,
    pitch: Math.max(0, Math.min(85, pitch)),
  };
}

function getMapTitle() {
  return document.getElementById("mapNameLabel")?.textContent?.trim() ?? "";
}

function setMapTitle(title) {
  const label = document.getElementById("mapNameLabel");
  if (!label) {
    return;
  }
  label.textContent = String(title ?? "");
  label.dataset.empty = String(label.textContent.trim() === "");
}

function buildShareSnapshot() {
  const mapView = getCurrentMapView();
  return {
    v: SHARE_SNAPSHOT_VERSION,
    meta: {
      title: getMapTitle(),
    },
    mv: {
      c: mapView.center,
      z: mapView.zoom,
      b: mapView.bearing,
      p: mapView.pitch,
    },
    ls: {
      order: [...(state.layerState.order ?? [])],
      appearance: structuredClone(state.layerState.appearance ?? {}),
      layers: structuredClone(state.layerState.layers ?? {}),
      dynamicLayers: structuredClone(getDynamicLayers()),
    },
  };
}

function normalizeShareSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Number(snapshot.v) !== SHARE_SNAPSHOT_VERSION) {
    return null;
  }

  return {
    v: SHARE_SNAPSHOT_VERSION,
    meta: {
      title: String(snapshot.meta?.title ?? ""),
    },
    mv: normalizeMapView({
      center: snapshot.mv?.c,
      zoom: snapshot.mv?.z,
      bearing: snapshot.mv?.b,
      pitch: snapshot.mv?.p,
    }),
    ls: normalizeLayerState(snapshot.ls),
  };
}

function applyShareSnapshot(snapshot) {
  const normalized = snapshot?.v === SHARE_SNAPSHOT_VERSION &&
    snapshot?.mv?.center &&
    snapshot?.ls
    ? snapshot
    : normalizeShareSnapshot(snapshot);
  if (!normalized) {
    return null;
  }

  state.layerState = normalized.ls;
  state.dynamicLayerData.clear();
  state.dynamicDeckLayerCache.clear();
  state.dynamicLayerErrors.clear();
  state.loadingDynamicLayerIds.clear();
  state.dynamicExpandedLayerIds.clear();
  state.activeDynamicStylePanels.clear();
  setMapTitle(normalized.meta?.title ?? "");

  return normalized.mv;
}

function getShareIdFromLocation() {
  return new URLSearchParams(window.location.search).get(SHARE_QUERY_KEY) ?? "";
}

async function readShareSnapshotFromLocation() {
  const shareId = getShareIdFromLocation();
  if (!shareId) {
    return null;
  }
  try {
    const share = await loadMapShare(shareId);
    return normalizeShareSnapshot(share.snapshot);
  } catch (error) {
    console.warn("[earthlab] Failed to load shared map state from Supabase.", error);
    return null;
  }
}

async function createShareUrlFromCurrentState() {
  const { id } = await createMapShare(buildShareSnapshot());
  const url = new URL(window.location.href);
  url.searchParams.set(SHARE_QUERY_KEY, id);
  url.hash = "";
  return url.toString();
}

async function copyShareUrl() {
  const shareUrl = await createShareUrlFromCurrentState();
  window.history.replaceState(null, "", shareUrl);
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(shareUrl);
    return shareUrl;
  }
  window.prompt("Copy share URL", shareUrl);
  return shareUrl;
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

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[char]);
}

function getLayer(layerId) {
  return state.layerState.layers[layerId];
}

function getAppearance(kind) {
  return state.layerState.appearance?.[kind] ?? null;
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

  getDynamicLayers().forEach((layer) => {
    const rowElement = controls.dynamicRows.querySelector(`:scope > [data-reorder-id="${layer.id}"]`);
    if (rowElement) {
      controls.dynamicRows.append(rowElement);
    }
  });
}

function applyRowDepthParity(root = controls.layerStack) {
  if (!root) {
    return;
  }

  function walk(container, depth) {
    Array.from(container.children).forEach((child) => {
      if (!(child instanceof HTMLElement)) {
        return;
      }

      if (child.classList.contains("earthlab-row")) {
        child.dataset.depth = String(depth);
        child.dataset.depthParity = depth % 2 === 0 ? "even" : "odd";
        Array.from(child.children).forEach((grandChild) => {
          if (
            grandChild instanceof HTMLElement &&
            grandChild.classList.contains("earthlab-row-children")
          ) {
            walk(grandChild, depth + 1);
          }
        });
        return;
      }

      walk(child, depth);
    });
  }

  walk(root, 0);
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

function rebuildDynamicLayerOrderFromDom() {
  const byId = new Map(getDynamicLayers().map((layer) => [layer.id, layer]));
  const nextLayers = [];

  controls.dynamicRows.querySelectorAll(':scope > [data-reorder-scope="dynamic"]').forEach((rowElement) => {
    const layer = byId.get(rowElement.dataset.reorderId);
    if (layer) {
      nextLayers.push(layer);
      byId.delete(layer.id);
    }
  });

  state.layerState.dynamicLayers = normalizeDynamicLayers([...nextLayers, ...byId.values()]);
}

function svgEl(name) {
  return document.createElementNS("http://www.w3.org/2000/svg", name);
}

function getLegendSpec(rowId) {
  if (rowId === "appearance") {
    return { kind: "gear" };
  }

  if (rowId === "background") {
    const appearance = getAppearance("screen");
    return {
      kind: "polygon",
      fillColor: appearance?.color ?? "#000000",
      fillOpacity: appearance?.opacity ?? 100,
      lineColor: "#ffffff",
      lineOpacity: 0,
      lineWidth: 0,
    };
  }

  if (rowId === "settings") {
    const appearance = getAppearance("settings");
    return {
      kind: "polygon",
      fillColor: appearance?.color ?? "#000000",
      fillOpacity: appearance?.opacity ?? 30,
      lineColor: appearance?.lineColor ?? "#000000",
      lineOpacity: appearance?.lineOpacity ?? 100,
      lineWidth: 1,
    };
  }

  if (rowId === "earth") {
    return { kind: "globe" };
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

function getDynamicLayerLegendSpec(layer) {
  const geometryTypes = Array.isArray(layer?.geometryTypes) && layer.geometryTypes.length
    ? layer.geometryTypes
    : [layer?.geometryType].filter(Boolean);
  const uniqueTypes = [...new Set(geometryTypes.map((value) => (value === "area" ? "polygon" : value)))];
  if (uniqueTypes.length !== 1) {
    return null;
  }

  const style = getDefaultDynamicLayerStyle(layer?.style);

  if (uniqueTypes[0] === "point") {
    const point = getDynamicChannel(layer, "point") ?? style;
    const line = getDynamicChannel(layer, "pointLine") ?? {};
    const opacity = layer?.visible === false || point.visible === false ? 0 : point.opacity;
    const lineOpacity = layer?.visible === false || line.visible === false ? 0 : line.opacity ?? 100;
    return {
      kind: "point",
      fillColor: point.color ?? style.color,
      fillOpacity: opacity,
      lineColor: line.color ?? "#000000",
      lineOpacity,
      lineWidth: line.width ?? 1,
      radius: point.radius ?? style.pointRadius,
    };
  }

  if (uniqueTypes[0] === "line") {
    const line = getDynamicChannel(layer, "line") ?? style;
    const opacity = layer?.visible === false || line.visible === false ? 0 : line.opacity;
    return {
      kind: "line",
      color: line.color ?? style.color,
      opacity,
      width: line.width ?? style.lineWidth,
    };
  }

  if (uniqueTypes[0] === "polygon") {
    const fill = getDynamicChannel(layer, "fill") ?? style;
    const line = getDynamicChannel(layer, "line") ?? style;
    const fillOpacity = layer?.visible === false || fill.visible === false ? 0 : fill.opacity;
    const lineOpacity = layer?.visible === false || line.visible === false ? 0 : line.opacity;
    return {
      kind: "polygon",
      fillColor: fill.color ?? style.color,
      fillOpacity,
      lineColor: line.color ?? style.color,
      lineOpacity,
      lineWidth: line.width ?? style.lineWidth,
    };
  }

  return null;
}

function getDynamicChannelLegendSpec(layer, channelId) {
  const style = getDefaultDynamicLayerStyle(layer?.style);
  const channel = getDynamicChannel(layer, channelId) ?? {};
  const visible = layer?.visible !== false && channel.visible !== false;
  const opacity = visible ? channel.opacity ?? style.opacity : 0;
  const color = channel.color ?? style.color;

  if (channelId === "point") {
    return {
      kind: "point",
      fillColor: color,
      fillOpacity: opacity,
      lineColor: "#000000",
      lineOpacity: opacity,
      lineWidth: 1,
      radius: channel.radius ?? style.pointRadius,
    };
  }

  if (channelId === "line" || channelId === "pointLine") {
    return {
      kind: "line",
      color,
      opacity,
      width: channel.width ?? style.lineWidth,
    };
  }

  return {
    kind: "polygon",
    fillColor: color,
    fillOpacity: opacity,
    lineColor: "#ffffff",
    lineOpacity: 0,
    lineWidth: 0,
  };
}

function getDynamicLayers() {
  return state.layerState.dynamicLayers ?? [];
}

function getDynamicLayerData(layerId) {
  return state.dynamicLayerData.get(layerId) ?? null;
}

function setDynamicLayerData(layerId, geojson) {
  state.dynamicLayerData.set(layerId, {
    geojson,
    loadedAt: Date.now(),
    geometry: {
      polygon: filterGeojsonByGeometryFamily(geojson, "polygon"),
      line: filterGeojsonByGeometryFamily(geojson, "line"),
      point: filterGeojsonByGeometryFamily(geojson, "point"),
    },
  });
  invalidateDynamicDeckLayerCache(layerId);
}

function getDynamicChannel(layer, channelId) {
  return layer?.channels?.[channelId] ?? null;
}

function invalidateDynamicDeckLayerCache(layerId = null) {
  if (layerId) {
    state.dynamicDeckLayerCache.delete(layerId);
    return;
  }
  state.dynamicDeckLayerCache.clear();
}

function persistDynamicLayers() {
  state.layerState.dynamicLayers = normalizeDynamicLayers(state.layerState.dynamicLayers);
  invalidateDynamicDeckLayerCache();
  persistLayerState();
}

function getDynamicGeometryChannels(layer) {
  const geometryTypes = Array.isArray(layer?.geometryTypes) ? layer.geometryTypes : [];
  const channels = [];
  if (geometryTypes.includes("polygon")) {
    channels.push({ id: "fill", label: "Fill", sample: "polygon" });
    channels.push({ id: "line", label: "Line", sample: "line" });
  } else if (geometryTypes.includes("line")) {
    channels.push({ id: "line", label: "Line", sample: "line" });
  }
  if (geometryTypes.includes("point")) {
    channels.push({ id: "point", label: "Point", sample: "point" });
    channels.push({ id: "pointLine", label: "Line", sample: "line" });
  }
  return channels;
}

function createLegendSvg(spec) {
  const svg = svgEl("svg");
  const isPoint = spec?.kind === "point";
  svg.setAttribute("viewBox", isPoint ? "0 0 42 42" : "0 0 42 18");
  svg.setAttribute("width", "42");
  svg.setAttribute("height", isPoint ? "42" : "18");
  svg.classList.add("earthlab-row-swatch-svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  if (!spec) {
    return svg;
  }

  if (spec.kind === "line") {
    const line = svgEl("line");
    line.setAttribute("x1", "8");
    line.setAttribute("x2", "34");
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
    const radius = Math.max(0, Number(spec.radius) || 0);
    const circle = svgEl("circle");
    circle.setAttribute("cx", "21");
    circle.setAttribute("cy", "21");
    circle.setAttribute("r", String(radius));
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

function createToolbarGlobeSvg() {
  const ocean = getChannel("ocean", "fill");
  const landFill = getChannel("land", "fill");
  const landLine = getChannel("land", "line");
  const graticules = getChannel("graticules", "line");
  const oceanColor = normalizeHexColor(ocean?.color) ?? "#ffffff";
  const landColor = normalizeHexColor(landFill?.color) ?? "#ffffff";
  const landLineColor = normalizeHexColor(landLine?.color) ?? "#000000";
  const graticulesColor = normalizeHexColor(graticules?.color) ?? "#000000";
  const oceanOpacity = clampOpacity(ocean?.visible !== false ? ocean?.opacity : 0) / 100;
  const landOpacity = clampOpacity(landFill?.visible !== false ? landFill?.opacity : 0) / 100;
  const landLineOpacity = clampOpacity(landLine?.visible !== false ? landLine?.opacity : 0) / 100;
  const graticulesOpacity = clampOpacity(graticules?.visible !== false ? graticules?.opacity : 0) / 100;
  const landLineWidth = Math.max(0.7, Math.min(1.8, Number(landLine?.width) || 1));
  const graticulesWidth = Math.max(0.7, Math.min(1.6, Number(graticules?.width) || 1));
  const landPaths = getToolbarAustraliaPaths();
  const graticulePaths = [
    "M13 2.4C11 5.2 10.1 9 10.1 13C10.1 17 11 20.8 13 23.6",
    "M2.4 13C5.2 11.5 8.8 10.8 13 10.8C17.2 10.8 20.8 11.5 23.6 13",
  ];

  const svg = svgEl("svg");
  svg.setAttribute("viewBox", "0 0 26 26");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const clipId = `earthlab-toolbar-globe-clip-${Math.random().toString(36).slice(2, 8)}`;

  const defs = svgEl("defs");
  const clipPath = svgEl("clipPath");
  clipPath.setAttribute("id", clipId);
  const clipCircle = svgEl("circle");
  clipCircle.setAttribute("cx", "13");
  clipCircle.setAttribute("cy", "13");
  clipCircle.setAttribute("r", "11");
  clipPath.append(clipCircle);
  defs.append(clipPath);
  svg.append(defs);

  const contentGroup = svgEl("g");
  contentGroup.setAttribute("clip-path", `url(#${clipId})`);
  svg.append(contentGroup);

  const renderLayerIds = [...normalizeRenderOrder(state.layerState.order)].reverse();
  renderLayerIds.forEach((layerId) => {
    if (layerId === "ocean.fill") {
      const globe = svgEl("circle");
      globe.setAttribute("cx", "13");
      globe.setAttribute("cy", "13");
      globe.setAttribute("r", "11");
      globe.setAttribute("fill", oceanColor);
      globe.setAttribute("fill-opacity", String(oceanOpacity));
      contentGroup.append(globe);
      return;
    }

    if (layerId === "graticules.line") {
      graticulePaths.forEach((pathData) => {
        const path = svgEl("path");
        path.setAttribute("d", pathData);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", graticulesColor);
        path.setAttribute("stroke-opacity", String(graticulesOpacity));
        path.setAttribute("stroke-width", String(graticulesWidth));
        path.setAttribute("stroke-linecap", "round");
        contentGroup.append(path);
      });
      return;
    }

    if (layerId === "land.fill") {
      landPaths.forEach((pathData) => {
        const path = svgEl("path");
        path.setAttribute("d", pathData);
        path.setAttribute("fill", landColor);
        path.setAttribute("fill-opacity", String(landOpacity));
        contentGroup.append(path);
      });
      return;
    }

    if (layerId === "land.line") {
      landPaths.forEach((pathData) => {
        const path = svgEl("path");
        path.setAttribute("d", pathData);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", landLineColor);
        path.setAttribute("stroke-opacity", String(landLineOpacity));
        path.setAttribute("stroke-width", String(landLineWidth));
        path.setAttribute("stroke-linejoin", "round");
        path.setAttribute("stroke-linecap", "round");
        contentGroup.append(path);
      });
    }
  });

  const outline = svgEl("circle");
  outline.setAttribute("cx", "13");
  outline.setAttribute("cy", "13");
  outline.setAttribute("r", "11");
  outline.setAttribute("fill", "none");
  outline.setAttribute("stroke", "#000000");
  outline.setAttribute("stroke-width", "1");
  svg.append(outline);

  return svg;
}

function createToolbarGearSvg() {
  const svg = svgEl("svg");
  svg.setAttribute("viewBox", "0 0 26 26");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  const gear = svgEl("path");
  gear.setAttribute("d", "M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 0 1-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.169.311c.446.82.023 1.841-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 0 1 .872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 0 1 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 0 1 2.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.169-.311a1.464 1.464 0 0 1 .872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 0 1-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464 1.464 0 0 1-2.105-.872zM8 10.93a2.929 2.929 0 1 1 0-5.86 2.929 2.929 0 0 1 0 5.858z");
  gear.setAttribute("fill", "#b8b8b8");
  gear.setAttribute("fill-rule", "evenodd");
  gear.setAttribute("stroke", "#000000");
  gear.setAttribute("stroke-width", "0.55");
  gear.setAttribute("stroke-linejoin", "round");
  gear.setAttribute("transform", "translate(5 5)");
  svg.append(gear);

  return svg;
}

function renderToolbarIcons() {
  controls.earthLayersBtn.replaceChildren(createToolbarGlobeSvg());
  controls.appearanceBtn.replaceChildren(createToolbarGearSvg());
}

function renderLegendButton(button, spec) {
  if (!button) {
    return;
  }
  if (spec?.kind === "globe") {
    const svg = createToolbarGlobeSvg();
    svg.classList.add("earthlab-row-globe-svg");
    button.replaceChildren(svg);
    return;
  }
  if (spec?.kind === "gear") {
    const svg = createToolbarGearSvg();
    svg.classList.add("earthlab-row-gear-svg");
    button.replaceChildren(svg);
    return;
  }
  button.replaceChildren(createLegendSvg(spec));
}

function renderPaletteControls() {
  paletteControls.forEach((control) => control.render());
}

function renderDynamicLayerRows() {
  if (!controls.dynamicRows) {
    return;
  }

  const dynamicLayers = getDynamicLayers();
  controls.dynamicRows.hidden = dynamicLayers.length === 0;
  controls.dynamicRows.innerHTML = dynamicLayers.map((layer) => {
    const expanded = state.dynamicExpandedLayerIds.has(layer.id);
    const channels = getDynamicGeometryChannels(layer);
    return `
    <article class="earthlab-row earthlab-row-parent" data-row-id="dynamic:${escapeHtml(layer.id)}" data-reorder-scope="dynamic" data-reorder-id="${escapeHtml(layer.id)}" data-dynamic-layer-id="${escapeHtml(layer.id)}">
      <span class="earthlab-row-swatch" data-dynamic-layer-swatch="${escapeHtml(layer.id)}" aria-hidden="true"></span>
      <button class="earthlab-row-toggle" type="button" role="checkbox" aria-checked="${layer.visible !== false}" data-dynamic-layer-toggle="${escapeHtml(layer.id)}">
        ${escapeHtml(layer.label ?? "Untitled layer")}
      </button>
      <span class="earthlab-row-slot" aria-hidden="true"></span>
      <div class="earthlab-row-children" data-dynamic-layer-children="${escapeHtml(layer.id)}" ${expanded ? "" : "hidden"}>
        ${channels.map((channel) => renderDynamicChannelRow(layer, channel)).join("")}
      </div>
    </article>
    `;
  }).join("");

  dynamicLayers.forEach((layer) => {
    const swatch = Array.from(controls.dynamicRows.querySelectorAll("[data-dynamic-layer-swatch]"))
      .find((element) => element.dataset.dynamicLayerSwatch === layer.id);
    renderLegendButton(swatch, getDynamicLayerLegendSpec(layer));

    getDynamicGeometryChannels(layer).forEach((channel) => {
      const channelSwatch = Array.from(controls.dynamicRows.querySelectorAll("[data-dynamic-channel-swatch]"))
        .find((element) => element.dataset.dynamicLayerId === layer.id && element.dataset.dynamicChannelSwatch === channel.id);
      renderLegendButton(channelSwatch, getDynamicChannelLegendSpec(layer, channel.id));
    });
  });

  mountDynamicColorControls();
}

function renderDynamicChannelRow(layer, channelDef) {
  const activePanel = state.activeDynamicStylePanels.get(layer.id);
  const channel = getDynamicChannel(layer, channelDef.id) ?? {};
  return `
    <article class="earthlab-row earthlab-row-child" data-dynamic-layer-id="${escapeHtml(layer.id)}" data-dynamic-channel-row="${escapeHtml(channelDef.id)}">
      <span class="earthlab-row-swatch" data-dynamic-layer-id="${escapeHtml(layer.id)}" data-dynamic-channel-swatch="${escapeHtml(channelDef.id)}" aria-hidden="true"></span>
      <button class="earthlab-row-toggle" type="button" role="checkbox" aria-checked="${channel.visible !== false}" data-dynamic-channel-toggle="${escapeHtml(channelDef.id)}">
        ${escapeHtml(channelDef.label)}
      </button>
      <span class="earthlab-row-slot" aria-hidden="true"></span>
      <div class="earthlab-row-style" data-dynamic-style-panel="${escapeHtml(channelDef.id)}" ${activePanel === channelDef.id ? "" : "hidden"}>
        ${renderDynamicChannelControls(layer, channelDef.id)}
      </div>
    </article>
  `;
}

function renderDynamicChannelControls(layer, channelId) {
  const channel = getDynamicChannel(layer, channelId) ?? {};
  const color = channel.color ?? getDefaultDynamicLayerStyle(layer.style).color;
  const opacity = Math.round(Number(channel.opacity ?? 80));
  const width = Number(channel.width ?? 2).toFixed(1);
  const radius = Number(channel.radius ?? 6).toFixed(1);
  const colorControl = `
    <div class="earthlab-style-control">
      <div class="earthlab-style-control-header">
        <div class="earthlab-row-style-label">Color</div>
        <div class="earthlab-row-style-value" data-dynamic-value="${escapeHtml(channelId)}:color" data-dynamic-layer-id="${escapeHtml(layer.id)}">${escapeHtml(color)}</div>
      </div>
      <div data-dynamic-color-control="${escapeHtml(channelId)}" data-dynamic-layer-id="${escapeHtml(layer.id)}"></div>
    </div>
  `;
  const opacityControl = `
    <div class="earthlab-style-control">
      <div class="earthlab-style-control-header">
        <div class="earthlab-row-style-label">Opacity</div>
        <div class="earthlab-row-style-value" data-dynamic-value="${escapeHtml(channelId)}:opacity" data-dynamic-layer-id="${escapeHtml(layer.id)}">${opacity}%</div>
      </div>
      <input class="earthlab-range" type="range" min="0" max="100" step="1" value="${opacity}" data-dynamic-slider="opacity" data-dynamic-layer-id="${escapeHtml(layer.id)}" data-dynamic-channel-id="${escapeHtml(channelId)}" />
    </div>
  `;

  if (channelId === "line" || channelId === "pointLine") {
    return `
      <div class="earthlab-style-control">
        <div class="earthlab-style-control-header">
          <div class="earthlab-row-style-label">Width</div>
          <div class="earthlab-row-style-value" data-dynamic-value="${escapeHtml(channelId)}:width" data-dynamic-layer-id="${escapeHtml(layer.id)}">${width} px</div>
        </div>
        <input class="earthlab-range" type="range" min="0" max="10" step="0.1" value="${width}" data-dynamic-slider="width" data-dynamic-layer-id="${escapeHtml(layer.id)}" data-dynamic-channel-id="${escapeHtml(channelId)}" />
      </div>
      ${colorControl}
      ${opacityControl}
    `;
  }

  if (channelId === "point") {
    return `
      <div class="earthlab-style-control">
        <div class="earthlab-style-control-header">
          <div class="earthlab-row-style-label">Radius</div>
          <div class="earthlab-row-style-value" data-dynamic-value="${escapeHtml(channelId)}:radius" data-dynamic-layer-id="${escapeHtml(layer.id)}">${radius} px</div>
        </div>
        <input class="earthlab-range" type="range" min="1" max="20" step="0.5" value="${radius}" data-dynamic-slider="radius" data-dynamic-layer-id="${escapeHtml(layer.id)}" data-dynamic-channel-id="${escapeHtml(channelId)}" />
      </div>
      ${colorControl}
      ${opacityControl}
    `;
  }

  return `${colorControl}${opacityControl}`;
}

function mountDynamicColorControls() {
  dynamicPaletteControls.clear();
  controls.dynamicRows.querySelectorAll("[data-dynamic-color-control]").forEach((mount) => {
    const layerId = mount.dataset.dynamicLayerId;
    const channelId = mount.dataset.dynamicColorControl;
    const layer = getDynamicLayers().find((entry) => entry.id === layerId);
    const channel = getDynamicChannel(layer, channelId);
    if (!layer || !channel) {
      return;
    }

    const key = `${layerId}:${channelId}`;
    const control = mountColorControl({
      mount,
      initialValue: channel.color,
      paletteStore,
      onChange(nextColor) {
        const currentLayer = getDynamicLayers().find((entry) => entry.id === layerId);
        const currentChannel = getDynamicChannel(currentLayer, channelId);
        if (!currentChannel) {
          return;
        }
        currentChannel.color = nextColor;
        persistDynamicLayers();
        updateDynamicLayerPresentation(layerId, channelId);
        updateOverlayLayersOnly();
      },
    });
    dynamicPaletteControls.set(key, control);
  });
}

function updateDynamicLayerPresentation(layerId, channelId) {
  const layer = getDynamicLayers().find((entry) => entry.id === layerId);
  if (!layer || !controls.dynamicRows) {
    return;
  }

  const parentSwatch = Array.from(controls.dynamicRows.querySelectorAll("[data-dynamic-layer-swatch]"))
    .find((element) => element.dataset.dynamicLayerSwatch === layerId);
  renderLegendButton(parentSwatch, getDynamicLayerLegendSpec(layer));

  if (channelId) {
    const channelSwatch = Array.from(controls.dynamicRows.querySelectorAll("[data-dynamic-channel-swatch]"))
      .find((element) => element.dataset.dynamicLayerId === layerId && element.dataset.dynamicChannelSwatch === channelId);
    renderLegendButton(channelSwatch, getDynamicChannelLegendSpec(layer, channelId));
  }

  const channel = getDynamicChannel(layer, channelId);
  if (!channel) {
    return;
  }

  const valueLabels = Array.from(controls.dynamicRows.querySelectorAll("[data-dynamic-value]"))
    .filter((label) => (
      label.dataset.dynamicLayerId === layerId &&
      label.dataset.dynamicValue.startsWith(`${channelId}:`)
    ));
  valueLabels.forEach((label) => {
    const [, key] = label.dataset.dynamicValue.split(":");
    if (key === "color") {
      label.textContent = channel.color ?? "";
    } else if (key === "opacity") {
      label.textContent = `${Math.round(Number(channel.opacity ?? 0))}%`;
    } else if (key === "width") {
      label.textContent = `${Number(channel.width ?? 0).toFixed(1)} px`;
    } else if (key === "radius") {
      label.textContent = `${Number(channel.radius ?? 0).toFixed(1)} px`;
    }
  });
}

function getToolbarAustraliaPaths() {
  const fallbackPaths = [
    "M4.2 13.1C4.7 11.2 6.4 9.9 8.4 9.3C9.8 8.9 11 9.5 12.1 9.1C13.1 8.7 13.3 7.5 14 7.5C14.8 8.2 14.5 9.4 15.1 9.9C16.2 9.4 17.4 8.4 19.1 8.8C20.8 9.2 22 10.8 21.9 12.7C21.8 14.6 20.4 16.2 18.7 17.1C17.6 17.7 16.5 17.5 15.5 18.1C14.4 18.7 13.8 19.7 12.4 19.8C11.1 19.8 10.6 18.6 9.3 18.3C8.1 18.1 6.6 18.5 5.6 17.4C4.5 16.3 3.8 14.6 4.2 13.1Z",
    "M18.1 19.4C18.7 19 19.5 19 20.1 19.5C20.3 20.1 19.9 20.8 19.2 21C18.5 21 18 20.4 18.1 19.4Z",
  ];
  const features = state.land?.features;
  if (!Array.isArray(features)) {
    return fallbackPaths;
  }

  const australiaFeatures = features.filter((feature) => {
    const rings = feature.geometry?.type === "Polygon" ? feature.geometry.coordinates : [];
    const points = rings.flat();
    if (!points.length) {
      return false;
    }
    const xs = points.map(([lon]) => lon);
    const ys = points.map(([, lat]) => lat);
    const minLon = Math.min(...xs);
    const maxLon = Math.max(...xs);
    const minLat = Math.min(...ys);
    const maxLat = Math.max(...ys);
    return minLon >= 112 && maxLon <= 154 && minLat >= -45 && maxLat <= -10;
  });

  const project = ([lon, lat]) => {
    const x = 5 + ((lon - 112) / 42) * 16;
    const y = 6 + ((-10 - lat) / 35) * 14;
    return [Number(x.toFixed(2)), Number(y.toFixed(2))];
  };

  const paths = australiaFeatures
    .flatMap((feature) => feature.geometry.coordinates)
    .filter((ring) => Array.isArray(ring) && ring.length > 3)
    .map((ring) => {
      const projected = ring.map(project);
      return projected
        .map(([x, y], index) => `${index === 0 ? "M" : "L"}${x} ${y}`)
        .join(" ")
        .concat(" Z");
    });

  return paths.length ? paths : fallbackPaths;
}

function applyAppearanceStyles() {
  const screen = getAppearance("screen");
  const settings = getAppearance("settings");
  const screenRgb = hexToRgb(screen?.color ?? "#000000");
  const settingsRgb = hexToRgb(settings?.color ?? "#000000");
  const settingsLineRgb = hexToRgb(settings?.lineColor ?? "#000000");
  const screenOpacity = (Number(screen?.opacity) || 0) / 100;
  const screenComposited = {
    r: Math.round(screenRgb.r * screenOpacity),
    g: Math.round(screenRgb.g * screenOpacity),
    b: Math.round(screenRgb.b * screenOpacity),
  };
  const screenFill = `rgb(${screenComposited.r}, ${screenComposited.g}, ${screenComposited.b})`;
  const settingsFill = `rgba(${settingsRgb.r}, ${settingsRgb.g}, ${settingsRgb.b}, ${(Number(settings?.opacity) || 0) / 100})`;
  const settingsLineFill = `rgba(${settingsLineRgb.r}, ${settingsLineRgb.g}, ${settingsLineRgb.b}, ${(Number(settings?.lineOpacity) || 0) / 100})`;
  document.body.style.backgroundColor = screenFill;
  controls.app.style.backgroundColor = screenFill;
  if (state.map?.getLayer("background")) {
    state.map.setPaintProperty("background", "background-color", screenFill);
    state.map.setPaintProperty("background", "background-opacity", 1);
  }
  document.documentElement.style.setProperty("--settings-surface-fill", settingsFill);
  document.documentElement.style.setProperty("--settings-border-fill", settingsLineFill);
  document.documentElement.style.setProperty("--row-bg-even", settingsFill);
  document.documentElement.style.setProperty("--row-bg-odd", settingsFill);
}

function getScreenBackgroundFill() {
  const screen = getAppearance("screen");
  const screenRgb = hexToRgb(screen?.color ?? "#000000");
  const screenOpacity = (Number(screen?.opacity) || 0) / 100;
  return `rgb(${Math.round(screenRgb.r * screenOpacity)}, ${Math.round(screenRgb.g * screenOpacity)}, ${Math.round(screenRgb.b * screenOpacity)})`;
}

function mountPaletteControls() {
  PALETTE_BINDINGS.forEach(({ controlId, layerId, channelId, appearanceKind, appearanceKey = "color" }) => {
    const mount = document.getElementById(controlId);
    if (!mount || paletteControls.has(controlId)) {
      return;
    }
    const control = mountColorControl({
      mount,
      initialValue: appearanceKind ? getAppearance(appearanceKind)?.[appearanceKey] : getChannel(layerId, channelId)?.color,
      paletteStore,
      onChange(nextColor) {
        if (appearanceKind) {
          const appearance = getAppearance(appearanceKind);
          if (!appearance) {
            return;
          }
          appearance[appearanceKey] = nextColor;
          persistLayerState();
          updateOverlay();
          return;
        }
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
  const screenAppearance = getAppearance("screen");
  const settingsAppearance = getAppearance("settings");
  const oceanFill = getChannel("ocean", "fill");
  const graticulesLine = getChannel("graticules", "line");
  const landFill = getChannel("land", "fill");
  const landLine = getChannel("land", "line");

  renderLegendButton(controls.appearanceSwatch, getLegendSpec("appearance"));
  renderLegendButton(controls.backgroundSwatch, getLegendSpec("background"));
  renderLegendButton(controls.settingsSwatch, getLegendSpec("settings"));
  renderLegendButton(controls.earthSwatch, getLegendSpec("earth"));
  renderLegendButton(controls.oceanSwatch, getLegendSpec("ocean"));
  renderLegendButton(controls.graticulesSwatch, getLegendSpec("graticules"));
  renderLegendButton(controls.landSwatch, getLegendSpec("land"));
  renderLegendButton(controls.landFillSwatch, getLegendSpec("landFill"));
  renderLegendButton(controls.landLineSwatch, getLegendSpec("landLine"));
  renderDynamicLayerRows();

  controls.earthToggle.setAttribute("aria-checked", String(getLayer("earth")?.visible !== false));
  controls.oceanToggle.setAttribute("aria-checked", String(getLayer("ocean")?.visible !== false));
  controls.graticulesToggle.setAttribute("aria-checked", String(getLayer("graticules")?.visible !== false));
  controls.landToggle.setAttribute("aria-checked", String(isLandGroupVisible()));
  controls.landFillToggle.setAttribute("aria-checked", String(getChannel("land", "fill")?.visible !== false));
  controls.landLineToggle.setAttribute("aria-checked", String(getChannel("land", "line")?.visible !== false));

  controls.appearanceRows.hidden = !state.appearanceExpanded;
  controls.appearanceBtn.dataset.active = String(state.appearanceExpanded);
  controls.panel.dataset.appearanceOpen = String(state.appearanceExpanded);
  controls.appearanceChildren.hidden = !state.appearanceGroupExpanded;
  controls.backgroundStyle.hidden = !state.activeAppearancePanels.background;
  controls.settingsStyle.hidden = !state.activeAppearancePanels.settings;

  controls.backgroundOpacitySlider.value = String(screenAppearance?.opacity ?? 100);
  controls.settingsOpacitySlider.value = String(settingsAppearance?.opacity ?? 80);
  controls.settingsLineOpacitySlider.value = String(settingsAppearance?.lineOpacity ?? 100);
  controls.backgroundColorValue.textContent = screenAppearance?.color ?? "";
  controls.settingsColorValue.textContent = settingsAppearance?.color ?? "";
  controls.settingsLineColorValue.textContent = settingsAppearance?.lineColor ?? "";
  controls.backgroundOpacityValue.textContent = `${Math.round(Number(screenAppearance?.opacity ?? 100))}%`;
  controls.settingsOpacityValue.textContent = `${Math.round(Number(settingsAppearance?.opacity ?? 80))}%`;
  controls.settingsLineOpacityValue.textContent = `${Math.round(Number(settingsAppearance?.lineOpacity ?? 100))}%`;

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

  paletteControls.get("backgroundColorControl")?.setValue(screenAppearance?.color);
  paletteControls.get("settingsColorControl")?.setValue(settingsAppearance?.color);
  paletteControls.get("settingsLineColorControl")?.setValue(settingsAppearance?.lineColor);
  paletteControls.get("oceanColorControl")?.setValue(oceanFill?.color);
  paletteControls.get("graticulesColorControl")?.setValue(graticulesLine?.color);
  paletteControls.get("landFillColorControl")?.setValue(landFill?.color);
  paletteControls.get("landLineColorControl")?.setValue(landLine?.color);
  applyAppearanceStyles();
  applyRowDepthParity();
  renderPaletteControls();
  renderToolbarIcons();
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
    .filter(Boolean)
    .concat(buildDynamicDeckLayers(clippedLayerProps));
}

function buildDynamicDeckLayers(clippedLayerProps) {
  return [...getDynamicLayers()].reverse()
    .flatMap((entry) => getCachedDynamicDeckLayers(entry, clippedLayerProps));
}

function getDynamicDeckLayerSignature(entry, dataRecord) {
  return JSON.stringify({
    loadedAt: dataRecord?.loadedAt ?? 0,
    visible: entry?.visible !== false,
    channels: entry?.channels ?? {},
  });
}

function getCachedDynamicDeckLayers(entry, clippedLayerProps) {
  const dataRecord = getDynamicLayerData(entry.id);
  if (entry?.visible === false || !dataRecord?.geojson) {
    return [];
  }

  const signature = getDynamicDeckLayerSignature(entry, dataRecord);
  const cached = state.dynamicDeckLayerCache.get(entry.id);
  if (cached?.signature === signature) {
    return cached.layers;
  }

  const layers = createDynamicDeckLayers(entry, dataRecord, clippedLayerProps);
  state.dynamicDeckLayerCache.set(entry.id, { signature, layers });
  return layers;
}

function createDynamicDeckLayers(entry, dataRecord, clippedLayerProps) {
  const layers = [];
  const polygonData = dataRecord.geometry?.polygon ?? filterGeojsonByGeometryFamily(dataRecord.geojson, "polygon");
  const lineData = dataRecord.geometry?.line ?? filterGeojsonByGeometryFamily(dataRecord.geojson, "line");
  const pointData = dataRecord.geometry?.point ?? filterGeojsonByGeometryFamily(dataRecord.geojson, "point");
  const fill = getDynamicChannel(entry, "fill");
  const line = getDynamicChannel(entry, "line");
  const point = getDynamicChannel(entry, "point");
  const pointLine = getDynamicChannel(entry, "pointLine");

  if (polygonData.features.length && fill?.visible !== false) {
    layers.push(new GeoJsonLayer({
      id: `earthlab-dynamic-${entry.id}-fill`,
      ...clippedLayerProps,
      data: polygonData,
      filled: true,
      stroked: false,
      getFillColor: toDeckColor(fill.color, percentToAlpha(fill.opacity)),
      pickable: true,
      parameters: { depthTest: false },
    }));
  }

  if ((polygonData.features.length || lineData.features.length) && line?.visible !== false) {
    layers.push(new GeoJsonLayer({
      id: `earthlab-dynamic-${entry.id}-line`,
      ...clippedLayerProps,
      data: {
        type: "FeatureCollection",
        features: [...polygonData.features, ...lineData.features],
      },
      filled: false,
      stroked: true,
      getLineColor: toDeckColor(line.color, percentToAlpha(line.opacity)),
      getLineWidth: Number(line.width) || 0,
      lineWidthUnits: "pixels",
      lineWidthMinPixels: Number(line.width) || 0,
      jointRounded: true,
      capRounded: true,
      pickable: true,
      parameters: { depthTest: false },
    }));
  }

  if (pointData.features.length && point?.visible !== false) {
    layers.push(new GeoJsonLayer({
      id: `earthlab-dynamic-${entry.id}-point`,
      ...clippedLayerProps,
      data: pointData,
      filled: true,
      stroked: true,
      pointType: "circle",
      getFillColor: toDeckColor(point.color, percentToAlpha(point.opacity)),
      getLineColor: toDeckColor(pointLine?.color ?? "#000000", percentToAlpha(pointLine?.visible === false ? 0 : pointLine?.opacity ?? 100)),
      getLineWidth: pointLine?.visible === false ? 0 : Number(pointLine?.width ?? 1) || 0,
      lineWidthUnits: "pixels",
      lineWidthMinPixels: pointLine?.visible === false ? 0 : Number(pointLine?.width ?? 1) || 0,
      getPointRadius: Number(point.radius) || 1,
      pointRadiusUnits: "pixels",
      pointRadiusMinPixels: Number(point.radius) || 1,
      pickable: true,
      parameters: { depthTest: false },
    }));
  }

  return layers;
}

function getFeatureGeometryFamily(feature) {
  const type = feature?.geometry?.type;
  if (type === "Point" || type === "MultiPoint") return "point";
  if (type === "LineString" || type === "MultiLineString") return "line";
  if (type === "Polygon" || type === "MultiPolygon") return "polygon";
  return null;
}

function filterGeojsonByGeometryFamily(geojson, family) {
  return {
    type: "FeatureCollection",
    features: (geojson?.features ?? []).filter((feature) => getFeatureGeometryFamily(feature) === family),
  };
}

function updateOverlay() {
  if (!state.overlay) {
    return;
  }
  syncControlsFromState();
  state.overlay.setProps({ layers: buildLayers() });
  updateStatus();
}

function updateOverlayLayersOnly() {
  if (!state.overlay) {
    return;
  }
  state.overlay.setProps({ layers: buildLayers() });
  updateStatus();
}

function syncPanelCollapsed() {
  controls.panel.dataset.collapsed = String(state.panelCollapsed);
  controls.panelCloseBtn.textContent = state.panelCollapsed ? "=" : "×";
  controls.panelCloseBtn.setAttribute("aria-label", state.panelCollapsed ? "Open panel" : "Close panel");
}

function syncEarthLayers() {
  controls.rows.hidden = !state.earthLayersExpanded;
  controls.earthLayersBtn.setAttribute("aria-label", state.earthLayersExpanded ? "Collapse earth layers" : "Expand earth layers");
  controls.earthLayersBtn.dataset.active = String(state.earthLayersExpanded);
  controls.earthChildren.hidden = !state.earthExpanded;
  controls.earthToggle.setAttribute("aria-checked", String(getLayer("earth")?.visible !== false));
}

function syncAddLayerPanel() {
  controls.addLayerPanel.hidden = !state.addLayerPanelOpen;
  controls.addLayerBtn.setAttribute("aria-expanded", String(state.addLayerPanelOpen));
  controls.addLayerSearchInput.value = state.addLayerSearch;
  renderExistingLayerList();
}

function collapseMenuSections() {
  state.earthLayersExpanded = false;
  state.earthExpanded = false;
  state.expandedRows.ocean = false;
  state.expandedRows.graticules = false;
  state.expandedRows.land = false;
  state.activeChildPanelByRow.land = null;
  state.appearanceExpanded = false;
  state.appearanceGroupExpanded = false;
  state.activeAppearancePanels.background = false;
  state.activeAppearancePanels.settings = false;
  state.dynamicExpandedLayerIds.clear();
  state.activeDynamicStylePanels.clear();
  state.addLayerPanelOpen = false;
}

function formatGeometryTypes(geometryTypes = [], geometryType = "mixed") {
  const types = Array.isArray(geometryTypes) && geometryTypes.length ? geometryTypes : [geometryType];
  return types.filter(Boolean).join(", ") || "mixed";
}

function getDefaultDynamicLayerStyle(style = {}) {
  return {
    color: normalizeHexColor(style?.color ?? "#e74c3c") ?? "#e74c3c",
    opacity: clampOpacity(style?.opacity ?? 80),
    lineWidth: Math.max(0, Number(style?.weight ?? style?.lineWidth ?? 2) || 0),
    pointRadius: Math.max(1, Number(style?.radius ?? style?.pointRadius ?? 6) || 6),
  };
}

function renderExistingLayerList() {
  const list = controls.addLayerExistingList;
  if (!list) {
    return;
  }

  const search = state.addLayerSearch.trim().toLowerCase();
  const layers = search
    ? state.existingLayers.filter((layer) => {
      const layerName = String(layer.label ?? layer.name ?? "").toLowerCase();
      return layerName.includes(search);
    })
    : state.existingLayers;

  if (state.existingLayersLoading) {
    list.className = "earthlab-existing-placeholder";
    list.innerHTML = `
      <span class="earthlab-existing-placeholder-title">Loading layers</span>
      <span class="earthlab-existing-placeholder-copy">Fetching Supabase catalog...</span>
    `;
    return;
  }

  if (state.existingLayersError) {
    list.className = "earthlab-existing-placeholder";
    list.innerHTML = `
      <span class="earthlab-existing-placeholder-title">Could not load layers</span>
      <span class="earthlab-existing-placeholder-copy">${escapeHtml(state.existingLayersError)}</span>
    `;
    return;
  }

  if (state.addLayerActionError) {
    list.className = "earthlab-existing-placeholder";
    list.innerHTML = `
      <span class="earthlab-existing-placeholder-title">Could not add layer</span>
      <span class="earthlab-existing-placeholder-copy">${escapeHtml(state.addLayerActionError)}</span>
    `;
    return;
  }

  if (!state.existingLayers.length) {
    list.className = "earthlab-existing-placeholder";
    list.innerHTML = `
      <span class="earthlab-existing-placeholder-title">No layers found</span>
      <span class="earthlab-existing-placeholder-copy">Public and unlisted Supabase layers will appear here.</span>
    `;
    return;
  }

  if (!layers.length) {
    list.className = "earthlab-existing-placeholder";
    list.innerHTML = `
      <span class="earthlab-existing-placeholder-title">No matches</span>
      <span class="earthlab-existing-placeholder-copy">No existing layers match "${escapeHtml(state.addLayerSearch)}".</span>
    `;
    return;
  }

  list.className = "earthlab-existing-list";
  list.innerHTML = layers.map((layer) => `
    <button class="earthlab-existing-item" type="button" data-layer-id="${escapeHtml(layer.id)}" ${state.loadingExistingLayerId ? "disabled" : ""}>
      <span class="earthlab-existing-item-name">${escapeHtml(layer.label ?? "Untitled layer")}</span>
      <span class="earthlab-existing-item-meta">${
        state.loadingExistingLayerId === layer.id
          ? "Loading..."
          : getDynamicLayers().some((entry) => entry.id === layer.id)
            ? "Added"
            : escapeHtml(formatGeometryTypes(layer.geometryTypes, layer.geometryType))
      }</span>
    </button>
  `).join("");
}

async function addExistingLayerToMap(layerId) {
  if (!layerId || state.loadingExistingLayerId) {
    return;
  }

  const existing = getDynamicLayers().find((entry) => entry.id === layerId);
  if (existing) {
    existing.visible = true;
    persistDynamicLayers();
    state.addLayerPanelOpen = false;
    syncAddLayerPanel();
    await ensureDynamicLayerLoaded(existing.id);
    updateOverlay();
    return;
  }

  state.loadingExistingLayerId = layerId;
  state.addLayerActionError = "";
  state.loadingDynamicLayerIds.add(layerId);
  renderExistingLayerList();

  try {
    const loaded = await loadLayerFromSupabase(layerId);
    if (!loaded.geojson) {
      throw new Error("This layer is not available as GeoJSON yet.");
    }

    const nextLayer = {
      id: loaded.layer.id,
      label: loaded.layer.name ?? "Untitled layer",
      source: "supabase",
      geometryTypes: loaded.layer.geometryTypes,
      geometryType: loaded.layer.geometry_type ?? "mixed",
      style: getDefaultDynamicLayerStyle(loaded.layer.default_style),
      visible: true,
    };
    setDynamicLayerData(layerId, loaded.geojson);
    state.dynamicLayerErrors.delete(layerId);
    state.layerState.dynamicLayers = normalizeDynamicLayers([...getDynamicLayers(), nextLayer]);
    state.addLayerPanelOpen = false;
    persistLayerState();
    updateOverlay();
  } catch (error) {
    state.addLayerActionError = error?.message ?? "Failed to add layer.";
    state.dynamicLayerErrors.set(layerId, state.addLayerActionError);
    syncControlsFromState();
  } finally {
    state.loadingExistingLayerId = "";
    state.loadingDynamicLayerIds.delete(layerId);
    syncControlsFromState();
    syncAddLayerPanel();
  }
}

async function ensureDynamicLayerLoaded(layerId) {
  const layer = getDynamicLayers().find((entry) => entry.id === layerId);
  if (!layer || getDynamicLayerData(layerId) || state.loadingDynamicLayerIds.has(layerId)) {
    return;
  }

  state.loadingDynamicLayerIds.add(layerId);
  state.dynamicLayerErrors.delete(layerId);
  syncControlsFromState();

  try {
    const loaded = await loadLayerFromSupabase(layerId);
    if (!loaded.geojson) {
      throw new Error("This layer is not available as GeoJSON yet.");
    }

    setDynamicLayerData(layerId, loaded.geojson);
    state.dynamicLayerErrors.delete(layerId);
    updateOverlay();
  } catch (error) {
    state.dynamicLayerErrors.set(layerId, error?.message ?? "Failed to load layer.");
    syncControlsFromState();
  } finally {
    state.loadingDynamicLayerIds.delete(layerId);
    syncControlsFromState();
    syncAddLayerPanel();
  }
}

function hydratePersistedDynamicLayers() {
  getDynamicLayers().forEach((layer) => {
    void ensureDynamicLayerLoaded(layer.id);
  });
}

async function ensureExistingLayersLoaded() {
  if (state.existingLayersLoaded || state.existingLayersLoading) {
    return;
  }

  state.existingLayersLoading = true;
  state.existingLayersError = "";
  syncAddLayerPanel();

  try {
    state.existingLayers = await getSupabaseCatalog();
    state.existingLayersLoaded = true;
  } catch (error) {
    state.existingLayers = [];
    state.existingLayersError = error?.message ?? "Failed to load layers.";
  } finally {
    state.existingLayersLoading = false;
    syncAddLayerPanel();
  }
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
  if (scope === "dynamic") return controls.dynamicRows;
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

  if (drag.scope === "dynamic") {
    rebuildDynamicLayerOrderFromDom();
  } else {
    rebuildRenderOrderFromDom();
  }
  const orderKey = drag.scope === "dynamic"
    ? getDynamicLayers().map((layer) => layer.id).join("|")
    : state.layerState.order.join("|");
  if (orderKey !== drag.lastOrderKey) {
    drag.lastOrderKey = orderKey;
    if (drag.scope === "dynamic") {
      updateOverlayLayersOnly();
    } else {
      persistLayerState();
      updateOverlay();
    }
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
    if (drag.scope === "dynamic") {
      const layerId = drag.rowElement.dataset.dynamicLayerId;
      state.dynamicExpandedLayerIds.delete(layerId);
      state.activeDynamicStylePanels.delete(layerId);
      drag.rowElement.querySelector(":scope > .earthlab-row-children")?.setAttribute("hidden", "");
    } else if (rowId === "ocean" || rowId === "graticules") {
      state.expandedRows[rowId] = false;
      syncControlsFromState();
    } else if (rowId === "land") {
      state.expandedRows.land = false;
      state.activeChildPanelByRow.land = null;
      syncControlsFromState();
    } else if (rowId === "landFill" && state.activeChildPanelByRow.land === "fill") {
      state.activeChildPanelByRow.land = null;
      syncControlsFromState();
    } else if (rowId === "landLine" && state.activeChildPanelByRow.land === "line") {
      state.activeChildPanelByRow.land = null;
      syncControlsFromState();
    }
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

  function startPendingDrag(rowElement, event) {
    if (event.button !== 0) return;

    const target = getElementTarget(event);
    if (!target) return;
    if (!rowElement.dataset.reorderScope) return;
    if (rowElement.dataset.rowId === "earth") return;
    if (target.closest(".earthlab-row") !== rowElement) return;
    if (
      target.closest(".earthlab-row-style") ||
      target.closest("input, textarea, select") ||
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
  }

  controls.rows.querySelectorAll(".earthlab-row").forEach((rowElement) => {
    rowElement.addEventListener("pointerdown", (event) => {
      startPendingDrag(rowElement, event);
    });
  });

  controls.dynamicRows.addEventListener("pointerdown", (event) => {
    const rowElement = getElementTarget(event)?.closest(".earthlab-row");
    if (!rowElement || rowElement.parentElement !== controls.dynamicRows) {
      return;
    }
    startPendingDrag(rowElement, event);
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
      if (drag.scope === "dynamic") {
        persistLayerState();
        syncControlsFromState();
      }
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
      if (drag.scope === "dynamic") {
        persistLayerState();
        syncControlsFromState();
      }
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
    ["appearanceToggle", () => {
      state.appearanceExpanded = false;
      state.appearanceGroupExpanded = false;
      state.activeAppearancePanels.background = false;
      state.activeAppearancePanels.settings = false;
    }],
    ["backgroundToggle", () => {
      state.appearanceGroupExpanded = true;
      state.activeAppearancePanels.background = !state.activeAppearancePanels.background;
      state.appearanceExpanded = true;
    }],
    ["settingsToggle", () => {
      state.appearanceGroupExpanded = true;
      state.activeAppearancePanels.settings = !state.activeAppearancePanels.settings;
      state.appearanceExpanded = true;
    }],
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
    ["backgroundOpacitySlider", { appearanceKind: "screen", key: "opacity", numeric: true }],
    ["settingsOpacitySlider", { appearanceKind: "settings", key: "opacity", numeric: true }],
    ["settingsLineOpacitySlider", { appearanceKind: "settings", key: "lineOpacity", numeric: true }],
    ["oceanOpacitySlider", { layerId: "ocean", channelId: "fill", key: "opacity", numeric: true }],
    ["graticulesOpacitySlider", { layerId: "graticules", channelId: "line", key: "opacity", numeric: true }],
    ["graticulesWidthSlider", { layerId: "graticules", channelId: "line", key: "width", numeric: true }],
    ["landFillOpacitySlider", { layerId: "land", channelId: "fill", key: "opacity", numeric: true }],
    ["landLineOpacitySlider", { layerId: "land", channelId: "line", key: "opacity", numeric: true }],
    ["landLineWidthSlider", { layerId: "land", channelId: "line", key: "width", numeric: true }],
  ].forEach(([controlKey, target]) => {
    controls[controlKey].addEventListener("input", (event) => {
      if (target.appearanceKind) {
        const appearance = getAppearance(target.appearanceKind);
        if (!appearance) {
          return;
        }
        appearance[target.key] = target.numeric ? Number(event.currentTarget.value) : event.currentTarget.value;
        persistLayerState();
        updateOverlay();
        return;
      }
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
        state.earthLayersExpanded = false;
        state.earthExpanded = false;
        state.expandedRows.ocean = false;
        state.expandedRows.graticules = false;
        state.expandedRows.land = false;
        state.activeChildPanelByRow.land = null;
        syncEarthLayers();
        return;
      }

      toggleStyleRow(rowId);
    });
  });

  controls.appearanceRows.querySelectorAll(".earthlab-row").forEach((rowElement) => {
    const rowId = rowElement.dataset.rowId;
    const toggleButton = rowElement.querySelector(":scope > .earthlab-row-toggle");
    const stylePanel = rowElement.querySelector(":scope > .earthlab-row-style");

    rowElement.addEventListener("click", (event) => {
      const target = getElementTarget(event);
      if (!rowId || !target || target.closest(".earthlab-row") !== rowElement) {
        return;
      }
      if (toggleButton?.contains(target) || stylePanel?.contains(target)) {
        return;
      }
      if (rowId === "appearance" || rowId === "background" || rowId === "settings") {
        controls[`${rowId}Toggle`]?.click();
      }
    });
  });

  controls.panelCloseBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    state.panelCollapsed = !state.panelCollapsed;
    if (state.panelCollapsed) {
      collapseMenuSections();
    }
    syncPanelCollapsed();
    syncEarthLayers();
    syncControlsFromState();
    syncAddLayerPanel();
  });

  controls.earthLayersBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    state.earthLayersExpanded = !state.earthLayersExpanded;
    if (state.earthLayersExpanded) {
      state.earthExpanded = true;
      state.appearanceExpanded = false;
      state.appearanceGroupExpanded = false;
      state.activeAppearancePanels.background = false;
      state.activeAppearancePanels.settings = false;
    }
    syncEarthLayers();
    syncControlsFromState();
  });

  controls.appearanceBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    state.appearanceExpanded = !state.appearanceExpanded;
    if (state.appearanceExpanded) {
      state.appearanceGroupExpanded = true;
      state.earthLayersExpanded = false;
      state.earthExpanded = false;
      state.expandedRows.ocean = false;
      state.expandedRows.graticules = false;
      state.expandedRows.land = false;
      state.activeChildPanelByRow.land = null;
    } else {
      state.appearanceGroupExpanded = false;
      state.activeAppearancePanels.background = false;
      state.activeAppearancePanels.settings = false;
    }
    syncEarthLayers();
    syncControlsFromState();
  });

  controls.addLayerBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    state.addLayerPanelOpen = !state.addLayerPanelOpen;
    if (state.addLayerPanelOpen) {
      state.addLayerActionError = "";
      void ensureExistingLayersLoaded();
    }
    syncAddLayerPanel();
  });

  controls.addLayerSearchInput.addEventListener("input", (event) => {
    state.addLayerSearch = event.target.value;
    state.addLayerActionError = "";
    renderExistingLayerList();
  });

  controls.addLayerExistingList.addEventListener("click", (event) => {
    const target = getElementTarget(event);
    const item = target?.closest(".earthlab-existing-item");
    const layerId = item?.dataset?.layerId;
    if (!layerId) {
      return;
    }
    event.stopPropagation();
    void addExistingLayerToMap(layerId);
  });

  controls.dynamicRows.addEventListener("click", (event) => {
    const target = getElementTarget(event);
    if (!target) {
      return;
    }

    const toggle = target?.closest("[data-dynamic-layer-toggle]");
    const layerId = toggle?.dataset?.dynamicLayerToggle;
    if (layerId) {
      const layer = getDynamicLayers().find((entry) => entry.id === layerId);
      if (!layer) {
        return;
      }
      event.stopPropagation();
      layer.visible = layer.visible === false;
      persistDynamicLayers();
      if (layer.visible) {
        void ensureDynamicLayerLoaded(layer.id);
      }
      updateOverlay();
      return;
    }

    const channelToggle = target.closest("[data-dynamic-channel-toggle]");
    if (channelToggle) {
      const channelRow = channelToggle.closest("[data-dynamic-channel-row]");
      const parentLayerId = channelRow?.dataset?.dynamicLayerId;
      const channelId = channelToggle.dataset.dynamicChannelToggle;
      const layer = getDynamicLayers().find((entry) => entry.id === parentLayerId);
      const channel = getDynamicChannel(layer, channelId);
      if (!channel) {
        return;
      }
      event.stopPropagation();
      channel.visible = channel.visible === false;
      persistDynamicLayers();
      updateOverlay();
      return;
    }

    if (
      target.closest(".earthlab-row-style") ||
      target.closest("input, textarea, select") ||
      target.closest(".earthlab-color-control")
    ) {
      return;
    }

    const channelRow = target.closest("[data-dynamic-channel-row]");
    if (channelRow && controls.dynamicRows.contains(channelRow)) {
      const parentLayerId = channelRow.dataset.dynamicLayerId;
      const channelId = channelRow.dataset.dynamicChannelRow;
      state.dynamicExpandedLayerIds.add(parentLayerId);
      state.activeDynamicStylePanels.set(
        parentLayerId,
        state.activeDynamicStylePanels.get(parentLayerId) === channelId ? null : channelId,
      );
      event.stopPropagation();
      syncControlsFromState();
      return;
    }

    const parentRow = target.closest("[data-dynamic-layer-id]");
    if (parentRow && parentRow.parentElement === controls.dynamicRows) {
      const parentLayerId = parentRow.dataset.dynamicLayerId;
      if (state.dynamicExpandedLayerIds.has(parentLayerId)) {
        state.dynamicExpandedLayerIds.delete(parentLayerId);
        state.activeDynamicStylePanels.delete(parentLayerId);
      } else {
        state.dynamicExpandedLayerIds.add(parentLayerId);
      }
      event.stopPropagation();
      syncControlsFromState();
    }
  });

  controls.dynamicRows.addEventListener("input", (event) => {
    const target = getElementTarget(event);
    if (!target?.matches("[data-dynamic-slider]")) {
      return;
    }
    const layer = getDynamicLayers().find((entry) => entry.id === target.dataset.dynamicLayerId);
    const channel = getDynamicChannel(layer, target.dataset.dynamicChannelId);
    if (!channel) {
      return;
    }
    const key = target.dataset.dynamicSlider;
    const value = Number(target.value);
    if (key === "opacity") {
      channel.opacity = clampOpacity(value);
    } else if (key === "width") {
      channel.width = Math.max(0, value);
    } else if (key === "radius") {
      channel.radius = Math.max(1, value);
    }
    persistDynamicLayers();
    updateDynamicLayerPresentation(layer.id, target.dataset.dynamicChannelId);
    updateOverlayLayersOnly();
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
    dynamicPaletteControls.forEach((control) => {
      if (control.contains(target)) {
        withinPaletteControl = true;
      } else {
        control.close();
      }
    });

    if (!controls.panel.contains(target)) {
      if (!state.panelCollapsed) {
        state.panelCollapsed = true;
        collapseMenuSections();
        syncPanelCollapsed();
        syncEarthLayers();
        syncAddLayerPanel();
      }
      syncControlsFromState();
      return;
    }

    const insideLayerRows = controls.rows.contains(target) || controls.dynamicRows.contains(target);
    if (!insideLayerRows && !withinPaletteControl) {
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
  const sharedSnapshot = await readShareSnapshotFromLocation();
  const initialMapView = sharedSnapshot ? applyShareSnapshot(sharedSnapshot) ?? readMapView() : readMapView();
  const hasSharedMapView = Boolean(sharedSnapshot?.mv);
  syncRowOrderFromState();
  syncControlsFromState();
  syncPanelCollapsed();
  syncEarthLayers();
  syncAddLayerPanel();
  mountPaletteControls();
  bindControls();
  bindReloadControls();
  bindShareControls();

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
            "background-color": getScreenBackgroundFill(),
            "background-opacity": 1,
          },
        },
      ],
    },
    center: initialMapView.center,
    zoom: initialMapView.zoom,
    bearing: initialMapView.bearing,
    pitch: initialMapView.pitch,
    attributionControl: false,
  });

  state.map.on("move", () => {
    updateStatus();
  });
  state.map.on("moveend", () => {
    persistMapView();
    updateStatus();
  });

  let sharedViewAnimated = false;
  function easeToSharedMapViewAfterBoot() {
    if (!hasSharedMapView || sharedViewAnimated) {
      return;
    }
    sharedViewAnimated = true;
    state.map.easeTo({
      center: initialMapView.center,
      zoom: initialMapView.zoom,
      bearing: initialMapView.bearing,
      pitch: initialMapView.pitch,
      duration: 1400,
      essential: true,
    });
  }

  state.map.on("load", () => {
    state.overlay = new MapboxOverlay({
      interleaved: false,
      layers: buildLayers(),
    });
    state.map.addControl(state.overlay);
    setBootStage("shell");
    updateStatus();
    hydratePersistedDynamicLayers();

    void loadJson(LAND_LOW_URL)
      .then((landLow) => {
        state.landLow = landLow;
        state.land = landLow;
        setBootStage("ready");
        updateOverlay();
        easeToSharedMapViewAfterBoot();
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
              easeToSharedMapViewAfterBoot();
            })
            .catch((graticulesError) => {
              console.warn("[earthlab] Failed to load graticules.", graticulesError);
              easeToSharedMapViewAfterBoot();
            });
        });
      });
  });

  window.earthlabShare = {
    applySnapshot: applyShareSnapshot,
    buildSnapshot: buildShareSnapshot,
    createUrl: createShareUrlFromCurrentState,
    readShare: readShareSnapshotFromLocation,
  };
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

function bindShareControls() {
  const shareBtn = document.getElementById("shareBtn");
  if (!shareBtn) {
    return;
  }

  let feedbackTimer = null;

  shareBtn.addEventListener("click", async () => {
    shareBtn.disabled = true;
    try {
      await copyShareUrl();
      shareBtn.textContent = "Copied";
    } catch (error) {
      console.warn("[earthlab] Failed to build share URL.", error);
      shareBtn.textContent = "Error";
    } finally {
      shareBtn.disabled = false;
      window.clearTimeout(feedbackTimer);
      feedbackTimer = window.setTimeout(() => {
        shareBtn.textContent = "Share";
      }, 1200);
    }
  });
}

function bindMapName() {
  const label = document.getElementById("mapNameLabel");
  if (!label) return;

  const saved = localStorage.getItem(MAP_NAME_KEY);
  if (saved && !label.textContent.trim()) label.textContent = saved;

  const wrapper = document.createElement("span");
  wrapper.className = "earthlab-kicker-wrap";
  label.insertAdjacentElement("beforebegin", wrapper);
  wrapper.append(label);

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "earthlab-kicker-clear";
  clearBtn.textContent = "×";
  clearBtn.hidden = true;
  wrapper.append(clearBtn);

  function syncEmpty() {
    label.dataset.empty = String(label.textContent.trim() === "");
  }

  syncEmpty();

  label.addEventListener("input", syncEmpty);

  label.addEventListener("focus", () => {
    clearBtn.hidden = false;
  });

  label.addEventListener("blur", (e) => {
    if (e.relatedTarget === clearBtn) return;
    clearBtn.hidden = true;
    localStorage.setItem(MAP_NAME_KEY, label.textContent.trim());
    syncEmpty();
  });

  clearBtn.addEventListener("mousedown", (e) => e.preventDefault());
  clearBtn.addEventListener("click", () => {
    label.textContent = "";
    syncEmpty();
    label.focus();
  });

  label.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      label.blur();
    }
  });
}

bootstrap().catch((error) => {
  console.error(error);
});

bindMapName();
