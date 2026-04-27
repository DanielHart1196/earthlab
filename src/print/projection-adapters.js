import { geoOrthographic, geoPath, geoStream } from "d3-geo";
import { geoNaturalEarth2, geoInterruptedHomolosine, geoPolyhedralWaterman } from "d3-geo-projection";

export const PROJECTIONS = [
  { id: "orthographic", name: "Orthographic" },
  { id: "naturalEarth", name: "Natural Earth" },
  { id: "goode", name: "Goode's Homolosine" },
  { id: "waterman", name: "Waterman Butterfly" },
];

const VALID_PROJECTION_IDS = new Set(PROJECTIONS.map((p) => p.id));

export function isValidProjectionId(id) {
  return VALID_PROJECTION_IDS.has(id);
}

export const DEFAULT_PRINT_CAMERA = {
  zoomScale: 1,
  rotationLon: 0,
  rotationLat: 0,
};

export const DEFAULT_FLAT_CAMERA = {
  zoomScale: 1,
  panX: 0,
  panY: 0,
};

export const ORTHOGRAPHIC_DRAG_SENSITIVITY = 0.35;

const ORTHOGRAPHIC_BASE_ROTATE = [20, -10, 0];
const FLAT_FIT_PADDING = 8;

const FLAT_PROJECTION_FNS = {
  naturalEarth: geoNaturalEarth2,
  goode: geoInterruptedHomolosine,
  waterman: geoPolyhedralWaterman,
};

export function isFlatProjection(projectionType) {
  return projectionType in FLAT_PROJECTION_FNS;
}

function normalizePrintCamera(camera = null) {
  const zoomScale = Math.max(1, Math.min(16, Number(camera?.zoomScale) || 1));
  const rotationLon = Number(camera?.rotationLon) || 0;
  const rotationLat = Number(camera?.rotationLat) || 0;
  return {
    zoomScale,
    rotationLon,
    rotationLat: Math.max(-89.999, Math.min(109.999, rotationLat)),
  };
}

function normalizeFlatCamera(camera = null) {
  const zoomScale = Math.max(1, Math.min(16, Number(camera?.zoomScale) || 1));
  const panX = Number(camera?.panX) || 0;
  const panY = Number(camera?.panY) || 0;
  return { zoomScale, panX, panY };
}

export function normalizeProjectionCamera(projectionType, camera = null) {
  return isFlatProjection(projectionType)
    ? normalizeFlatCamera(camera)
    : normalizePrintCamera(camera);
}

export function getProjectionGestureMode(projectionType) {
  return isFlatProjection(projectionType) ? "pan" : "rotate";
}

function createOrthographicProjection(width, height, camera, renderQuality = "settled") {
  const padding = Math.max(24, Math.min(width, height) * 0.08);
  const radius = Math.max(120, (Math.min(width, height) / 2) - padding);
  return geoOrthographic()
    .precision(renderQuality === "interactive" ? 2 : 0.5)
    .translate([width / 2, height / 2])
    .scale(radius * camera.zoomScale)
    .rotate([
      ORTHOGRAPHIC_BASE_ROTATE[0] + camera.rotationLon,
      ORTHOGRAPHIC_BASE_ROTATE[1] + camera.rotationLat,
      ORTHOGRAPHIC_BASE_ROTATE[2],
    ])
    .clipAngle(90);
}

// Base projection at scale=1, no pan/zoom baked in.
// Pan/zoom is applied as a canvas transform so Path2Ds only need rebuilding
// when the viewport size changes, not on every camera move.
function createFlatBaseProjection(projFn, width, height, renderQuality = "settled") {
  const projection = projFn();

  if (typeof projection.precision === "function") projection.precision(renderQuality === "interactive" ? 1.25 : 0.5);
  if (typeof projection.center === "function") projection.center([0, 0]);

  projection.translate([width / 2, height / 2]);

  projection.fitExtent(
    [
      [FLAT_FIT_PADDING, FLAT_FIT_PADDING],
      [width - FLAT_FIT_PADDING, height - FLAT_FIT_PADDING],
    ],
    { type: "Sphere" },
  );

  projection.translate([width / 2, height / 2]);

  return projection;
}

// Returns the canvas 2D transform parameters that apply pan/zoom for flat projections.
// Equivalent to: translate to cx+panX, scale around center, translate back.
function getFlatCanvasTransform(width, height, camera) {
  const cx = width / 2;
  const cy = height / 2;
  const zoom = camera.zoomScale;
  const tx = cx * (1 - zoom) + camera.panX * width;
  const ty = cy * (1 - zoom) + camera.panY * height;
  return { zoom, tx, ty };
}

export function getProjectionViewportTransform(projectionType, width, height, camera) {
  if (!isFlatProjection(projectionType)) {
    return null;
  }
  return getFlatCanvasTransform(width, height, normalizeProjectionCamera(projectionType, camera));
}

function buildPath2D(geometry, projection) {
  if (typeof Path2D === "undefined" || !geometry) return null;
  const path2d = new Path2D();
  geoPath(projection, path2d)(geometry);
  return path2d;
}

function collectProjectedPoints(geojson, projection) {
  const points = [];
  const listener = {
    point(x, y) { points.push([x, y]); },
    lineStart() {}, lineEnd() {}, polygonStart() {}, polygonEnd() {}, sphere() {},
  };
  geoStream(geojson, projection.stream(listener));
  return points;
}

export function createProjectionAdapterState() {
  return {
    staticPaths: {
      sphere: { key: "", geometry: null, path: null },
      land: { key: "", geometry: null, path: null },
      graticules: { key: "", geometry: null, path: null },
    },
  };
}

export function createProjectionAdapter({
  projectionType,
  width,
  height,
  camera,
  state,
  renderQuality = "settled",
}) {
  const normalizedCamera = normalizeProjectionCamera(projectionType, camera);
  const isFlat = isFlatProjection(projectionType);

  // For flat projections: base projection with no pan/zoom. Paths are cached by size+type only.
  // For orthographic: full projection with camera baked in.
  const projection = isFlat
    ? createFlatBaseProjection(FLAT_PROJECTION_FNS[projectionType], width, height, renderQuality)
    : createOrthographicProjection(width, height, normalizedCamera, renderQuality);

  // Flat path cache key includes projection type but omits pan/zoom.
  // Orthographic includes full camera since projection changes with every rotation.
  const cameraKey = isFlat
    ? `flat:${projectionType}:${width}:${height}`
    : `ortho:${width}:${height}:${normalizedCamera.zoomScale}:${normalizedCamera.rotationLon}:${normalizedCamera.rotationLat}`;

  const flatTransform = isFlat
    ? getFlatCanvasTransform(width, height, normalizedCamera)
    : null;

  function getStaticPath(name, geometry) {
    const entry = state.staticPaths[name];
    if (!entry || !geometry) return null;
    const nextKey = `${cameraKey}:${geometry.type}`;
    if (entry.key !== nextKey || entry.geometry !== geometry) {
      entry.path = buildPath2D(geometry, projection);
      entry.key = nextKey;
      entry.geometry = geometry;
    }
    return entry.path;
  }

  function getCommandPath(command) {
    if (!command?.geojson || typeof Path2D === "undefined") return null;
    if (command.pathCameraKey !== cameraKey) {
      command.path2d = buildPath2D(command.geojson, projection);
      command.pathCameraKey = cameraKey;
    }
    return command.path2d ?? null;
  }

  function getProjectedPoints(command) {
    if (!command?.geojson) return [];
    if (command.projectedPointsCameraKey !== cameraKey) {
      command.projectedPoints = collectProjectedPoints(command.geojson, projection);
      command.projectedPointsCameraKey = cameraKey;
    }
    return command.projectedPoints ?? [];
  }

  // Wraps a draw callback in the flat projection viewport transform (pan + zoom as canvas
  // matrix). For orthographic, calls fn() directly with no transform.
  function applyViewportTransform(ctx, fn) {
    if (!flatTransform) {
      fn();
      return;
    }
    ctx.save();
    ctx.transform(flatTransform.zoom, 0, 0, flatTransform.zoom, flatTransform.tx, flatTransform.ty);
    fn();
    ctx.restore();
  }

  return {
    projection,
    camera: normalizedCamera,
    cameraKey,
    gestureMode: getProjectionGestureMode(projectionType),
    getStaticPath,
    getCommandPath,
    getProjectedPoints,
    applyViewportTransform,
  };
}
