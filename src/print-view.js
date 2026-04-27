import { createGestureController } from "./print/gesture-controller.js";
import { buildDynamicDrawCommands } from "./print/dynamic-commands.js";
import {
  createProjectionAdapter,
  createProjectionAdapterState,
  DEFAULT_FLAT_CAMERA,
  DEFAULT_PRINT_CAMERA,
  getProjectionGestureMode,
  isFlatProjection,
  normalizeProjectionCamera,
  ORTHOGRAPHIC_DRAG_SENSITIVITY,
  PROJECTIONS,
} from "./print/projection-adapters.js";
import { createRenderInvalidation } from "./print/render-invalidation.js";
import { createPrintSceneModel } from "./print/scene-model.js";
import { drawProjectedScene, prepareContext } from "./print/shared-canvas.js";
import { PRINT_WORKER_MESSAGE } from "./print/worker/worker-protocol.js";

function canUseFlatWorker() {
  return typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined";
}

export function createPrintView({
  mount,
  onCameraChange = null,
  onNaturalEarthCameraChange = null,
  onProjectionChange = null,
}) {
  const container = document.createElement("div");
  container.style.cssText = "position:relative;width:100%;height:100%;overflow:hidden;";

  const canvas = document.createElement("canvas");
  canvas.style.cssText = "width:100%;height:100%;display:block;touch-action:none;";

  const projectionBtn = document.createElement("button");
  projectionBtn.type = "button";
  projectionBtn.className = "earthlab-projection-btn";

  const projectionDropdown = document.createElement("div");
  projectionDropdown.className = "earthlab-projection-dropdown";
  projectionDropdown.hidden = true;
  for (const { id, name } of PROJECTIONS) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "earthlab-projection-option";
    item.dataset.projId = id;
    item.textContent = name;
    projectionDropdown.appendChild(item);
  }

  container.append(canvas, projectionDropdown, projectionBtn);
  mount.replaceChildren(container);

  const context = canvas.getContext("2d");
  const sceneModel = createPrintSceneModel();
  const invalidation = createRenderInvalidation(["scene", "camera", "frame"]);
  const projectionAdapterState = createProjectionAdapterState();

  let width = 0;
  let height = 0;
  let pixelRatio = window.devicePixelRatio || 1;
  let frameHandle = 0;
  let preparedDynamicCommands = [];
  let preparedDynamicKey = "";
  let workerSceneRevisionSent = -1;
  let workerFrameRequestCounter = 0;

  let viewState = {
    projection: "orthographic",
    printCamera: { ...DEFAULT_PRINT_CAMERA },
    naturalEarthCamera: { ...DEFAULT_FLAT_CAMERA },
  };

  const interactionState = {
    active: false,
    pendingCameraCommit: false,
  };
  const stylePreviewState = {
    active: false,
    initialized: false,
    overrides: null,
  };
  const stylePreviewInvalidation = createRenderInvalidation(["earth", "dynamic-shapes", "points"]);
  const stylePreviewSurfaces = {
    earth: null,
    "dynamic-shapes": null,
    points: null,
  };
  const stylePreviewContexts = {
    earth: null,
    "dynamic-shapes": null,
    points: null,
  };

  const workerState = {
    enabled: canUseFlatWorker(),
    instance: null,
    latestBitmap: null,
    latestFrameKey: "",
    currentRequestKey: "",
    awaitingSettledFrame: false,
  };

  function getSceneProps() {
    return sceneModel.get();
  }

  function getStylePreviewSceneProps() {
    if (!stylePreviewState.overrides) {
      return getSceneProps();
    }
    return {
      ...getSceneProps(),
      ...stylePreviewState.overrides,
    };
  }

  function getCamera() {
    return normalizeProjectionCamera(
      viewState.projection,
      isFlatProjection(viewState.projection) ? viewState.naturalEarthCamera : viewState.printCamera,
    );
  }

  function getCameraCommitCallback() {
    return isFlatProjection(viewState.projection) ? onNaturalEarthCameraChange : onCameraChange;
  }

  function commitCameraIfNeeded() {
    if (!interactionState.pendingCameraCommit) {
      return;
    }
    interactionState.pendingCameraCommit = false;
    getCameraCommitCallback()?.(getCamera());
  }

  function applyCamera(nextCamera, { notify = true } = {}) {
    if (isFlatProjection(viewState.projection)) {
      viewState = {
        ...viewState,
        naturalEarthCamera: normalizeProjectionCamera(viewState.projection, nextCamera),
      };
    } else {
      viewState = {
        ...viewState,
        printCamera: normalizeProjectionCamera("orthographic", nextCamera),
      };
    }
    invalidation.invalidate(["camera", "frame"]);
    requestRender();
    if (!notify) {
      return;
    }
    if (interactionState.active) {
      interactionState.pendingCameraCommit = true;
      return;
    }
    getCameraCommitCallback()?.(getCamera());
  }

  function ensurePreparedDynamicCommands() {
    const sceneProps = getSceneProps();
    const nextKey = `${sceneProps.dynamicLayersRevision}:${sceneProps.dynamicLayerDataRevision}`;
    if (nextKey === preparedDynamicKey) {
      return;
    }
    preparedDynamicCommands = buildDynamicDrawCommands(sceneProps.dynamicLayers, sceneProps.dynamicLayerData);
    preparedDynamicKey = nextKey;
  }

  function syncCanvasSize(nextWidth, nextHeight) {
    const dpr = window.devicePixelRatio || 1;
    width = nextWidth;
    height = nextHeight;
    pixelRatio = dpr;
    const scaledWidth = Math.max(1, Math.round(nextWidth * dpr));
    const scaledHeight = Math.max(1, Math.round(nextHeight * dpr));
    if (canvas.width !== scaledWidth || canvas.height !== scaledHeight) {
      canvas.width = scaledWidth;
      canvas.height = scaledHeight;
      invalidation.invalidate(["scene", "camera", "frame"]);
      stylePreviewState.initialized = false;
      stylePreviewInvalidation.invalidate("all");
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function createStylePreviewSurface() {
    if (typeof OffscreenCanvas !== "undefined") {
      return new OffscreenCanvas(
        Math.max(1, Math.round(width * pixelRatio)),
        Math.max(1, Math.round(height * pixelRatio)),
      );
    }
    const surface = document.createElement("canvas");
    surface.width = Math.max(1, Math.round(width * pixelRatio));
    surface.height = Math.max(1, Math.round(height * pixelRatio));
    return surface;
  }

  function ensureStylePreviewSurface(pass) {
    const scaledWidth = Math.max(1, Math.round(width * pixelRatio));
    const scaledHeight = Math.max(1, Math.round(height * pixelRatio));
    const surface = stylePreviewSurfaces[pass];
    if (!surface || surface.width !== scaledWidth || surface.height !== scaledHeight) {
      stylePreviewSurfaces[pass] = createStylePreviewSurface();
      stylePreviewContexts[pass] = stylePreviewSurfaces[pass].getContext("2d");
    }
    stylePreviewContexts[pass].setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    return stylePreviewContexts[pass];
  }

  function updateProjectionBtn() {
    const proj = PROJECTIONS.find((p) => p.id === viewState.projection);
    projectionBtn.textContent = proj?.name ?? viewState.projection;
    for (const item of projectionDropdown.querySelectorAll("[data-proj-id]")) {
      item.classList.toggle("is-active", item.dataset.projId === viewState.projection);
    }
  }

  function closeDropdown() {
    projectionDropdown.hidden = true;
  }

  function drawBitmapFrame(bitmap) {
    const sceneProps = getSceneProps();
    prepareContext(context, width, height, sceneProps.backgroundFill);
    context.drawImage(bitmap, 0, 0, width, height);
  }

  function getCurrentFlatFrameKey() {
    return JSON.stringify({
      projection: viewState.projection,
      width,
      height,
      pixelRatio,
      sceneRevision: sceneModel.getRevision(),
      camera: normalizeProjectionCamera(viewState.projection, viewState.naturalEarthCamera),
      interactionActive: interactionState.active,
    });
  }

  function ensureFlatWorker() {
    if (!workerState.enabled || workerState.instance) {
      return workerState.instance;
    }
    workerState.instance = new Worker(
      new URL("./print/worker/flat-render-worker.js", import.meta.url),
      { type: "module" },
    );
    workerState.instance.onmessage = (event) => {
      const {
        type,
        bitmap,
        projection,
        width: frameWidth,
        height: frameHeight,
        frameRequestKey,
      } = event.data ?? {};
      if (type !== PRINT_WORKER_MESSAGE.FRAME) {
        return;
      }
      if (projection !== viewState.projection || !isFlatProjection(viewState.projection)) {
        bitmap?.close?.();
        return;
      }
      if (!frameRequestKey || frameRequestKey !== workerState.currentRequestKey) {
        bitmap?.close?.();
        return;
      }
      workerState.latestBitmap?.close?.();
      workerState.latestBitmap = bitmap;
      workerState.latestFrameKey = frameRequestKey;
      if (interactionState.active) {
        return;
      }
      if (workerState.awaitingSettledFrame && frameRequestKey === workerState.currentRequestKey) {
        workerState.awaitingSettledFrame = false;
      }
      if (width && height) {
        drawBitmapFrame(bitmap);
      }
    };
    return workerState.instance;
  }

  function postWorkerSceneIfNeeded(worker) {
    const revision = sceneModel.getRevision();
    if (revision === workerSceneRevisionSent) {
      return false;
    }
    worker.postMessage({
      type: PRINT_WORKER_MESSAGE.SET_SCENE,
      scene: getSceneProps(),
      sceneRevision: revision,
    });
    workerSceneRevisionSent = revision;
    return true;
  }

  function requestFlatWorkerFrame() {
    const worker = ensureFlatWorker();
    if (!worker || !width || !height) {
      return false;
    }
    const frameRequestKey = `${++workerFrameRequestCounter}:${getCurrentFlatFrameKey()}`;
    workerState.currentRequestKey = frameRequestKey;
    const sceneDirty = postWorkerSceneIfNeeded(worker);
    worker.postMessage({
      type: PRINT_WORKER_MESSAGE.SET_VIEW,
      width,
      height,
      pixelRatio,
      projection: viewState.projection,
      camera: viewState.naturalEarthCamera,
      sceneDirty,
      frameRequestKey,
    });
    worker.postMessage({
      type: PRINT_WORKER_MESSAGE.SET_INTERACTION,
      active: interactionState.active,
    });
    worker.postMessage({
      type: PRINT_WORKER_MESSAGE.RENDER,
      passes: sceneDirty ? "all" : "frame",
    });
    return true;
  }

  function getActiveLandGeometry() {
    const sceneProps = getSceneProps();
    if (interactionState.active) {
      return sceneProps.interactionLand ?? sceneProps.land;
    }
    return sceneProps.land;
  }

  function rebuildStylePreviewPass(pass) {
    const previewSceneProps = getStylePreviewSceneProps();
    const previewContext = ensureStylePreviewSurface(pass);
    prepareContext(previewContext, width, height, "rgba(0, 0, 0, 0)");
    const projectionAdapter = createProjectionAdapter({
      projectionType: viewState.projection,
      width,
      height,
      camera: isFlatProjection(viewState.projection) ? viewState.naturalEarthCamera : viewState.printCamera,
      state: projectionAdapterState,
      renderQuality: "settled",
    });
    drawProjectedScene(
      previewContext,
      projectionAdapter,
      previewSceneProps,
      preparedDynamicCommands,
      {
        land: previewSceneProps.land,
        graticules: previewSceneProps.graticules,
        applyViewportTransform: true,
        includeEarth: pass === "earth",
        includeDynamicShapes: pass === "dynamic-shapes",
        includePoints: pass === "points",
      },
    );
  }

  function renderStylePreview() {
    const previewSceneProps = getStylePreviewSceneProps();
    const dirty = stylePreviewInvalidation.consume();
    if (dirty.has("dynamic-shapes") || dirty.has("points")) {
      ensurePreparedDynamicCommands();
    }
    if (dirty.has("earth")) {
      rebuildStylePreviewPass("earth");
    }
    if (dirty.has("dynamic-shapes")) {
      rebuildStylePreviewPass("dynamic-shapes");
    }
    if (dirty.has("points")) {
      rebuildStylePreviewPass("points");
    }
    prepareContext(context, width, height, previewSceneProps.backgroundFill);
    context.drawImage(stylePreviewSurfaces.earth, 0, 0, width, height);
    context.drawImage(stylePreviewSurfaces["dynamic-shapes"], 0, 0, width, height);
    context.drawImage(stylePreviewSurfaces.points, 0, 0, width, height);
  }

  function renderOrthographic() {
    const sceneProps = getSceneProps();
    if (!interactionState.active) {
      ensurePreparedDynamicCommands();
    }
    prepareContext(context, width, height, sceneProps.backgroundFill);
    const projectionAdapter = createProjectionAdapter({
      projectionType: viewState.projection,
      width,
      height,
      camera: viewState.printCamera,
      state: projectionAdapterState,
      renderQuality: interactionState.active ? "interactive" : "settled",
    });
    drawProjectedScene(
      context,
      projectionAdapter,
      sceneProps,
      preparedDynamicCommands,
      {
        land: getActiveLandGeometry(),
        graticules: sceneProps.graticules,
        applyViewportTransform: true,
        includeDynamicShapes: !interactionState.active,
        includePoints: !interactionState.active,
      },
    );
  }

  function renderFlat() {
    const sceneProps = getSceneProps();
    if (interactionState.active) {
      prepareContext(context, width, height, sceneProps.backgroundFill);
      const projectionAdapter = createProjectionAdapter({
        projectionType: viewState.projection,
        width,
        height,
        camera: viewState.naturalEarthCamera,
        state: projectionAdapterState,
        renderQuality: "interactive",
      });
      drawProjectedScene(
        context,
        projectionAdapter,
        sceneProps,
        preparedDynamicCommands,
        {
          land: sceneProps.interactionLand ?? sceneProps.land,
          graticules: sceneProps.graticules,
          applyViewportTransform: true,
          includeDynamicShapes: false,
          includePoints: false,
        },
      );
      return;
    }

    if (stylePreviewState.active) {
      ensurePreparedDynamicCommands();
      prepareContext(context, width, height, sceneProps.backgroundFill);
      const projectionAdapter = createProjectionAdapter({
        projectionType: viewState.projection,
        width,
        height,
        camera: viewState.naturalEarthCamera,
        state: projectionAdapterState,
        renderQuality: "settled",
      });
      drawProjectedScene(
        context,
        projectionAdapter,
        sceneProps,
        preparedDynamicCommands,
        {
          land: sceneProps.land,
          graticules: sceneProps.graticules,
          applyViewportTransform: true,
          includeEarth: true,
          includeDynamicShapes: true,
          includePoints: true,
        },
      );
      return;
    }

    prepareContext(context, width, height, sceneProps.backgroundFill);
    if (requestFlatWorkerFrame()
      && !workerState.awaitingSettledFrame
      && workerState.latestBitmap
      && workerState.latestFrameKey === workerState.currentRequestKey) {
      drawBitmapFrame(workerState.latestBitmap);
      return;
    }
    ensurePreparedDynamicCommands();
    const projectionAdapter = createProjectionAdapter({
      projectionType: viewState.projection,
      width,
      height,
      camera: viewState.naturalEarthCamera,
      state: projectionAdapterState,
      renderQuality: "settled",
    });
    drawProjectedScene(
      context,
      projectionAdapter,
      sceneProps,
      preparedDynamicCommands,
      {
        land: sceneProps.land,
        graticules: sceneProps.graticules,
        applyViewportTransform: true,
      },
    );
  }

  function render() {
    const nextWidth = mount.clientWidth;
    const nextHeight = mount.clientHeight;
    if (!nextWidth || !nextHeight || !context) {
      return;
    }
    syncCanvasSize(nextWidth, nextHeight);
    mount.style.backgroundColor = stylePreviewState.active
      ? getStylePreviewSceneProps().backgroundFill
      : getSceneProps().backgroundFill;
    if (stylePreviewState.active) {
      renderStylePreview();
      invalidation.consume();
      return;
    }
    if (isFlatProjection(viewState.projection)) {
      renderFlat();
      invalidation.consume();
      return;
    }
    renderOrthographic();
    invalidation.consume();
  }

  function requestRender() {
    if (frameHandle) {
      return;
    }
    frameHandle = window.requestAnimationFrame(() => {
      frameHandle = 0;
      render();
    });
  }

  let dropdownCloseListener = null;
  projectionBtn.addEventListener("click", () => {
    if (!projectionDropdown.hidden) {
      closeDropdown();
      if (dropdownCloseListener) {
        document.removeEventListener("pointerdown", dropdownCloseListener, true);
        dropdownCloseListener = null;
      }
      return;
    }
    projectionDropdown.hidden = false;
    dropdownCloseListener = (event) => {
      if (!projectionDropdown.contains(event.target) && event.target !== projectionBtn) {
        closeDropdown();
        document.removeEventListener("pointerdown", dropdownCloseListener, true);
        dropdownCloseListener = null;
      }
    };
    document.addEventListener("pointerdown", dropdownCloseListener, true);
  });

  projectionDropdown.addEventListener("click", (event) => {
    const item = event.target.closest("[data-proj-id]");
    if (!item || item.dataset.projId === viewState.projection) {
      return;
    }
    closeDropdown();
    viewState = { ...viewState, projection: item.dataset.projId };
    invalidation.invalidate(["scene", "camera", "frame"]);
    updateProjectionBtn();
    requestRender();
    onProjectionChange?.(item.dataset.projId);
  });

  createGestureController(canvas, {
    getCamera,
    onCamera: applyCamera,
    sensitivity: ORTHOGRAPHIC_DRAG_SENSITIVITY,
    getMode: () => getProjectionGestureMode(viewState.projection),
    onInteractionStart() {
      interactionState.active = true;
      workerState.awaitingSettledFrame = false;
      invalidation.invalidate("frame");
      requestRender();
    },
    onInteractionEnd() {
      interactionState.active = false;
      workerState.awaitingSettledFrame = true;
      commitCameraIfNeeded();
      invalidation.invalidate("frame");
      requestRender();
    },
  });

  const resizeObserver = new ResizeObserver(() => {
    invalidation.invalidate(["scene", "camera", "frame"]);
    requestRender();
  });
  resizeObserver.observe(mount);

  updateProjectionBtn();

  return {
    previewStylePatch({ passes = [], sceneOverrides = null } = {}) {
      stylePreviewState.active = true;
      stylePreviewState.overrides = sceneOverrides;
      if (!stylePreviewState.initialized) {
        stylePreviewState.initialized = true;
        stylePreviewInvalidation.invalidate("all");
      } else if (passes.length) {
        stylePreviewInvalidation.invalidate(passes);
      }
      invalidation.invalidate("frame");
      requestRender();
    },
    setProps(nextProps) {
      stylePreviewState.active = false;
      stylePreviewState.initialized = false;
      stylePreviewState.overrides = null;
      stylePreviewInvalidation.invalidate("all");
      const sceneChanged = sceneModel.update({
        backgroundFill: nextProps?.backgroundFill ?? getSceneProps().backgroundFill,
        oceanFill: nextProps?.oceanFill ?? getSceneProps().oceanFill,
        landFill: nextProps?.landFill ?? getSceneProps().landFill,
        landLine: nextProps?.landLine ?? getSceneProps().landLine,
        graticulesLine: nextProps?.graticulesLine ?? getSceneProps().graticulesLine,
        land: nextProps?.land ?? getSceneProps().land,
        interactionLand: nextProps?.interactionLand ?? getSceneProps().interactionLand,
        graticules: nextProps?.graticules ?? getSceneProps().graticules,
        dynamicLayers: nextProps?.dynamicLayers ?? getSceneProps().dynamicLayers,
        dynamicLayersRevision: nextProps?.dynamicLayersRevision ?? getSceneProps().dynamicLayersRevision,
        dynamicLayerData: nextProps?.dynamicLayerData ?? getSceneProps().dynamicLayerData,
        dynamicLayerDataRevision: nextProps?.dynamicLayerDataRevision ?? getSceneProps().dynamicLayerDataRevision,
        earthRenderOrder: nextProps?.earthRenderOrder ?? getSceneProps().earthRenderOrder,
      });
      viewState = {
        ...viewState,
        projection: nextProps?.projection ?? viewState.projection,
        printCamera: normalizeProjectionCamera("orthographic", nextProps?.printCamera ?? viewState.printCamera),
        naturalEarthCamera: normalizeProjectionCamera("naturalEarth", nextProps?.naturalEarthCamera ?? viewState.naturalEarthCamera),
      };
      if (sceneChanged) {
        preparedDynamicKey = "";
        invalidation.invalidate(["scene", "frame"]);
      } else {
        invalidation.invalidate("frame");
      }
      updateProjectionBtn();
      requestRender();
    },
    destroy() {
      resizeObserver.disconnect();
      workerState.instance?.postMessage({ type: PRINT_WORKER_MESSAGE.DISPOSE });
      workerState.instance?.terminate?.();
      workerState.latestBitmap?.close?.();
      if (frameHandle) {
        window.cancelAnimationFrame(frameHandle);
        frameHandle = 0;
      }
      mount.replaceChildren();
    },
  };
}
