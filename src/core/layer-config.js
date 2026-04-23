const STORAGE_VERSION = 2;

const RENDER_ORDER_TO_LAYER = {
  "ocean.fill": { layerId: "ocean", channelId: "fill" },
  "graticules.line": { layerId: "graticules", channelId: "line" },
  "land.line": { layerId: "land", channelId: "line" },
  "land.fill": { layerId: "land", channelId: "fill" },
};

const DEFAULT_RENDER_ORDER = [
  "land.fill",
  "land.line",
  "graticules.line",
  "ocean.fill",
];

const LAYER_DEFS = {
  earth: {
    id: "earth",
    label: "Earth",
    geometryTypes: ["polygon", "line"],
    children: ["land", "graticules", "ocean"],
    defaults: {},
  },
  ocean: {
    id: "ocean",
    label: "Ocean",
    geometryTypes: ["polygon"],
    defaults: {
      fill: {
        color: "#2c6f92",
        opacity: 100,
        visible: true,
      },
    },
  },
  land: {
    id: "land",
    label: "Land",
    geometryTypes: ["polygon"],
    defaults: {
      fill: {
        color: "#6eaa6e",
        opacity: 100,
        visible: true,
      },
      line: {
        color: "#d9e4da",
        opacity: 100,
        width: 1,
        visible: true,
      },
    },
  },
  graticules: {
    id: "graticules",
    label: "Graticules",
    geometryTypes: ["line"],
    defaults: {
      line: {
        color: "#8fa9bc",
        opacity: 100,
        width: 1,
        visible: true,
      },
    },
  },
};

function buildDefaultLayerState() {
  return {
    version: STORAGE_VERSION,
    order: [...DEFAULT_RENDER_ORDER],
    layers: {
      earth: {
        visible: true,
        expanded: true,
        channels: {},
      },
      ocean: {
        visible: true,
        expanded: false,
        channels: structuredClone(LAYER_DEFS.ocean.defaults),
      },
      land: {
        visible: true,
        expanded: false,
        channels: structuredClone(LAYER_DEFS.land.defaults),
      },
      graticules: {
        visible: true,
        expanded: false,
        channels: structuredClone(LAYER_DEFS.graticules.defaults),
      },
    },
  };
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

function normalizeNumeric(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function coerceChannelState(channel, defaults = {}) {
  if (!channel || typeof channel !== "object") {
    return structuredClone(defaults);
  }

  const next = { ...defaults, ...channel };
  if ("opacity" in defaults) {
    next.opacity = normalizeNumeric(next.opacity, defaults.opacity);
  }
  if ("width" in defaults) {
    next.width = normalizeNumeric(next.width, defaults.width);
  }
  if ("radius" in defaults) {
    next.radius = normalizeNumeric(next.radius, defaults.radius);
  }
  if ("visible" in defaults) {
    next.visible = next.visible !== false;
  }
  return next;
}

function migrateLegacyState(legacy = {}) {
  const next = buildDefaultLayerState();

  next.layers.earth.visible = legacy.earthVisible ?? true;
  next.layers.ocean.visible = legacy.oceanVisible ?? true;
  next.layers.ocean.channels.fill.color = legacy.oceanColor ?? next.layers.ocean.channels.fill.color;
  next.layers.ocean.channels.fill.opacity = normalizeNumeric(
    legacy.oceanOpacity,
    next.layers.ocean.channels.fill.opacity,
  );
  next.layers.ocean.channels.fill.visible = legacy.oceanVisible ?? true;

  next.layers.land.visible = (legacy.landFillVisible ?? true) || (legacy.landLineVisible ?? true);
  next.layers.land.channels.fill.color = legacy.landFillColor ?? next.layers.land.channels.fill.color;
  next.layers.land.channels.fill.opacity = normalizeNumeric(
    legacy.landFillOpacity,
    next.layers.land.channels.fill.opacity,
  );
  next.layers.land.channels.fill.visible = legacy.landFillVisible ?? true;
  next.layers.land.channels.line.color = legacy.landLineColor ?? next.layers.land.channels.line.color;
  next.layers.land.channels.line.opacity = normalizeNumeric(
    legacy.landLineOpacity,
    next.layers.land.channels.line.opacity,
  );
  next.layers.land.channels.line.width = normalizeNumeric(
    legacy.landLineWidth,
    next.layers.land.channels.line.width,
  );
  next.layers.land.channels.line.visible = legacy.landLineVisible ?? true;

  next.layers.graticules.visible = legacy.graticulesVisible ?? true;
  next.layers.graticules.channels.line.color = legacy.graticulesColor ?? next.layers.graticules.channels.line.color;
  next.layers.graticules.channels.line.opacity = normalizeNumeric(
    legacy.graticulesOpacity,
    next.layers.graticules.channels.line.opacity,
  );
  next.layers.graticules.channels.line.width = normalizeNumeric(
    legacy.graticulesWidth,
    next.layers.graticules.channels.line.width,
  );
  next.layers.graticules.channels.line.visible = legacy.graticulesVisible ?? true;

  next.order = normalizeRenderOrder(legacy.renderOrder);
  return next;
}

function normalizeLayerState(rawState) {
  if (!rawState || typeof rawState !== "object") {
    return buildDefaultLayerState();
  }

  if (!rawState.layers) {
    return migrateLegacyState(rawState);
  }

  const base = buildDefaultLayerState();
  const next = {
    version: STORAGE_VERSION,
    order: normalizeRenderOrder(rawState.order),
    layers: structuredClone(base.layers),
  };

  Object.keys(base.layers).forEach((layerId) => {
    const rawLayer = rawState.layers?.[layerId];
    if (!rawLayer || typeof rawLayer !== "object") {
      return;
    }
    next.layers[layerId].visible = rawLayer.visible !== false;
    next.layers[layerId].expanded = rawLayer.expanded === true;

    Object.entries(base.layers[layerId].channels).forEach(([channelId, defaults]) => {
      next.layers[layerId].channels[channelId] = coerceChannelState(
        rawLayer.channels?.[channelId],
        defaults,
      );
    });
  });

  return next;
}

function getChannelTarget(renderLayerId) {
  return RENDER_ORDER_TO_LAYER[renderLayerId] ?? null;
}

function getLayerVisibility(layerState, layerId) {
  const layer = layerState.layers?.[layerId];
  if (!layer || layer.visible === false) {
    return false;
  }
  if (layerId === "earth") {
    return layer.visible !== false;
  }
  return layerState.layers?.earth?.visible !== false;
}

export {
  DEFAULT_RENDER_ORDER,
  LAYER_DEFS,
  RENDER_ORDER_TO_LAYER,
  buildDefaultLayerState,
  getChannelTarget,
  getLayerVisibility,
  normalizeLayerState,
  normalizeRenderOrder,
};
