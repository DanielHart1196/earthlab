const STORAGE_VERSION = 3;
const DEFAULT_APPEARANCE = {
  screen: {
    color: "#f9f9ef",
    opacity: 100,
  },
  settings: {
    color: "#f9f9ef",
    opacity: 100,
    lineColor: "#000000",
    lineOpacity: 30,
  },
};

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
        color: "#000000",
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
    dynamicLayers: [],
    appearance: structuredClone(DEFAULT_APPEARANCE),
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

function normalizeHexColor(value, fallback = "#e74c3c") {
  const normalized = String(value ?? "").trim().replace(/^#/, "").toLowerCase();
  return /^[\da-f]{6}$/i.test(normalized) ? `#${normalized}` : fallback;
}

function normalizeGeometryTypes(geometryTypes = [], geometryType = "mixed") {
  const source = Array.isArray(geometryTypes) && geometryTypes.length ? geometryTypes : [geometryType];
  const normalized = source.map((value) => {
    if (value === "point") return "point";
    if (value === "line") return "line";
    if (value === "polygon" || value === "area") return "polygon";
    return null;
  }).filter(Boolean);
  return ["point", "line", "polygon"].filter((family) => normalized.includes(family));
}

function normalizeLayerFilter(entry, geometryTypes = []) {
  if (!entry || typeof entry !== "object" || !entry.id || !entry.field) return null;
  const color = normalizeHexColor(entry.color, "#e74c3c");
  const opacity = normalizeNumeric(entry.opacity, 80);
  const style = { color, opacity, lineWidth: 2, pointRadius: 8 };
  const channels = normalizeDynamicChannels(entry.channels ?? {}, geometryTypes, style);

  const defaultChannelOrder = [];
  if (geometryTypes.includes("polygon")) defaultChannelOrder.push("fill", "line");
  else if (geometryTypes.includes("line")) defaultChannelOrder.push("line");
  if (geometryTypes.includes("point")) defaultChannelOrder.push("point", "pointLine");

  const savedOrder = Array.isArray(entry.channelOrder)
    ? entry.channelOrder.filter((id) => defaultChannelOrder.includes(id))
    : [];
  const channelOrder = savedOrder.length === defaultChannelOrder.length ? savedOrder : defaultChannelOrder;

  return {
    id: String(entry.id),
    field: String(entry.field),
    value: entry.value ?? null,
    visible: entry.visible !== false,
    color,
    opacity,
    channels,
    channelOrder,
  };
}

function normalizeLayerFilters(filters, geometryTypes = []) {
  if (!Array.isArray(filters)) return [];
  const seen = new Set();
  return filters
    .map((f) => normalizeLayerFilter(f, geometryTypes))
    .filter(Boolean)
    .filter((f) => {
      if (seen.has(f.id)) return false;
      seen.add(f.id);
      return true;
    });
}

function normalizeDynamicLayer(entry) {
  if (!entry || typeof entry !== "object" || !entry.id) {
    return null;
  }

  const geometryTypes = normalizeGeometryTypes(entry.geometryTypes, entry.geometryType ?? "mixed");
  const style = entry.style && typeof entry.style === "object" ? entry.style : {};
  const channels = normalizeDynamicChannels(entry.channels, geometryTypes, style);

  const defaultChannelOrder = [];
  if (geometryTypes.includes("polygon")) defaultChannelOrder.push("fill", "line");
  else if (geometryTypes.includes("line")) defaultChannelOrder.push("line");
  if (geometryTypes.includes("point")) defaultChannelOrder.push("point", "pointLine");

  const savedOrder = Array.isArray(entry.channelOrder)
    ? entry.channelOrder.filter((id) => typeof id === "string" && defaultChannelOrder.includes(id))
    : [];
  const channelOrder = savedOrder.length === defaultChannelOrder.length ? savedOrder : defaultChannelOrder;

  return {
    id: String(entry.id),
    label: String(entry.label ?? "Untitled layer"),
    source: entry.source === "supabase" ? "supabase" : "supabase",
    geometryTypes,
    geometryType: String(entry.geometryType ?? geometryTypes[0] ?? "mixed"),
    visible: entry.visible !== false,
    style: {
      color: normalizeHexColor(style.color),
      opacity: normalizeNumeric(style.opacity, 80),
      lineWidth: Math.max(0, normalizeNumeric(style.lineWidth ?? style.weight, 2)),
      pointRadius: Math.max(1, normalizeNumeric(style.pointRadius ?? style.radius, 6)),
    },
    channels,
    channelOrder,
    filters: normalizeLayerFilters(entry.filters ?? [], geometryTypes),
  };
}

function normalizeDynamicChannels(rawChannels = {}, geometryTypes = [], style = {}) {
  const color = normalizeHexColor(style.color);
  const opacity = normalizeNumeric(style.opacity, 80);
  const lineWidth = Math.max(0, normalizeNumeric(style.lineWidth ?? style.weight, 2));
  const pointRadius = Math.max(1, normalizeNumeric(style.pointRadius ?? style.radius, 6));
  const channels = {};

  if (geometryTypes.includes("polygon")) {
    channels.fill = coerceChannelState(rawChannels?.fill, {
      color,
      opacity,
      visible: true,
    });
    channels.line = coerceChannelState(rawChannels?.line, {
      color,
      opacity,
      width: lineWidth,
      visible: true,
    });
  }

  if (geometryTypes.includes("line") && !channels.line) {
    channels.line = coerceChannelState(rawChannels?.line, {
      color,
      opacity,
      width: lineWidth,
      visible: true,
    });
  }

  if (geometryTypes.includes("point")) {
    channels.point = coerceChannelState(rawChannels?.point, {
      color,
      opacity,
      radius: pointRadius,
      visible: true,
    });
    channels.pointLine = coerceChannelState(rawChannels?.pointLine, {
      color: "#000000",
      opacity: 100,
      width: 1,
      visible: true,
    });
  }

  return channels;
}

function normalizeDynamicLayers(dynamicLayers) {
  if (!Array.isArray(dynamicLayers)) {
    return [];
  }
  const seen = new Set();
  return dynamicLayers
    .map(normalizeDynamicLayer)
    .filter(Boolean)
    .filter((entry) => {
      if (seen.has(entry.id)) {
        return false;
      }
      seen.add(entry.id);
      return true;
    });
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
    dynamicLayers: normalizeDynamicLayers(rawState.dynamicLayers),
    appearance: structuredClone(base.appearance),
    layers: structuredClone(base.layers),
  };

  Object.entries(base.appearance).forEach(([kind, defaults]) => {
    const rawAppearance = rawState.appearance?.[kind];
    if (!rawAppearance || typeof rawAppearance !== "object") {
      return;
    }
    next.appearance[kind] = {
      color: String(rawAppearance.color ?? defaults.color),
      opacity: normalizeNumeric(rawAppearance.opacity, defaults.opacity),
      ...(defaults.lineColor !== undefined ? {
        lineColor: String(rawAppearance.lineColor ?? defaults.lineColor),
        lineOpacity: normalizeNumeric(rawAppearance.lineOpacity, defaults.lineOpacity),
      } : {}),
    };
  });

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
  DEFAULT_APPEARANCE,
  LAYER_DEFS,
  RENDER_ORDER_TO_LAYER,
  buildDefaultLayerState,
  getChannelTarget,
  getLayerVisibility,
  normalizeLayerState,
  normalizeLayerFilters,
  normalizeRenderOrder,
  normalizeDynamicLayers,
};
