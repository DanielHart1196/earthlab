function sameArray(a, b) {
  if (a === b) {
    return true;
  }
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }
  return true;
}

function sameScene(a, b) {
  return a.backgroundFill === b.backgroundFill
    && a.oceanFill === b.oceanFill
    && a.landFill === b.landFill
    && a.landLine === b.landLine
    && a.graticulesLine === b.graticulesLine
    && a.land === b.land
    && a.interactionLand === b.interactionLand
    && a.graticules === b.graticules
    && a.dynamicLayers === b.dynamicLayers
    && a.dynamicLayersRevision === b.dynamicLayersRevision
    && a.dynamicLayerData === b.dynamicLayerData
    && a.dynamicLayerDataRevision === b.dynamicLayerDataRevision
    && sameArray(a.earthRenderOrder, b.earthRenderOrder);
}

export function createPrintSceneModel() {
  let revision = 0;
  let scene = {
    backgroundFill: "#f9f9ef",
    oceanFill: { color: "#f9f9ef", opacity: 100 },
    landFill: { color: "#6eaa6e", opacity: 100 },
    landLine: { color: "#000000", opacity: 100, width: 1 },
    graticulesLine: { color: "#8fa9bc", opacity: 100, width: 1 },
    land: null,
    interactionLand: null,
    graticules: null,
    dynamicLayers: [],
    dynamicLayersRevision: 0,
    dynamicLayerData: [],
    dynamicLayerDataRevision: 0,
    earthRenderOrder: [],
  };

  function update(nextScene) {
    if (!sameScene(scene, nextScene)) {
      scene = nextScene;
      revision += 1;
      return true;
    }
    return false;
  }

  function get() {
    return scene;
  }

  function getRevision() {
    return revision;
  }

  return {
    get,
    getRevision,
    update,
  };
}
