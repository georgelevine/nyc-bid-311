/**
 * polygons.js — BID polygon processing with Turf.js
 * Handles buffering tax lot parcels to fill street gaps and computing bounding boxes.
 */
const Polygons = (() => {
  const BUFFER_METERS = 30; // Half a typical NYC street width

  /**
   * Buffer a BID feature's MultiPolygon to fill street gaps.
   * Returns { buffered, bbox, paddedBbox }
   */
  function processFeature(feature) {
    if (!feature || !feature.geometry) return null;

    try {
      // Buffer each polygon to expand into streets
      const buffered = turf.buffer(feature, BUFFER_METERS, { units: 'meters' });

      if (!buffered) return null;

      // Try to dissolve overlapping buffered polygons into a single shape
      let dissolved = buffered;
      if (buffered.geometry.type === 'MultiPolygon') {
        try {
          // Convert MultiPolygon to FeatureCollection of individual polygons
          const polys = [];
          for (const coords of buffered.geometry.coordinates) {
            polys.push(turf.polygon(coords));
          }
          // Iteratively union them
          if (polys.length > 1) {
            let merged = polys[0];
            for (let i = 1; i < polys.length; i++) {
              try {
                const u = turf.union(turf.featureCollection([merged, polys[i]]));
                if (u) merged = u;
              } catch (e) {
                // Skip invalid polygons
              }
            }
            dissolved = merged;
          }
        } catch (e) {
          // Fall back to unbuffered dissolved
          dissolved = buffered;
        }
      }

      // Compute bounding box
      const bbox = turf.bbox(dissolved);

      // Pad bbox by ~50m for the SODA query (roughly 0.0005 degrees)
      const PAD = 0.0005;
      const paddedBbox = [
        bbox[0] - PAD, // west
        bbox[1] - PAD, // south
        bbox[2] + PAD, // east
        bbox[3] + PAD  // north
      ];

      return {
        raw: feature,
        buffered: dissolved,
        bbox,
        paddedBbox,
        bufferDistance: BUFFER_METERS
      };
    } catch (err) {
      console.error('Polygon processing error:', err);
      return null;
    }
  }

  /**
   * Check if a point [lng, lat] is inside the buffered polygon
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

  /**
   * Get Leaflet-compatible bounds from bbox [west, south, east, north]
   */
  function bboxToLatLngBounds(bbox) {
    return L.latLngBounds(
      L.latLng(bbox[1], bbox[0]), // southwest
      L.latLng(bbox[3], bbox[2])  // northeast
    );
  }

  return { processFeature, isPointInside, bboxToLatLngBounds, BUFFER_METERS };
})();
