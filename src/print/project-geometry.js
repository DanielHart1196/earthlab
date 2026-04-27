import { geoPath, geoStream } from "d3-geo";

function createCollector() {
  const paths = [];
  let current = null;

  function flushCurrent() {
    if (!current || current.length < 2) { current = null; return; }
    paths.push(current);
    current = null;
  }

  return {
    beginPath() { flushCurrent(); },
    moveTo(x, y) { flushCurrent(); current = [[x, y]]; },
    lineTo(x, y) {
      if (!current) { current = [[x, y]]; return; }
      current.push([x, y]);
    },
    closePath() {
      if (!current || current.length < 2) { current = null; return; }
      const first = current[0];
      const last = current[current.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) current.push([...first]);
      paths.push(current);
      current = null;
    },
    result() { flushCurrent(); return paths; },
  };
}

// Sphere boundary has no holes and never crosses the hemisphere boundary,
// so geoPath with a collector is correct and sufficient here.
export function projectSphere(projection) {
  const collector = createCollector();
  geoPath(projection, collector)({ type: "Sphere" });
  return collector.result();
}

// Projects any GeoJSON through a d3-geo projection using the stream API.
// The projection handles rotation, hemisphere preclipping, resampling, and
// projection math internally before calling our listener with clean XY coords.
// Returns geometry buckets ready for deck.gl CARTESIAN layers.
export function projectGeometry(geojson, projection) {
  const polygons = [];
  const lines = [];
  const points = [];

  let inPolygon = false;
  let ringIndex = 0;
  let currentRing = null;
  let currentPolygon = null;

  const listener = {
    polygonStart() {
      inPolygon = true;
      ringIndex = 0;
      currentPolygon = [];
    },
    polygonEnd() {
      inPolygon = false;
      if (currentPolygon && currentPolygon.length > 0) {
        const [exterior, ...holes] = currentPolygon;
        if (exterior.length >= 3) {
          polygons.push(holes.length ? [exterior, ...holes] : exterior);
        }
      }
      currentPolygon = null;
    },
    lineStart() {
      currentRing = [];
    },
    lineEnd() {
      const ring = currentRing;
      currentRing = null;
      if (!ring || ring.length < 2) return;

      if (inPolygon) {
        // Close the ring — d3 stream omits the repeated closing coordinate.
        const first = ring[0];
        const last = ring[ring.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first]);
        currentPolygon.push(ring);
        ringIndex++;
      } else {
        lines.push(ring);
      }
    },
    point(x, y) {
      if (currentRing) {
        currentRing.push([x, y]);
      } else if (!inPolygon) {
        points.push([x, y]);
      }
    },
    sphere() {},
  };

  const projStream = projection.stream(listener);
  geoStream(geojson, projStream);

  return { polygons, lines, points };
}
