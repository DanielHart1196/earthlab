const DOUBLE_TAP_MAX_MS = 280;
const DOUBLE_TAP_MAX_PX = 56;
const DOUBLE_TAP_DRAG_DEADZONE_PX = 14;
const TOUCH_DRAG_DEADZONE_PX = 6;
const DOUBLE_TAP_DRAG_ZOOM_RATE = 0.0075;
const DOUBLE_TAP_ZOOM_STEP = 1.6;
const SCROLL_ZOOM_RATE = 0.003;
const MIN_ZOOM_SCALE = 1;
const MAX_ZOOM_SCALE = 16;

// Wires drag/pinch/scroll/double-tap gestures on a canvas element.
// mode "rotate": drag rotates the sphere (orthographic).
// mode "pan": drag translates the map (flat projections).
// getMode() is called live so switching projections takes effect immediately.
export function createGestureController(
  canvas,
  {
    getCamera,
    onCamera,
    sensitivity,
    getMode,
    onInteractionStart = null,
    onInteractionEnd = null,
  },
) {
  let activePointerId = null;
  let pointerDrag = null;
  const activeGesturePointers = new Map();
  let isPinchZooming = false;
  let pinchDistance = null;
  let lastTapTimestamp = 0;
  let lastTapPosition = null;
  let doubleTapHoldState = null;
  let interactionDepth = 0;
  let wheelInteractionTimer = 0;

  function beginInteraction() {
    interactionDepth += 1;
    if (interactionDepth === 1) {
      onInteractionStart?.();
    }
  }

  function endInteraction() {
    if (interactionDepth === 0) {
      return;
    }
    interactionDepth -= 1;
    if (interactionDepth === 0) {
      onInteractionEnd?.();
    }
  }

  function getDragSensitivity(pointerType) {
    const camera = getCamera();
    const mouseMultiplier = pointerType === "mouse" ? 0.5 : 1;
    return sensitivity * (1.5 / Math.max(camera.zoomScale || 1, 1)) * mouseMultiplier;
  }

  function getPointerDistance(a, b) {
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  function getCanvasNormPos(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return {
      cx: (clientX - rect.left) / rect.width - 0.5,
      cy: (clientY - rect.top) / rect.height - 0.5,
    };
  }

  function getFlatZoomPan(camera, factor, cx, cy) {
    return {
      panX: cx - (cx - (camera.panX ?? 0)) * factor,
      panY: cy - (cy - (camera.panY ?? 0)) * factor,
    };
  }

  function getEffectiveZoom(camera, factor) {
    const currentZoom = Math.max(Number(camera.zoomScale) || 1, MIN_ZOOM_SCALE);
    const requestedZoom = currentZoom * factor;
    const nextZoom = Math.max(MIN_ZOOM_SCALE, Math.min(MAX_ZOOM_SCALE, requestedZoom));
    return {
      currentZoom,
      nextZoom,
      effectiveFactor: nextZoom / currentZoom,
    };
  }

  function adjustZoomBy(delta, anchor = null) {
    const camera = getCamera();
    const { nextZoom, effectiveFactor } = getEffectiveZoom(camera, delta);
    if (getMode?.() === "pan") {
      const flatAnchor = anchor ?? { cx: 0, cy: 0 };
      const { panX, panY } = getFlatZoomPan(camera, effectiveFactor, flatAnchor.cx, flatAnchor.cy);
      onCamera({ ...camera, zoomScale: nextZoom, panX, panY });
      return;
    }
    onCamera({ ...camera, zoomScale: nextZoom });
  }

  function handleDoubleTapPointerStart(event) {
    const now = Date.now();
    const tapPosition = { x: event.clientX, y: event.clientY };
    const isDoubleTap = now - lastTapTimestamp < DOUBLE_TAP_MAX_MS
      && lastTapPosition
      && Math.hypot(tapPosition.x - lastTapPosition.x, tapPosition.y - lastTapPosition.y) < DOUBLE_TAP_MAX_PX;

    lastTapTimestamp = now;
    lastTapPosition = tapPosition;

    if (!isDoubleTap) {
      doubleTapHoldState = null;
      return false;
    }

    event.preventDefault();
    beginInteraction();
    if (typeof canvas.setPointerCapture === "function") {
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        // Ignore capture failures and fall back to normal pointer delivery.
      }
    }
    doubleTapHoldState = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startCamera: { ...getCamera() },
      anchor: getCanvasNormPos(event.clientX, event.clientY),
      activated: false,
    };
    return true;
  }

  function handleDoubleTapPointerMove(event) {
    if (!doubleTapHoldState || doubleTapHoldState.pointerId !== event.pointerId) {
      return false;
    }

    event.preventDefault();

    const deltaY = event.clientY - doubleTapHoldState.startY;
    if (!doubleTapHoldState.activated && Math.abs(deltaY) < DOUBLE_TAP_DRAG_DEADZONE_PX) {
      return true;
    }
    doubleTapHoldState.activated = true;
    const requestedFactor = Math.exp(deltaY * DOUBLE_TAP_DRAG_ZOOM_RATE);
    const {
      nextZoom,
      effectiveFactor,
    } = getEffectiveZoom(doubleTapHoldState.startCamera, requestedFactor);
    const nextCamera = {
      ...doubleTapHoldState.startCamera,
      zoomScale: nextZoom,
    };
    if (getMode?.() === "pan") {
      const { panX, panY } = getFlatZoomPan(
        doubleTapHoldState.startCamera,
        effectiveFactor,
        0,
        0,
      );
      nextCamera.panX = panX;
      nextCamera.panY = panY;
    }
    onCamera(nextCamera);
    return true;
  }

  function handleDoubleTapPointerEnd(pointerId) {
    if (!doubleTapHoldState || doubleTapHoldState.pointerId !== pointerId) return;
    const wasActivated = doubleTapHoldState.activated;
    const anchor = doubleTapHoldState.anchor;
    doubleTapHoldState = null;
    if (typeof canvas.hasPointerCapture === "function" && canvas.hasPointerCapture(pointerId)) {
      try {
        canvas.releasePointerCapture(pointerId);
      } catch {
        // Ignore release failures.
      }
    }
    endInteraction();
    if (!wasActivated) adjustZoomBy(DOUBLE_TAP_ZOOM_STEP, anchor);
  }

  function syncPinchState() {
    if (activeGesturePointers.size < 2) {
      isPinchZooming = false;
      pinchDistance = null;
      return;
    }

    const [pointerA, pointerB] = Array.from(activeGesturePointers.values());
    const nextDistance = getPointerDistance(pointerA, pointerB);
    if (!Number.isFinite(nextDistance) || nextDistance <= 0) return;

    if (!isPinchZooming || !pinchDistance) {
      isPinchZooming = true;
      beginInteraction();
      pinchDistance = nextDistance;
      return;
    }

    const camera = getCamera();
    const requestedFactor = nextDistance / pinchDistance;
    const { nextZoom, effectiveFactor } = getEffectiveZoom(camera, requestedFactor);

    if (getMode?.() === "pan") {
      const { panX, panY } = getFlatZoomPan(camera, effectiveFactor, 0, 0);
      onCamera({
        ...camera,
        zoomScale: nextZoom,
        panX,
        panY,
      });
    } else {
      onCamera({ ...camera, zoomScale: nextZoom });
    }

    pinchDistance = nextDistance;
  }

  function startPointerDrag(event) {
    if (!pointerDrag || pointerDrag.started) {
      return;
    }
    pointerDrag.started = true;
    beginInteraction();
    if (typeof canvas.setPointerCapture === "function") {
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        // Ignore capture failures and fall back to normal pointer delivery.
      }
    }
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "touch" || event.pointerType === "pen") {
      activeGesturePointers.set(event.pointerId, {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
      });

      if (activeGesturePointers.size === 1) {
        handleDoubleTapPointerStart(event);
      } else {
        doubleTapHoldState = null;
        event.preventDefault();
        syncPinchState();
      }
    }

    if (isPinchZooming || doubleTapHoldState) return;

    activePointerId = event.pointerId;
    pointerDrag = {
      startX: event.clientX,
      startY: event.clientY,
      startCamera: { ...getCamera() },
      pointerType: event.pointerType,
      started: event.pointerType !== "touch" && event.pointerType !== "pen",
    };
    startPointerDrag(event);
  });

  canvas.addEventListener("pointermove", (event) => {
    if (activeGesturePointers.has(event.pointerId)) {
      activeGesturePointers.set(event.pointerId, {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
      });

      if (handleDoubleTapPointerMove(event)) return;

      if (activeGesturePointers.size >= 2) {
        event.preventDefault();
        syncPinchState();
        return;
      }
    }

    if (isPinchZooming || doubleTapHoldState) return;
    if (event.pointerId !== activePointerId || !pointerDrag) return;

    if (!pointerDrag.started) {
      const distance = Math.hypot(
        event.clientX - pointerDrag.startX,
        event.clientY - pointerDrag.startY,
      );
      if (distance < TOUCH_DRAG_DEADZONE_PX) {
        return;
      }
      startPointerDrag(event);
    }

    if (getMode?.() === "pan") {
      onCamera({
        ...pointerDrag.startCamera,
        panX: (pointerDrag.startCamera.panX ?? 0) + (event.clientX - pointerDrag.startX) / canvas.clientWidth,
        panY: (pointerDrag.startCamera.panY ?? 0) + (event.clientY - pointerDrag.startY) / canvas.clientHeight,
      });
    } else {
      const s = getDragSensitivity(pointerDrag.pointerType);
      onCamera({
        ...pointerDrag.startCamera,
        rotationLon: pointerDrag.startCamera.rotationLon + (event.clientX - pointerDrag.startX) * s,
        rotationLat: pointerDrag.startCamera.rotationLat - (event.clientY - pointerDrag.startY) * s,
      });
    }
  });

  function endPointerDrag(event) {
    handleDoubleTapPointerEnd(event.pointerId);
    activeGesturePointers.delete(event.pointerId);
    if (activeGesturePointers.size < 2) {
      if (isPinchZooming) {
        endInteraction();
      }
      isPinchZooming = false;
      pinchDistance = null;
    } else {
      syncPinchState();
    }

    if (event.pointerId !== activePointerId) return;
    const dragStarted = pointerDrag?.started;
    pointerDrag = null;
    activePointerId = null;
    if (dragStarted) {
      endInteraction();
    }
    if (typeof canvas.hasPointerCapture === "function" && canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
  }

  canvas.addEventListener("pointerup", endPointerDrag);
  canvas.addEventListener("pointercancel", (event) => {
    handleDoubleTapPointerEnd(event.pointerId);
    if (doubleTapHoldState?.pointerId !== event.pointerId) {
      doubleTapHoldState = null;
    }
    activeGesturePointers.delete(event.pointerId);
    if (activeGesturePointers.size < 2) {
      if (isPinchZooming) {
        endInteraction();
      }
      isPinchZooming = false;
      pinchDistance = null;
    }
    endPointerDrag(event);
  });

  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    beginInteraction();
    const camera = getCamera();
    const requestedFactor = Math.exp(-event.deltaY * SCROLL_ZOOM_RATE);
    const { nextZoom, effectiveFactor } = getEffectiveZoom(camera, requestedFactor);
    if (getMode?.() === "pan") {
      const { panX, panY } = getFlatZoomPan(camera, effectiveFactor, 0, 0);
      onCamera({
        ...camera,
        zoomScale: nextZoom,
        panX,
        panY,
      });
    } else {
      onCamera({ ...camera, zoomScale: nextZoom });
    }
    window.clearTimeout(wheelInteractionTimer);
    wheelInteractionTimer = window.setTimeout(() => {
      endInteraction();
    }, 120);
  }, { passive: false });
}
