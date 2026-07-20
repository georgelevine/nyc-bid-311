/**
 * polygons.js — BID polygon processing with Turf.js
 * Closes internal gaps between tax lot parcels without expanding the outer edge.
 */
const Polygons = (() => {
  const GAP_CLOSE_METERS = 30;
  const DISPLAY_SIMPLIFY_TOLERANCE = 0.000015; // Roughly 1-2 meters in NYC
  const processedCache = new WeakMap();
  const featureIndices = new WeakMap();
  let registeredFeatures = [];

  function registerFeatureCollection(geojson) {
    registeredFeatures = geojson && Array.isArray(geojson.features) ? geojson.features : [];
    registeredFeatures.forEach((feature, index) => {
      featureIndices.set(feature, index);
      const processed = processedCache.get(feature);
      if (processed) processed.registryIndex = index;
    });
  }

  function dissolveFeature(feature) {
    if (!feature || !feature.geometry || feature.geometry.type !== 'MultiPolygon') return feature;
    try {
      const polygons = feature.geometry.coordinates.map(coords => turf.polygon(coords));
      if (polygons.length === 0) return feature;

      let merged = polygons[0];
      for (let i = 1; i < polygons.length; i++) {
        try {
          const union = turf.union(turf.featureCollection([merged, polygons[i]]));
          if (union) merged = union;
        } catch (e) {
          return feature;
        }
      }
      return merged;
    } catch (e) {
      return feature;
    }
  }

  function buildGapFilledBoundary(feature) {
    try {
      // Morphological closing: expand to bridge interior streets, merge, then
      // contract by the same amount so the exterior returns to the parcel edge.
      const expanded = turf.buffer(feature, GAP_CLOSE_METERS, { units: 'meters' });
      if (!expanded) return feature;
      const mergedExpansion = dissolveFeature(expanded);
      const contracted = turf.buffer(mergedExpansion, -GAP_CLOSE_METERS, { units: 'meters' });
      if (!contracted) return feature;

      // Re-union the source parcels so contraction never trims a corner or
      // removes a small parcel at the district's true outside edge.
      const restored = turf.union(turf.featureCollection([
        contracted,
        feature
      ]));
      return restored || feature;
    } catch (e) {
      return feature;
    }
  }

  function buildDisplayBoundary(feature) {
    try {
      const cleaned = turf.cleanCoords(feature);
      const simplified = turf.simplify(cleaned, {
        tolerance: DISPLAY_SIMPLIFY_TOLERANCE,
        highQuality: true,
        mutate: false
      });
      const geometry = simplified.geometry;

      // The display layer should show only the outer perimeter. Interior rings
      // remain in the source geometry used for point-in-polygon filtering.
      if (geometry.type === 'Polygon') {
        return turf.polygon([geometry.coordinates[0]], feature.properties || {});
      }
      if (geometry.type === 'MultiPolygon') {
        return turf.multiPolygon(
          geometry.coordinates.map(polygon => [polygon[0]]),
          feature.properties || {}
        );
      }
    } catch (e) {
      // Fall back to the precise processed geometry if display cleanup fails.
    }
    return feature;
  }

  /**
   * Fill internal gaps in a BID MultiPolygon while preserving its outer edge.
   * Returns { buffered, bbox, paddedBbox }
   */
  function processFeature(feature) {
    if (!feature || !feature.geometry) return null;
    if (processedCache.has(feature)) {
      const cached = processedCache.get(feature);
      if (featureIndices.has(feature)) cached.registryIndex = featureIndices.get(feature);
      return cached;
    }

    try {
      const gapFilled = buildGapFilledBoundary(feature);

      // Compute bounding box
      const bbox = turf.bbox(gapFilled);

      // Pad bbox by ~50m for the SODA query (roughly 0.0005 degrees)
      const PAD = 0.0005;
      const paddedBbox = [
        bbox[0] - PAD, // west
        bbox[1] - PAD, // south
        bbox[2] + PAD, // east
        bbox[3] + PAD  // north
      ];

      const processed = {
        raw: feature,
        buffered: gapFilled,
        displayBoundary: buildDisplayBoundary(gapFilled),
        bbox,
        paddedBbox,
        gapCloseDistance: GAP_CLOSE_METERS,
        registryIndex: featureIndices.has(feature) ? featureIndices.get(feature) : null
      };
      processedCache.set(feature, processed);
      return processed;
    } catch (err) {
      console.error('Polygon processing error:', err);
      return null;
    }
  }

  /**
   * Check if a point [lng, lat] is inside the gap-filled BID polygon.
   */
  function isPointInside(lng, lat, processedPolygon) {
    if (!processedPolygon || !processedPolygon.buffered) return false;
    try {
      const pt = turf.point([lng, lat]);
      return turf.booleanPointInPolygon(pt, processedPolygon.buffered);
    } catch (e) {
      return false;
    }
  }

  function distanceToRawFeature(point, feature) {
    try {
      if (turf.booleanPointInPolygon(point, feature)) return 0;
      if (typeof turf.pointToPolygonDistance === 'function') {
        return Math.abs(turf.pointToPolygonDistance(point, feature, { units: 'meters' }));
      }

      const boundary = turf.polygonToLine(feature);
      const lines = turf.flatten(boundary).features;
      return Math.min(...lines.map(line =>
        turf.pointToLineDistance(point, line, { units: 'meters' })
      ));
    } catch (e) {
      return turf.distance(point, turf.centroid(feature), { units: 'meters' });
    }
  }

  function resolveOwnerIndex(lng, lat) {
    if (registeredFeatures.length === 0) return null;
    const point = turf.point([lng, lat]);
    const candidates = [];

    registeredFeatures.forEach((feature, index) => {
      const processed = processFeature(feature);
      if (!processed) return;
      const bbox = processed.bbox;
      if (lng < bbox[0] || lng > bbox[2] || lat < bbox[1] || lat > bbox[3]) return;
      if (!turf.booleanPointInPolygon(point, processed.buffered)) return;

      candidates.push({ index, distance: distanceToRawFeature(point, feature) });
    });

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.distance - b.distance || a.index - b.index);
    return candidates[0].index;
  }

  function isPointOwned(lng, lat, processedPolygon) {
    if (!isPointInside(lng, lat, processedPolygon)) return false;
    if (processedPolygon.registryIndex == null) return true;
    const ownerIndex = resolveOwnerIndex(lng, lat);
    return ownerIndex == null || ownerIndex === processedPolygon.registryIndex;
  }

  /**
   * Get Leaflet-compatible bounds from bbox [west, south, east, north]
   */
  function bboxToLatLngBounds(bbox) {
    return L.latLngBounds(
      L.latLng(bbox[1], bbox[0]), // southwest
      L.latLng(bbox[3], bbox[2])  // northeast
    );
  }

  return {
    registerFeatureCollection, processFeature, isPointInside, isPointOwned,
    resolveOwnerIndex, bboxToLatLngBounds, GAP_CLOSE_METERS
  };
})();
