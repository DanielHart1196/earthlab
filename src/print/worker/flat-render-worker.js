import { buildDynamicDrawCommands } from "../dynamic-commands.js";
import { createPerfTracker } from "../perf-metrics.js";
import { createProjectionAdapter, createProjectionAdapterState, getProjectionViewportTransform } from "../projection-adapters.js";
import { createRenderInvalidation } from "../render-invalidation.js";
import { drawProjectedScene, prepareContext } from "../shared-canvas.js";
import { PRINT_WORKER_MESSAGE } from "./worker-protocol.js";

let width = 0;
let height = 0;
let pixelRatio = 1;
let sceneRevision = 0;
let interactionActive = false;
let projection = "naturalEarth";
let locked = true;
let camera = { zoomScale: 1, panX: 0, panY: 0 };
let frameRequestKey = "";
let sceneProps = {
  backgroundFill: "#f9f9ef",
  oceanFill: { color: "#f9f9ef", opacity: 100 },
  landFill: { color: "#6eaa6e", opacity: 100 },
  landLine: { color: "#000000", opacity: 100, width: 1 },
  graticulesLine: { color: "#8fa9bc", opacity: 100, width: 1 },
  land: null,
  interactionLand: null,
  graticules: null,
  dynamicLayers: [],
  dynamicLayerData: [],
  earthRenderOrder: [],
};
let preparedDynamicCommands = [];
const invalidation = createRenderInvalidation();
const projectionAdapterState = createProjectionAdapterState();
const layerSurfaces = {
  earth: null,
  dynamicShapes: null,
  points: null,
};
const layerContexts = {
  earth: null,
  dynamicShapes: null,
  points: null,
};
let frameSurface = null;
let frameContext = null;
let renderQueued = false;
let perfTracker = createPerfTracker("worker", false);

function createSurface() {
  return new OffscreenCanvas(
    Math.max(1, Math.round(width * pixelRatio)),
    Math.max(1, Math.round(height * pixelRatio)),
  );
}

function ensureSurface(name) {
  const scaledWidth = Math.max(1, Math.round(width * pixelRatio));
  const scaledHeight = Math.max(1, Math.round(height * pixelRatio));
  if (!layerSurfaces[name] || layerSurfaces[name].width !== scaledWidth || layerSurfaces[name].height !== scaledHeight) {
    layerSurfaces[name] = createSurface();
    layerContexts[name] = layerSurfaces[name].getContext("2d");
  }
  layerContexts[name].setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  return { surface: layerSurfaces[name], context: layerContexts[name] };
}

function ensureFrameSurface() {
  const scaledWidth = Math.max(1, Math.round(width * pixelRatio));
  const scaledHeight = Math.max(1, Math.round(height * pixelRatio));
  if (!frameSurface || frameSurface.width !== scaledWidth || frameSurface.height !== scaledHeight) {
    frameSurface = createSurface();
    frameContext = frameSurface.getContext("2d");
  }
  frameContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
}

function rebuildPreparedCommands() {
  preparedDynamicCommands = perfTracker.time(
    "buildDynamicCommandsMs",
    () => buildDynamicDrawCommands(sceneProps.dynamicLayers, sceneProps.dynamicLayerData),
  );
  perfTracker.gauge("preparedDynamicCommands", preparedDynamicCommands.length);
}

function buildBaseProjectionAdapter(renderQuality = "settled") {
  return createProjectionAdapter({
    projectionType: projection,
    width,
    height,
    camera,
    locked,
    state: projectionAdapterState,
    perfTracker,
    renderQuality,
  });
}

function getActiveLand() {
  return interactionActive
    ? sceneProps.interactionLand ?? sceneProps.land
    : sceneProps.land;
}

function rebuildLayer(name) {
  const { context } = ensureSurface(name);
  prepareContext(context, width, height, "rgba(0, 0, 0, 0)");
  const projectionAdapter = buildBaseProjectionAdapter("settled");
  drawProjectedScene(
    context,
    projectionAdapter,
    sceneProps,
    preparedDynamicCommands,
    {
      land: getActiveLand(),
      graticules: sceneProps.graticules,
      applyViewportTransform: false,
      includeEarth: name === "earth",
      includeDynamicShapes: name === "dynamicShapes",
      includePoints: name === "points",
      perfTracker,
    },
  );
}

function drawInteractionFrame() {
  ensureFrameSurface();
  prepareContext(frameContext, width, height, sceneProps.backgroundFill);
  const transform = getProjectionViewportTransform(projection, width, height, camera, { locked });
  if (!transform) {
    drawSettledFrame();
    return;
  }
  frameContext.save();
  frameContext.transform(transform.zoom, 0, 0, transform.zoom, transform.tx, transform.ty);
  frameContext.drawImage(layerSurfaces.earth, 0, 0, width, height);
  frameContext.drawImage(layerSurfaces.dynamicShapes, 0, 0, width, height);
  frameContext.drawImage(layerSurfaces.points, 0, 0, width, height);
  frameContext.restore();
}

function drawSettledFrame() {
  ensureFrameSurface();
  prepareContext(frameContext, width, height, sceneProps.backgroundFill);
  const projectionAdapter = buildBaseProjectionAdapter("settled");
  drawProjectedScene(
    frameContext,
    projectionAdapter,
    sceneProps,
    preparedDynamicCommands,
    {
      land: getActiveLand(),
      graticules: sceneProps.graticules,
      applyViewportTransform: true,
      includeEarth: true,
      includeDynamicShapes: true,
      includePoints: true,
      perfTracker,
    },
  );
}

function postFrame() {
  const bitmap = frameSurface.transferToImageBitmap();
  self.postMessage(
    {
      type: PRINT_WORKER_MESSAGE.FRAME,
      bitmap,
      width,
      height,
      pixelRatio,
      projection,
      interactionActive,
      sceneRevision,
      frameRequestKey,
      perf: perfTracker.publish({ reset: true }),
    },
    [bitmap],
  );
}

function renderNow() {
  renderQueued = false;
  if (!width || !height) {
    return;
  }
  const started = performance.now();
  const dirty = invalidation.consume();
  if (dirty.has("earth")) rebuildLayer("earth");
  if (dirty.has("dynamic-shapes")) rebuildLayer("dynamicShapes");
  if (dirty.has("points")) rebuildLayer("points");
  if (interactionActive) {
    drawInteractionFrame();
  } else {
    drawSettledFrame();
  }
  perfTracker.recordDuration("workerRenderNowMs", performance.now() - started);
  postFrame();
}

function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(renderNow, 0);
}

self.onmessage = (event) => {
  const message = event.data;
  switch (message.type) {
    case PRINT_WORKER_MESSAGE.INIT:
      width = message.width;
      height = message.height;
      pixelRatio = message.pixelRatio || 1;
      perfTracker = createPerfTracker("worker", message.perfEnabled === true);
      invalidation.invalidate("all");
      requestRender();
      break;
    case PRINT_WORKER_MESSAGE.SET_SCENE:
      sceneProps = message.scene;
      sceneRevision = message.sceneRevision;
      rebuildPreparedCommands();
      invalidation.invalidate(["earth", "dynamic-shapes", "points", "frame"]);
      requestRender();
      break;
    case PRINT_WORKER_MESSAGE.SET_VIEW:
      width = message.width;
      height = message.height;
      pixelRatio = message.pixelRatio || 1;
      projection = message.projection;
      locked = message.locked !== false;
      camera = message.camera;
      frameRequestKey = message.frameRequestKey ?? "";
      invalidation.invalidate(message.sceneDirty || !locked ? "all" : "frame");
      requestRender();
      break;
    case PRINT_WORKER_MESSAGE.SET_INTERACTION:
      interactionActive = message.active;
      invalidation.invalidate(["earth", "frame"]);
      requestRender();
      break;
    case PRINT_WORKER_MESSAGE.RENDER:
      invalidation.invalidate(message.passes ?? "frame");
      requestRender();
      break;
    case PRINT_WORKER_MESSAGE.DISPOSE:
      self.close();
      break;
    default:
      break;
  }
};
