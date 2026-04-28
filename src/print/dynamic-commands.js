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

function geometryRecordFromFeatures(features) {
  return {
    polygon: featureCollection(features.filter((f) => getFeatureGeometryFamily(f) === "polygon")),
    line: featureCollection(features.filter((f) => getFeatureGeometryFamily(f) === "line")),
    point: featureCollection(features.filter((f) => getFeatureGeometryFamily(f) === "point")),
  };
}

function filterMatchingFeatures(features, field, value) {
  return features.filter((f) => {
    const props = f?.properties;
    return props != null && String(props[field]) === String(value);
  });
}

function filterGeometryRecord(geometryRecord, excludedFeatures) {
  if (!excludedFeatures?.size) {
    return geometryRecord;
  }
  return {
    polygon: featureCollection((geometryRecord?.polygon?.features ?? []).filter((f) => !excludedFeatures.has(f))),
    line: featureCollection((geometryRecord?.line?.features ?? []).filter((f) => !excludedFeatures.has(f))),
    point: featureCollection((geometryRecord?.point?.features ?? []).filter((f) => !excludedFeatures.has(f))),
  };
}

function appendDynamicLayerGroup(target, geometryRecord, channels, channelOrder) {
  const polygonFeatures = geometryRecord?.polygon?.features ?? [];
  const lineFeatures = geometryRecord?.line?.features ?? [];
  const pointFeatures = geometryRecord?.point?.features ?? [];
  const polygonData = featureCollection(polygonFeatures);
  const lineData = featureCollection([...polygonFeatures, ...lineFeatures]);
  const pointData = featureCollection(pointFeatures);

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
    const baseGeometry = dataRecord.geometry ?? geometryRecordFromFeatures(allFeatures);
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

    const commands = [];
    appendDynamicLayerGroup(
      commands,
      filterGeometryRecord(baseGeometry, excludedFeatures),
      entry.channels ?? {},
      entry.channelOrder,
    );

    for (const filter of [...(entry.filters ?? [])].reverse()) {
      if (filter.visible === false || !filter.field || filter.value == null) continue;
      const matchingFeatures = filterMatchingFeatures(allFeatures, filter.field, filter.value);
      if (!matchingFeatures.length) continue;
      appendDynamicLayerGroup(
        commands,
        geometryRecordFromFeatures(matchingFeatures),
        filter.channels ?? {},
        filter.channelOrder,
      );
    }

    return commands;
  });
}
