function getFeatureGeometryFamily(feature) {
  const type = feature?.geometry?.type;
  if (type === "Point" || type === "MultiPoint") return "point";
  if (type === "LineString" || type === "MultiLineString") return "line";
  if (type === "Polygon" || type === "MultiPolygon") return "polygon";
  return null;
}

function featureCollection(features) {
  return { type: "FeatureCollection", features };
}

function filterMatchingFeatures(features, field, value) {
  return features.filter((f) => {
    const props = f?.properties;
    return props != null && String(props[field]) === String(value);
  });
}

function appendDynamicLayerGroup(target, geojson, channels, channelOrder) {
  const features = geojson.features ?? [];
  const polygonData = featureCollection(features.filter((f) => getFeatureGeometryFamily(f) === "polygon"));
  const lineData = featureCollection(features.filter((f) => {
    const family = getFeatureGeometryFamily(f);
    return family === "polygon" || family === "line";
  }));
  const pointData = featureCollection(features.filter((f) => getFeatureGeometryFamily(f) === "point"));

  const layerMap = {
    fill: polygonData.features.length ? { kind: "fill", geojson: polygonData, fill: channels.fill } : null,
    line: lineData.features.length ? { kind: "line", geojson: lineData, line: channels.line } : null,
    point: pointData.features.length ? { kind: "point", geojson: pointData, point: channels.point, pointLine: channels.pointLine } : null,
  };

  const order = Array.isArray(channelOrder) && channelOrder.length ? channelOrder : ["fill", "line", "point"];
  [...order].reverse().forEach((id) => {
    if (layerMap[id]) target.push(layerMap[id]);
  });
}

// Builds a flat list of draw commands from the current dynamic layer state.
// Commands are pure data — no canvas or projection dependency.
// Re-run only when dynamicLayers or dynamicLayerData change.
export function buildDynamicDrawCommands(dynamicLayers, dynamicLayerData) {
  const dataById = new Map(dynamicLayerData.map((entry) => [entry.id, entry.data]));
  return [...(dynamicLayers ?? [])].reverse().flatMap((entry) => {
    if (entry?.visible === false) return [];
    const dataRecord = dataById.get(entry.id);
    if (!dataRecord?.geojson) return [];

    const allFeatures = dataRecord.geojson.features ?? [];
    const activeFilters = (entry.filters ?? []).filter((f) => f.visible !== false && f.field && f.value != null);
    const excludedFeatures = new Set();
    if (activeFilters.length) {
      for (const feature of allFeatures) {
        const props = feature?.properties;
        if (!props) continue;
        for (const filter of activeFilters) {
          if (String(props[filter.field]) === String(filter.value)) {
            excludedFeatures.add(feature);
            break;
          }
        }
      }
    }

    const baseFeatures = excludedFeatures.size
      ? allFeatures.filter((f) => !excludedFeatures.has(f))
      : allFeatures;
    const commands = [];
    appendDynamicLayerGroup(commands, featureCollection(baseFeatures), entry.channels ?? {}, entry.channelOrder);

    for (const filter of [...(entry.filters ?? [])].reverse()) {
      if (filter.visible === false || !filter.field || filter.value == null) continue;
      const matchingFeatures = filterMatchingFeatures(allFeatures, filter.field, filter.value);
      if (!matchingFeatures.length) continue;
      appendDynamicLayerGroup(commands, featureCollection(matchingFeatures), filter.channels ?? {}, filter.channelOrder);
    }

    return commands;
  });
}
