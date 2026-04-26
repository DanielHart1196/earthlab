import { requireSupabase } from "../../lib/supabase.js";

function normalizeGeometryTypes(geometryTypes = [], geometryType = "mixed") {
  const source = Array.isArray(geometryTypes) && geometryTypes.length
    ? geometryTypes
    : [geometryType];
  const normalized = source.map((value) => {
    if (value === "point") return "point";
    if (value === "line") return "line";
    if (value === "polygon" || value === "area") return "polygon";
    return null;
  }).filter(Boolean);
  return ["point", "line", "polygon"].filter((family) => normalized.includes(family));
}

async function getSupabaseCatalog() {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from("layers")
    .select("id, name, geometry_type, geometry_types")
    .in("view_access", ["public", "unlisted"])
    .order("name");

  if (error) {
    throw new Error(`Failed to load layers: ${error.message}`);
  }

  return (Array.isArray(data) ? data : []).map((layer) => ({
    id: layer.id,
    label: layer.name,
    geometryTypes: normalizeGeometryTypes(layer.geometry_types, layer.geometry_type ?? "mixed"),
    geometryType: layer.geometry_type ?? "mixed",
  }));
}

async function loadLayerDatasets(layerId) {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from("datasets")
    .select("id, layer_id, name, geometry_type, geometry_types, field_schema, render_format, artifact_url, feature_count, created_at")
    .eq("layer_id", layerId)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to load datasets: ${error.message}`);
  }

  return Array.isArray(data) ? data : [];
}

async function getLayerFieldValues(layerId, field) {
  const supabase = requireSupabase();
  const datasets = await loadLayerDatasets(layerId);
  const datasetIds = datasets.map((d) => d.id);
  if (!datasetIds.length) return null;

  const { data, error } = await supabase
    .from("features")
    .select("properties")
    .in("dataset_id", datasetIds)
    .limit(200);

  if (error || !data?.length) return null;

  const seen = new Set();
  for (const row of data) {
    const value = row.properties?.[field];
    if (value !== undefined && value !== null && value !== "") {
      seen.add(value);
    }
  }

  if (!seen.size) return null;

  return [...seen].sort((a, b) => {
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a).localeCompare(String(b));
  });
}

async function loadGeojsonArtifact(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch GeoJSON artifact: ${response.status}`);
  }
  return response.json();
}

async function loadLayerFromSupabase(layerId) {
  const supabase = requireSupabase();
  const { data: layer, error: layerError } = await supabase
    .from("layers")
    .select("id, name, geometry_type, geometry_types, default_style, feature_count")
    .eq("id", layerId)
    .single();

  if (layerError) {
    throw new Error(`Failed to load layer: ${layerError.message}`);
  }

  const datasets = await loadLayerDatasets(layerId);
  const layerGeometryTypes = normalizeGeometryTypes(layer.geometry_types, layer.geometry_type ?? "mixed");

  if (datasets.length === 1) {
    const [dataset] = datasets;
    if (dataset?.render_format === "geojson" && dataset?.artifact_url) {
      return {
        layer: { ...layer, geometryTypes: layerGeometryTypes },
        datasets,
        geojson: await loadGeojsonArtifact(dataset.artifact_url),
        tilesUrl: null,
      };
    }

    if (dataset?.render_format === "pmtiles" && dataset?.artifact_url) {
      return {
        layer: { ...layer, geometryTypes: layerGeometryTypes },
        datasets,
        geojson: null,
        tilesUrl: dataset.artifact_url,
      };
    }
  }

  const { data: geojson, error: geojsonError } = await supabase.rpc("get_layer_geojson", { p_layer_id: layerId });
  if (geojsonError) {
    throw new Error(`Failed to load features: ${geojsonError.message}`);
  }

  return {
    layer: { ...layer, geometryTypes: layerGeometryTypes },
    datasets,
    geojson,
    tilesUrl: null,
  };
}

export { getSupabaseCatalog, getLayerFieldValues, loadLayerDatasets, loadLayerFromSupabase, normalizeGeometryTypes };
