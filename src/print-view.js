import { geoPath } from "d3-geo";
import { createGestureController } from "./print/gesture-controller.js";
import { buildDynamicDrawCommands } from "./print/dynamic-commands.js";
import {
  createProjectionAdapter,
  createProjectionAdapterState,
  getProjectionGestureMode,
  getProjectionPanCamera,
  getProjectionPanZoomCamera,
  getProjectionRenderMode,
  getProjectionDragCamera,
  getProjectionZoomCamera,
  getProjectionViewportTransform,
  isFlatProjection,
  normalizeProjectionCamera,
  ORTHOGRAPHIC_DRAG_SENSITIVITY,
  PROJECTIONS,
  transferProjectionCamera,
} from "./print/projection-adapters.js";
import { createPerfTracker, shouldEnablePrintPerf } from "./print/perf-metrics.js";
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
  onProjectionChange = null,
  onProjectionLockChange = null,
  onProjectionReset = null,
  onTitleChange = null,
  onUndo = null,
}) {
  const PRINT_PREVIEW_INSET = 12;
  const PRINT_PREVIEW_RATIO = Math.sqrt(2);
  const PRINT_PREVIEW_MASK_FILL = "rgba(120, 120, 120, 0.34)";
  const PRINT_PREVIEW_BORDER = "rgba(0, 0, 0, 0.45)";
  const PRINT_ALIGNMENT_THRESHOLD_PX = 0.75;
  const PRINT_SNAP_CAPTURE_THRESHOLD_PX = 1;
  const PRINT_ALIGNMENT_CENTER_COLOR = "rgba(220, 32, 32, 0.95)";
  const PRINT_ALIGNMENT_EDGE_COLOR = "rgba(32, 170, 80, 0.95)";
  const DEFAULT_PRINT_TITLE = {
    text: "",
    x: 0.04,
    y: 0.04,
    width: 0.92,
    fontFamily: "Georgia, 'Times New Roman', serif",
    fontSize: 0.035,
    fontWeight: 700,
    lineHeight: 1.2,
    color: "#000000",
  };
  const PRINT_TITLE_FONT_OPTIONS = [
    { value: "Georgia, 'Times New Roman', serif", label: "Georgia" },
    { value: "'Helvetica Neue', Arial, sans-serif", label: "Helvetica" },
    { value: "'Courier New', monospace", label: "Courier" },
  ];

  const container = document.createElement("div");
  container.style.cssText = "position:relative;width:100%;height:100%;overflow:hidden;";

  const canvas = document.createElement("canvas");
  canvas.style.cssText = "width:100%;height:100%;display:block;touch-action:none;";

  const titleLayer = document.createElement("div");
  titleLayer.className = "earthlab-print-title-layer";
  titleLayer.hidden = true;

  const titleToolbar = document.createElement("div");
  titleToolbar.className = "earthlab-print-title-toolbar";
  titleToolbar.hidden = true;

  const titleFontSelect = document.createElement("select");
  titleFontSelect.className = "earthlab-print-title-select";
  for (const optionDef of PRINT_TITLE_FONT_OPTIONS) {
    const option = document.createElement("option");
    option.value = optionDef.value;
    option.textContent = optionDef.label;
    titleFontSelect.append(option);
  }

  const titleSizeInput = document.createElement("input");
  titleSizeInput.className = "earthlab-print-title-size";
  titleSizeInput.type = "range";
  titleSizeInput.min = "18";
  titleSizeInput.max = "64";
  titleSizeInput.step = "1";

  const titleMoveHandle = document.createElement("button");
  titleMoveHandle.type = "button";
  titleMoveHandle.className = "earthlab-print-title-move";
  titleMoveHandle.textContent = "Move";

  titleToolbar.append(titleFontSelect, titleSizeInput, titleMoveHandle);

  const titleShell = document.createElement("div");
  titleShell.className = "earthlab-print-title-shell";

  const titleEditorWrap = document.createElement("div");
  titleEditorWrap.className = "earthlab-print-title-wrap";

  const titleEditor = document.createElement("div");
  titleEditor.className = "earthlab-print-title-editor";
  titleEditor.contentEditable = "true";
  titleEditor.spellcheck = false;
  titleEditor.setAttribute("enterkeyhint", "done");
  titleEditor.setAttribute("role", "textbox");
  titleEditor.setAttribute("aria-label", "Print title");

  const titleClearBtn = document.createElement("button");
  titleClearBtn.type = "button";
  titleClearBtn.className = "earthlab-print-title-clear";
  titleClearBtn.textContent = "×";

  titleEditorWrap.append(titleEditor, titleClearBtn);
  titleShell.append(titleEditorWrap);
  titleLayer.append(titleToolbar, titleShell);

  const projectionBtn = document.createElement("button");
  projectionBtn.type = "button";
  projectionBtn.className = "earthlab-projection-btn";

  const lockBtn = document.createElement("button");
  lockBtn.type = "button";
  lockBtn.className = "earthlab-projection-btn";
  lockBtn.classList.add("earthlab-lock-btn");

  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "earthlab-projection-btn";
  resetBtn.classList.add("earthlab-reset-btn");
  resetBtn.textContent = "Reset";

  const projectionControls = document.createElement("div");
  projectionControls.className = "earthlab-projection-controls";
  projectionControls.append(lockBtn, resetBtn);

  const undoBtn = document.createElement("button");
  undoBtn.type = "button";
  undoBtn.className = "earthlab-projection-btn";
  undoBtn.textContent = "Undo";
  undoBtn.style.top = "0";
  undoBtn.style.bottom = "auto";
  undoBtn.style.right = "0";

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

  const debugPanel = document.createElement("details");
  debugPanel.className = "earthlab-debug-panel";
  const debugSummary = document.createElement("summary");
  debugSummary.textContent = "Debug";
  const debugPre = document.createElement("pre");
  debugPre.className = "earthlab-debug-pre";
  debugPanel.append(debugSummary, debugPre);

  container.append(canvas, titleLayer, projectionDropdown, projectionBtn, projectionControls, undoBtn, debugPanel);
  mount.replaceChildren(container);

  const context = canvas.getContext("2d");
  const sceneModel = createPrintSceneModel();
  const invalidation = createRenderInvalidation(["scene", "camera", "frame"]);
  const projectionAdapterState = createProjectionAdapterState();
  const perfTracker = createPerfTracker("main", shouldEnablePrintPerf());

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
    activeCamera: normalizeProjectionCamera("orthographic", null, { locked: true }),
    locked: true,
  };
  let printTitle = { ...DEFAULT_PRINT_TITLE };
  let showCanvasTitle = true;
  let canUndo = false;

  const interactionState = {
    active: false,
    pendingCameraCommit: false,
  };
  const titleUiState = {
    selected: false,
    dragging: false,
    dragPointerId: null,
    dragOffsetX: 0,
    dragOffsetY: 0,
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

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function normalizeTitle(nextTitle) {
    return {
      text: typeof nextTitle?.text === "string" ? nextTitle.text : "",
      x: Number.isFinite(Number(nextTitle?.x)) ? clamp(Number(nextTitle.x), 0, 0.9) : DEFAULT_PRINT_TITLE.x,
      y: Number.isFinite(Number(nextTitle?.y)) ? clamp(Number(nextTitle.y), 0, 0.9) : DEFAULT_PRINT_TITLE.y,
      width: Number.isFinite(Number(nextTitle?.width)) ? clamp(Number(nextTitle.width), 0.92, 0.92) : DEFAULT_PRINT_TITLE.width,
      fontFamily: typeof nextTitle?.fontFamily === "string" && nextTitle.fontFamily
        ? nextTitle.fontFamily
        : DEFAULT_PRINT_TITLE.fontFamily,
      fontSize: Number.isFinite(Number(nextTitle?.fontSize)) ? clamp(Number(nextTitle.fontSize), 0.018, 0.12) : DEFAULT_PRINT_TITLE.fontSize,
      fontWeight: Number.isFinite(Number(nextTitle?.fontWeight)) ? clamp(Math.round(Number(nextTitle.fontWeight)), 400, 900) : DEFAULT_PRINT_TITLE.fontWeight,
      lineHeight: Number.isFinite(Number(nextTitle?.lineHeight)) ? clamp(Number(nextTitle.lineHeight), 1, 1.8) : DEFAULT_PRINT_TITLE.lineHeight,
      color: typeof nextTitle?.color === "string" && nextTitle.color ? nextTitle.color : DEFAULT_PRINT_TITLE.color,
    };
  }

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
    return normalizeProjectionCamera(viewState.projection, viewState.activeCamera, { locked: viewState.locked });
  }

  function getCameraCommitCallback() {
    return onCameraChange;
  }

  function commitCameraIfNeeded() {
    if (!interactionState.pendingCameraCommit) {
      return;
    }
    interactionState.pendingCameraCommit = false;
    getCameraCommitCallback()?.(getCamera());
  }

  function applyCamera(nextCamera, { notify = true } = {}) {
    const snappedCamera = viewState.locked
      ? applyPrintPreviewSnap(viewState.projection, nextCamera, true)
      : normalizeProjectionCamera(viewState.projection, nextCamera, { locked: false });
    viewState = {
      ...viewState,
      activeCamera: snappedCamera,
    };
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
    preparedDynamicCommands = perfTracker.time(
      "buildDynamicCommandsMs",
      () => buildDynamicDrawCommands(sceneProps.dynamicLayers, sceneProps.dynamicLayerData),
    );
    preparedDynamicKey = nextKey;
    perfTracker.gauge("preparedDynamicCommands", preparedDynamicCommands.length);
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
    lockBtn.textContent = viewState.locked ? "Unlock" : "Lock";
    for (const item of projectionDropdown.querySelectorAll("[data-proj-id]")) {
      item.classList.toggle("is-active", item.dataset.projId === viewState.projection);
    }
    undoBtn.disabled = !canUndo;
    undoBtn.style.opacity = canUndo ? "1" : "0.45";
    undoBtn.style.cursor = canUndo ? "pointer" : "default";
    positionUndoButton();
    positionProjectionControls();
  }

  function closeDropdown() {
    projectionDropdown.hidden = true;
  }

  function getPrintPreviewFrame() {
    const maxWidth = Math.max(0, width - (PRINT_PREVIEW_INSET * 2));
    const maxHeight = Math.max(0, height - (PRINT_PREVIEW_INSET * 2));
    let frameHeight = maxHeight;
    let frameWidth = frameHeight * PRINT_PREVIEW_RATIO;
    if (frameWidth > maxWidth) {
      frameWidth = maxWidth;
      frameHeight = frameWidth / PRINT_PREVIEW_RATIO;
    }
    const x = (width - frameWidth) / 2;
    const y = (height - frameHeight) / 2;
    return { x, y, width: frameWidth, height: frameHeight };
  }

  function getTitleMetrics(title = printTitle) {
    const frame = getPrintPreviewFrame();
    const normalizedTitle = normalizeTitle(title);
    const x = frame.x + (frame.width * normalizedTitle.x);
    const y = frame.y + (frame.height * normalizedTitle.y);
    const maxWidth = Math.max(96, frame.width * normalizedTitle.width);
    const fontSizePx = Math.max(18, frame.width * normalizedTitle.fontSize);
    const lineHeightPx = fontSizePx * normalizedTitle.lineHeight;
    return {
      frame,
      title: normalizedTitle,
      x,
      y,
      maxWidth,
      fontSizePx,
      lineHeightPx,
    };
  }

  function syncTitleEditorEmptyState() {
    titleEditor.dataset.empty = String(titleEditor.textContent.trim() === "");
  }

  function updateDebugPanel() {
    const frame = getPrintPreviewFrame();
    const metrics = getTitleMetrics(printTitle);
    const shellRect = titleShell.getBoundingClientRect();
    const wrapRect = titleEditorWrap.getBoundingClientRect();
    const editorRect = titleEditor.getBoundingClientRect();
    const clearRect = titleClearBtn.getBoundingClientRect();
    const projectionRect = projectionBtn.getBoundingClientRect();
    const lockRect = lockBtn.getBoundingClientRect();
    const resetRect = resetBtn.getBoundingClientRect();
    debugPre.textContent = [
      `projection=${viewState.projection}`,
      `locked=${viewState.locked}`,
      `selected=${titleUiState.selected}`,
      `canvas=${width}x${height}`,
      `frame x=${frame.x.toFixed(1)} y=${frame.y.toFixed(1)} w=${frame.width.toFixed(1)} h=${frame.height.toFixed(1)}`,
      `title x=${metrics.x.toFixed(1)} y=${metrics.y.toFixed(1)} maxWidth=${metrics.maxWidth.toFixed(1)}`,
      `shell w=${shellRect.width.toFixed(1)} h=${shellRect.height.toFixed(1)}`,
      `wrap w=${wrapRect.width.toFixed(1)} h=${wrapRect.height.toFixed(1)}`,
      `editor w=${editorRect.width.toFixed(1)} h=${editorRect.height.toFixed(1)}`,
      `clear x=${clearRect.x.toFixed(1)} y=${clearRect.y.toFixed(1)} w=${clearRect.width.toFixed(1)} opacity=${getComputedStyle(titleClearBtn).opacity}`,
      `projectionBtn x=${projectionRect.x.toFixed(1)} y=${projectionRect.y.toFixed(1)} w=${projectionRect.width.toFixed(1)}`,
      `lockBtn x=${lockRect.x.toFixed(1)} y=${lockRect.y.toFixed(1)} w=${lockRect.width.toFixed(1)}`,
      `resetBtn x=${resetRect.x.toFixed(1)} y=${resetRect.y.toFixed(1)} w=${resetRect.width.toFixed(1)}`,
      `title text len=${(printTitle.text ?? "").length}`,
      `titleEditor text="${(titleEditor.textContent ?? "").replace(/\n/g, "\\n")}"`,
      `camera=${JSON.stringify(getCamera())}`,
    ].join("\n");
  }

  function emitTitleChange(nextTitle, { commit = false } = {}) {
    printTitle = normalizeTitle(nextTitle);
    syncTitleOverlay();
    updateDebugPanel();
    requestRender();
    onTitleChange?.(printTitle, { commit });
  }

  function updateToolbarVisibility() {
    titleToolbar.hidden = !titleUiState.selected;
    titleShell.classList.toggle("is-selected", titleUiState.selected);
  }

  function syncTitleOverlay() {
    const titleInsetX = 6;
    const titleInsetY = 4;
    const metrics = getTitleMetrics(printTitle);
    const nextText = printTitle.text;
    if (titleEditor.textContent !== nextText) {
      titleEditor.textContent = nextText;
    }
    syncTitleEditorEmptyState();
    titleEditor.style.fontFamily = metrics.title.fontFamily;
    titleEditor.style.fontSize = `${metrics.fontSizePx}px`;
    titleEditor.style.fontWeight = String(metrics.title.fontWeight);
    titleEditor.style.lineHeight = `${metrics.lineHeightPx}px`;
    titleEditor.style.color = metrics.title.color;
    titleShell.style.left = `${metrics.x}px`;
    titleShell.style.top = `${metrics.y}px`;
    titleShell.style.width = `${metrics.maxWidth}px`;
    titleEditorWrap.style.paddingTop = `${titleInsetY}px`;
    titleEditorWrap.style.paddingBottom = `${titleInsetY}px`;
    titleEditorWrap.style.paddingLeft = `${titleInsetX}px`;
    titleEditorWrap.style.paddingRight = `${titleInsetX}px`;
    titleToolbar.style.left = `${metrics.frame.x}px`;
    titleToolbar.style.top = `${Math.max(8, metrics.frame.y - 42)}px`;
    titleFontSelect.value = metrics.title.fontFamily;
    titleSizeInput.value = String(Math.round(metrics.fontSizePx));
    updateToolbarVisibility();
    updateDebugPanel();
  }

  function positionUndoButton() {
    const frame = getPrintPreviewFrame();
    const gutterRight = Math.max(0, width - (frame.x + frame.width));
    undoBtn.style.top = `${Math.max(8, frame.y - 34)}px`;
    undoBtn.style.right = `${gutterRight}px`;
  }

  function positionProjectionControls() {
    const frame = getPrintPreviewFrame();
    const top = frame.y + frame.height + 6;
    const right = Math.max(0, width - (frame.x + frame.width));
    projectionControls.style.top = `${top}px`;
    projectionControls.style.right = `${right}px`;
  }

  function getProjectedSphereBoundsFor(projectionType, camera, locked = viewState.locked, renderQuality = "settled") {
    const projectionAdapter = createProjectionAdapter({
      projectionType,
      width,
      height,
      camera,
      locked,
      state: projectionAdapterState,
      perfTracker,
      renderQuality,
    });
    const bounds = geoPath(projectionAdapter.projection).bounds({ type: "Sphere" });
    const [[x0, y0], [x1, y1]] = bounds;
    if (![x0, y0, x1, y1].every(Number.isFinite)) {
      return null;
    }
    if (!locked) {
      return { x0, y0, x1, y1 };
    }
    const transform = getProjectionViewportTransform(
      projectionType,
      width,
      height,
      normalizeProjectionCamera(projectionType, camera, { locked }),
      { locked },
    );
    if (!transform) {
      return { x0, y0, x1, y1 };
    }
    return {
      x0: (x0 * transform.zoom) + transform.tx,
      y0: (y0 * transform.zoom) + transform.ty,
      x1: (x1 * transform.zoom) + transform.tx,
      y1: (y1 * transform.zoom) + transform.ty,
    };
  }

  function getPrintPreviewAlignment(projectionAdapter) {
    const frame = getPrintPreviewFrame();
    if (!viewState.locked) {
      return {
        frame,
        centerX: false,
        centerY: false,
        left: false,
        right: false,
        top: false,
        bottom: false,
      };
    }
    const bounds = getProjectedSphereBoundsFor(
      viewState.projection,
      viewState.activeCamera,
      viewState.locked,
    );
    if (!bounds) {
      return {
        frame,
        centerX: false,
        centerY: false,
        left: false,
        right: false,
        top: false,
        bottom: false,
      };
    }

    const frameCenterX = frame.x + (frame.width / 2);
    const frameCenterY = frame.y + (frame.height / 2);
    const boundsCenterX = (bounds.x0 + bounds.x1) / 2;
    const boundsCenterY = (bounds.y0 + bounds.y1) / 2;

    return {
      frame,
      centerX: Math.abs(boundsCenterX - frameCenterX) <= PRINT_ALIGNMENT_THRESHOLD_PX,
      centerY: Math.abs(boundsCenterY - frameCenterY) <= PRINT_ALIGNMENT_THRESHOLD_PX,
      left: Math.abs(bounds.x0 - frame.x) <= PRINT_ALIGNMENT_THRESHOLD_PX,
      right: Math.abs(bounds.x1 - (frame.x + frame.width)) <= PRINT_ALIGNMENT_THRESHOLD_PX,
      top: Math.abs(bounds.y0 - frame.y) <= PRINT_ALIGNMENT_THRESHOLD_PX,
      bottom: Math.abs(bounds.y1 - (frame.y + frame.height)) <= PRINT_ALIGNMENT_THRESHOLD_PX,
    };
  }

  function getAxisSnapTarget(candidates) {
    let best = null;
    for (const candidate of candidates) {
      if (Math.abs(candidate.delta) > PRINT_SNAP_CAPTURE_THRESHOLD_PX) continue;
      if (!best || Math.abs(candidate.delta) < Math.abs(best.delta)) {
        best = candidate;
      }
    }
    return best;
  }

  function applyPrintPreviewSnap(projectionType, camera, locked = viewState.locked) {
    if (!width || !height) {
      return normalizeProjectionCamera(projectionType, camera, { locked });
    }

    const normalizedCamera = normalizeProjectionCamera(projectionType, camera, { locked });
    const bounds = getProjectedSphereBoundsFor(projectionType, normalizedCamera, locked, "interactive");
    if (!bounds) {
      return normalizedCamera;
    }

    const frame = getPrintPreviewFrame();
    const frameCenterX = frame.x + (frame.width / 2);
    const frameCenterY = frame.y + (frame.height / 2);
    const boundsCenterX = (bounds.x0 + bounds.x1) / 2;
    const boundsCenterY = (bounds.y0 + bounds.y1) / 2;

    if (locked) {
      const nextCamera = { ...normalizedCamera };
      const snapX = getAxisSnapTarget([
        { delta: frameCenterX - boundsCenterX },
        { delta: frame.x - bounds.x0 },
        { delta: (frame.x + frame.width) - bounds.x1 },
      ]);
      const snapY = getAxisSnapTarget([
        { delta: frameCenterY - boundsCenterY },
        { delta: frame.y - bounds.y0 },
        { delta: (frame.y + frame.height) - bounds.y1 },
      ]);
      if (snapX) {
        nextCamera.panX += snapX.delta / width;
      }
      if (snapY) {
        nextCamera.panY += snapY.delta / height;
      }
      return normalizeProjectionCamera(projectionType, nextCamera, { locked: true });
    }

    if (isFlatProjection(projectionType)) {
      return normalizedCamera;
    }

    const radiusX = (bounds.x1 - bounds.x0) / 2;
    const radiusY = (bounds.y1 - bounds.y0) / 2;
    const snapX = getAxisSnapTarget([
      { delta: frame.x - bounds.x0, targetRadius: width / 2 - frame.x },
      { delta: (frame.x + frame.width) - bounds.x1, targetRadius: frame.x + frame.width - width / 2 },
    ]);
    const snapY = getAxisSnapTarget([
      { delta: frame.y - bounds.y0, targetRadius: height / 2 - frame.y },
      { delta: (frame.y + frame.height) - bounds.y1, targetRadius: frame.y + frame.height - height / 2 },
    ]);

    if (!snapX && !snapY) {
      return normalizedCamera;
    }

    let zoomScale = normalizedCamera.zoomScale;
    if (snapX?.targetRadius && radiusX > 0) {
      zoomScale *= snapX.targetRadius / radiusX;
    } else if (snapY?.targetRadius && radiusY > 0) {
      zoomScale *= snapY.targetRadius / radiusY;
    }

    return normalizeProjectionCamera(projectionType, { ...normalizedCamera, zoomScale }, { locked: false });
  }

  function drawPrintPreviewOverlay(ctx, projectionAdapter = null) {
    if (!width || !height) return;
    const alignment = projectionAdapter ? getPrintPreviewAlignment(projectionAdapter) : null;
    const frame = alignment?.frame ?? getPrintPreviewFrame();
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, width, height);
    ctx.rect(frame.x, frame.y, frame.width, frame.height);
    ctx.fillStyle = PRINT_PREVIEW_MASK_FILL;
    ctx.fill("evenodd");
    ctx.beginPath();
    ctx.rect(frame.x + 0.5, frame.y + 0.5, Math.max(0, frame.width - 1), Math.max(0, frame.height - 1));
    ctx.strokeStyle = PRINT_PREVIEW_BORDER;
    ctx.lineWidth = 1;
    ctx.stroke();

    if (showCanvasTitle && printTitle.text.trim()) {
      const titleInsetX = 6;
      const metrics = getTitleMetrics(printTitle);
      ctx.font = `${metrics.title.fontWeight} ${metrics.fontSizePx}px ${metrics.title.fontFamily}`;
      const wrapWidth = Math.max(1, metrics.maxWidth - (titleInsetX * 2));
      const words = printTitle.text.split(/\s+/).filter(Boolean);
      const lines = [];
      let currentLine = "";
      for (const word of words) {
        const nextLine = currentLine ? `${currentLine} ${word}` : word;
        if (!currentLine || ctx.measureText(nextLine).width <= wrapWidth) {
          currentLine = nextLine;
          continue;
        }
        lines.push(currentLine);
        currentLine = word;
      }
      if (currentLine) {
        lines.push(currentLine);
      }
      if (!lines.length && printTitle.text.trim()) {
        lines.push(printTitle.text.trim());
      }

      ctx.fillStyle = metrics.title.color;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      lines.forEach((line, index) => {
        ctx.fillText(
          line,
          metrics.x + titleInsetX,
          metrics.y + (index * metrics.lineHeightPx),
          wrapWidth,
        );
      });
    }

    if (interactionState.active && alignment?.centerX) {
      const x = frame.x + (frame.width / 2);
      ctx.beginPath();
      ctx.moveTo(x, frame.y);
      ctx.lineTo(x, frame.y + frame.height);
      ctx.strokeStyle = PRINT_ALIGNMENT_CENTER_COLOR;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    if (interactionState.active && alignment?.centerY) {
      const y = frame.y + (frame.height / 2);
      ctx.beginPath();
      ctx.moveTo(frame.x, y);
      ctx.lineTo(frame.x + frame.width, y);
      ctx.strokeStyle = PRINT_ALIGNMENT_CENTER_COLOR;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    if (interactionState.active && alignment?.left) {
      ctx.beginPath();
      ctx.moveTo(frame.x, frame.y);
      ctx.lineTo(frame.x, frame.y + frame.height);
      ctx.strokeStyle = PRINT_ALIGNMENT_EDGE_COLOR;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    if (interactionState.active && alignment?.right) {
      const x = frame.x + frame.width;
      ctx.beginPath();
      ctx.moveTo(x, frame.y);
      ctx.lineTo(x, frame.y + frame.height);
      ctx.strokeStyle = PRINT_ALIGNMENT_EDGE_COLOR;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    if (interactionState.active && alignment?.top) {
      ctx.beginPath();
      ctx.moveTo(frame.x, frame.y);
      ctx.lineTo(frame.x + frame.width, frame.y);
      ctx.strokeStyle = PRINT_ALIGNMENT_EDGE_COLOR;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    if (interactionState.active && alignment?.bottom) {
      const y = frame.y + frame.height;
      ctx.beginPath();
      ctx.moveTo(frame.x, y);
      ctx.lineTo(frame.x + frame.width, y);
      ctx.strokeStyle = PRINT_ALIGNMENT_EDGE_COLOR;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawBitmapFrame(bitmap) {
    const sceneProps = getSceneProps();
    prepareContext(context, width, height, sceneProps.backgroundFill);
    context.drawImage(bitmap, 0, 0, width, height);
    const projectionAdapter = createProjectionAdapter({
      projectionType: viewState.projection,
      width,
      height,
      camera: viewState.activeCamera,
      locked: viewState.locked,
      state: projectionAdapterState,
      perfTracker,
      renderQuality: "settled",
    });
    drawPrintPreviewOverlay(context, projectionAdapter);
  }

  function getCurrentFlatFrameKey() {
    return JSON.stringify({
      projection: viewState.projection,
      width,
      height,
      pixelRatio,
      sceneRevision: sceneModel.getRevision(),
      camera: normalizeProjectionCamera(viewState.projection, viewState.activeCamera, { locked: viewState.locked }),
      locked: viewState.locked,
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
        perf,
      } = event.data ?? {};
      if (type !== PRINT_WORKER_MESSAGE.FRAME) {
        return;
      }
      if (projection !== viewState.projection || getProjectionRenderMode(viewState.projection) !== "worker") {
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
      if (perf) {
        globalThis.__earthlabPrintPerfLatest = {
          ...(globalThis.__earthlabPrintPerfLatest ?? {}),
          worker: perf,
        };
      }
    };
    workerState.instance.postMessage({
      type: PRINT_WORKER_MESSAGE.INIT,
      width,
      height,
      pixelRatio,
      perfEnabled: perfTracker.enabled,
    });
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
      camera: viewState.activeCamera,
      locked: viewState.locked,
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
      camera: viewState.activeCamera,
      locked: viewState.locked,
      state: projectionAdapterState,
      perfTracker,
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
        perfTracker,
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
    const projectionAdapter = createProjectionAdapter({
      projectionType: viewState.projection,
      width,
      height,
      camera: viewState.activeCamera,
      locked: viewState.locked,
      state: projectionAdapterState,
      perfTracker,
      renderQuality: "settled",
    });
    drawPrintPreviewOverlay(context, projectionAdapter);
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
      camera: viewState.activeCamera,
      locked: viewState.locked,
      state: projectionAdapterState,
      perfTracker,
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
        includeDynamicShapes: true,
        includePoints: true,
        perfTracker,
      },
    );
    drawPrintPreviewOverlay(context, projectionAdapter);
  }

  function renderFlat() {
    const sceneProps = getSceneProps();
    if (interactionState.active) {
      prepareContext(context, width, height, sceneProps.backgroundFill);
      const projectionAdapter = createProjectionAdapter({
        projectionType: viewState.projection,
        width,
        height,
        camera: viewState.activeCamera,
        locked: viewState.locked,
        state: projectionAdapterState,
        perfTracker,
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
          includeDynamicShapes: true,
          includePoints: true,
          perfTracker,
        },
      );
      drawPrintPreviewOverlay(context, projectionAdapter);
      return;
    }

    if (stylePreviewState.active) {
      ensurePreparedDynamicCommands();
      prepareContext(context, width, height, sceneProps.backgroundFill);
      const projectionAdapter = createProjectionAdapter({
        projectionType: viewState.projection,
        width,
        height,
        camera: viewState.activeCamera,
        locked: viewState.locked,
        state: projectionAdapterState,
        perfTracker,
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
          perfTracker,
        },
      );
      drawPrintPreviewOverlay(context, projectionAdapter);
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
      camera: viewState.activeCamera,
      locked: viewState.locked,
      state: projectionAdapterState,
      perfTracker,
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
        perfTracker,
      },
    );
    drawPrintPreviewOverlay(context, projectionAdapter);
  }

  function render() {
    const started = performance.now();
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
      updateDebugPanel();
      perfTracker.recordDuration("renderFrameMs", performance.now() - started);
      perfTracker.publish();
      return;
    }
    if (getProjectionRenderMode(viewState.projection) === "worker") {
      renderFlat();
      invalidation.consume();
      updateDebugPanel();
      perfTracker.recordDuration("renderFrameMs", performance.now() - started);
      perfTracker.publish();
      return;
    }
    renderOrthographic();
    invalidation.consume();
    updateDebugPanel();
    perfTracker.recordDuration("renderFrameMs", performance.now() - started);
    perfTracker.publish();
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
  titleShell.addEventListener("pointerdown", (event) => {
    if (event.target === titleShell || event.target === titleEditorWrap) {
      event.preventDefault();
      titleEditor.focus();
    }
  });

  titleEditor.addEventListener("focus", () => {
    titleUiState.selected = true;
    syncTitleOverlay();
  });

  titleEditor.addEventListener("blur", (event) => {
    if (event.relatedTarget === titleClearBtn || event.relatedTarget === titleMoveHandle || event.relatedTarget === titleFontSelect || event.relatedTarget === titleSizeInput) {
      return;
    }
    titleUiState.selected = false;
    emitTitleChange({ ...printTitle, text: titleEditor.textContent ?? "" }, { commit: true });
  });

  titleEditor.addEventListener("input", () => {
    syncTitleEditorEmptyState();
    emitTitleChange({ ...printTitle, text: titleEditor.textContent ?? "" });
  });

  titleEditor.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      titleEditor.blur();
    }
  });

  titleClearBtn.addEventListener("mousedown", (event) => event.preventDefault());
  titleClearBtn.addEventListener("click", () => {
    emitTitleChange({ ...printTitle, text: "" }, { commit: true });
    titleEditor.focus();
  });

  titleFontSelect.addEventListener("input", () => {
    titleUiState.selected = true;
    emitTitleChange({ ...printTitle, fontFamily: titleFontSelect.value }, { commit: true });
  });

  titleSizeInput.addEventListener("input", () => {
    titleUiState.selected = true;
    const frame = getPrintPreviewFrame();
    const fontSizePx = Number(titleSizeInput.value);
    const fontSize = frame.width > 0 ? fontSizePx / frame.width : printTitle.fontSize;
    emitTitleChange({ ...printTitle, fontSize }, { commit: false });
  });

  titleSizeInput.addEventListener("change", () => {
    const frame = getPrintPreviewFrame();
    const fontSizePx = Number(titleSizeInput.value);
    const fontSize = frame.width > 0 ? fontSizePx / frame.width : printTitle.fontSize;
    emitTitleChange({ ...printTitle, fontSize }, { commit: true });
  });

  titleMoveHandle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    titleUiState.selected = true;
    titleUiState.dragging = true;
    titleUiState.dragPointerId = event.pointerId;
    const metrics = getTitleMetrics(printTitle);
    titleUiState.dragOffsetX = event.clientX - metrics.x;
    titleUiState.dragOffsetY = event.clientY - metrics.y;
    titleMoveHandle.setPointerCapture?.(event.pointerId);
    titleShell.classList.add("is-dragging");
    syncTitleOverlay();
  });

  titleMoveHandle.addEventListener("pointermove", (event) => {
    if (!titleUiState.dragging || event.pointerId !== titleUiState.dragPointerId) {
      return;
    }
    event.preventDefault();
    const frame = getPrintPreviewFrame();
    const shellWidth = titleShell.offsetWidth || Math.max(96, frame.width * printTitle.width);
    const shellHeight = titleShell.offsetHeight || 24;
    const nextX = clamp((event.clientX - titleUiState.dragOffsetX - frame.x) / Math.max(1, frame.width), 0, Math.max(0, 1 - (shellWidth / Math.max(1, frame.width))));
    const nextY = clamp((event.clientY - titleUiState.dragOffsetY - frame.y) / Math.max(1, frame.height), 0, Math.max(0, 1 - (shellHeight / Math.max(1, frame.height))));
    emitTitleChange({ ...printTitle, x: nextX, y: nextY });
  });

  function finishTitleDrag(event) {
    if (!titleUiState.dragging || event.pointerId !== titleUiState.dragPointerId) {
      return;
    }
    titleUiState.dragging = false;
    titleUiState.dragPointerId = null;
    titleShell.classList.remove("is-dragging");
    titleMoveHandle.releasePointerCapture?.(event.pointerId);
    emitTitleChange(printTitle, { commit: true });
  }

  titleMoveHandle.addEventListener("pointerup", finishTitleDrag);
  titleMoveHandle.addEventListener("pointercancel", finishTitleDrag);

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
    const nextProjection = item.dataset.projId;
    const frame = getPrintPreviewFrame();
    const nextCamera = width && height
      ? transferProjectionCamera({
        sourceProjectionType: viewState.projection,
        targetProjectionType: nextProjection,
        width,
        height,
        camera: viewState.activeCamera,
        sourceLocked: viewState.locked,
        targetLocked: viewState.locked,
        focusX: frame.x + (frame.width / 2),
        focusY: frame.y + (frame.height / 2),
      })
      : normalizeProjectionCamera(nextProjection, null, { locked: viewState.locked });
    viewState = {
      ...viewState,
      projection: nextProjection,
      activeCamera: nextCamera,
    };
    invalidation.invalidate(["scene", "camera", "frame"]);
    updateProjectionBtn();
    requestRender();
    onProjectionChange?.(nextProjection, nextCamera, viewState.locked);
  });

  lockBtn.addEventListener("click", () => {
    closeDropdown();
    const nextLocked = !viewState.locked;
    const nextCamera = viewState.activeCamera
      ? normalizeProjectionCamera(viewState.projection, viewState.activeCamera, { locked: nextLocked })
      : normalizeProjectionCamera(viewState.projection, null, { locked: nextLocked });
    viewState = {
      ...viewState,
      locked: nextLocked,
      activeCamera: nextCamera,
    };
    updateProjectionBtn();
    invalidation.invalidate(["camera", "frame"]);
    requestRender();
    onProjectionLockChange?.(nextLocked, nextCamera);
  });

  resetBtn.addEventListener("click", () => {
    closeDropdown();
    onProjectionReset?.(viewState.projection, viewState.locked);
  });

  undoBtn.addEventListener("click", () => {
    if (!canUndo) {
      return;
    }
    closeDropdown();
    onUndo?.();
  });

  createGestureController(canvas, {
    getCamera,
    onCamera: applyCamera,
    sensitivity: ORTHOGRAPHIC_DRAG_SENSITIVITY,
    getMode: () => getProjectionGestureMode(viewState.projection, viewState.locked),
    getProjectDragCamera: ({ startCamera, startX, startY, currentX, currentY }) => getProjectionDragCamera({
      projectionType: viewState.projection,
      width,
      height,
      camera: startCamera,
      startX,
      startY,
      currentX,
      currentY,
    }),
    getProjectZoomCamera: ({ camera, nextZoomScale, anchorX, anchorY }) => getProjectionZoomCamera({
      projectionType: viewState.projection,
      width,
      height,
      camera,
      nextZoomScale,
      anchorX,
      anchorY,
    }),
    getPanCamera: ({ camera, deltaX, deltaY }) => getProjectionPanCamera({
      projectionType: viewState.projection,
      camera,
      deltaX,
      deltaY,
    }),
    getPanZoomCamera: ({ camera, nextZoomScale, anchorCx, anchorCy }) => getProjectionPanZoomCamera({
      projectionType: viewState.projection,
      camera,
      nextZoomScale,
      anchorCx,
      anchorCy,
    }),
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
    syncTitleOverlay();
    requestRender();
  });
  resizeObserver.observe(mount);

  updateProjectionBtn();
  syncTitleOverlay();

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
        activeCamera: normalizeProjectionCamera(
          nextProps?.projection ?? viewState.projection,
          nextProps?.activeCamera ?? viewState.activeCamera,
          { locked: nextProps?.locked ?? viewState.locked },
        ),
        locked: nextProps?.locked ?? viewState.locked,
      };
      if ("printTitle" in (nextProps ?? {})) {
        printTitle = normalizeTitle(nextProps?.printTitle);
      }
      if ("showCanvasTitle" in (nextProps ?? {})) {
        showCanvasTitle = nextProps?.showCanvasTitle !== false;
      }
      canUndo = nextProps?.canUndo === true;
      if (sceneChanged) {
        preparedDynamicKey = "";
        invalidation.invalidate(["scene", "frame"]);
      } else {
        invalidation.invalidate("frame");
      }
      updateProjectionBtn();
      syncTitleOverlay();
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
    getPerfSnapshot() {
      return {
        main: perfTracker.snapshot(),
        worker: globalThis.__earthlabPrintPerfLatest?.worker ?? null,
      };
    },
  };
}
