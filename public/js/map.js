/**
 * map.js — Leaflet map rendering, layers, popups, legend
 */
const MapView = (() => {
  let map;
  let parcelsLayer = null;
  let bufferLayer = null;
  let markersLayer = null;
  let heatLayer = null;
  let currentRecords = [];

  const COLORS = {
    matched: '#34d399',
    opendata: '#60a5fa',
    portal: '#fb923c'
  };

  // Color palette for complaint types
  const TYPE_COLORS = [
    '#f87171', '#fb923c', '#fbbf24', '#34d399', '#22d3ee',
    '#60a5fa', '#a78bfa', '#f472b6', '#a3e635', '#e879f9',
    '#94a3b8', '#fca5a5', '#fdba74', '#fde047', '#6ee7b7'
  ];

  function init() {
    map = L.map('map', {
      center: [40.7128, -74.006],
      zoom: 12,
      zoomControl: true,
      preferCanvas: true
    });

    // Dark tile layer
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19
    }).addTo(map);

    // Initialize marker cluster group
    markersLayer = L.markerClusterGroup({
      chunkedLoading: true,
      maxClusterRadius: 50,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      disableClusteringAtZoom: 17
    });
    map.addLayer(markersLayer);

    return map;
  }

  /**
   * Draw BID polygon layers (raw parcels + buffered boundary)
   */
  function drawBIDPolygon(processedPoly) {
    clearPolygonLayers();

    if (!processedPoly) return;

    // Raw parcels — light fill, dashed outline
    parcelsLayer = L.geoJSON(processedPoly.raw, {
      style: {
        fillColor: '#4f9cf7',
        fillOpacity: 0.15,
        color: '#4f9cf7',
        weight: 1,
        dashArray: '4 4'
      }
    }).addTo(map);

    // Buffered boundary — solid outline, no fill
    bufferLayer = L.geoJSON(processedPoly.buffered, {
      style: {
        fillColor: '#4f9cf7',
        fillOpacity: 0.05,
        color: '#fbbf24',
        weight: 2,
        dashArray: null
      }
    }).addTo(map);

    // Zoom to buffered bounds
    const bounds = Polygons.bboxToLatLngBounds(processedPoly.bbox);
    map.fitBounds(bounds, { padding: [30, 30] });
  }

  /**
   * Plot 311 records on the map
   * records: array of display records with _source field
   * typeColorMap: { complaintType: colorHex }
   */
  function plotRecords(records, typeColorMap) {
    clearMarkers();
    currentRecords = records;

    for (const rec of records) {
      if (!rec.latitude || !rec.longitude) continue;

      const sourceColor = COLORS[rec._source] || COLORS.opendata;
      const typeColor = typeColorMap[rec.complaint_type] || '#94a3b8';

      const marker = L.circleMarker([rec.latitude, rec.longitude], {
        radius: 6,
        fillColor: typeColor,
        fillOpacity: 0.8,
        color: sourceColor,
        weight: 2,
        opacity: 1
      });

      marker.bindPopup(() => buildPopup(rec), { maxWidth: 320, minWidth: 260 });
      marker.record = rec; // Store reference for filtering
      markersLayer.addLayer(marker);
    }

    // Show legend
    document.getElementById('map-legend').classList.remove('hidden');
  }

  /**
   * Build HTML popup for a record
   */
  function buildPopup(rec) {
    const statusClass = (rec.status || '').toLowerCase().replace(/\s+/g, '-');
    const sourceLabel = rec._source === 'matched' ? 'Both Sources' :
                        rec._source === 'portal' ? 'Portal Only' : 'Open Data Only';
    const sourceClass = rec._source === 'matched' ? 'source-matched' :
                        rec._source === 'portal' ? 'source-portal' : 'source-od';

    let html = `<div class="popup-title">${esc(rec.complaint_type || 'Unknown')}</div>`;

    if (rec.descriptor) {
      html += `<div class="popup-row"><span class="popup-label">Detail</span><span class="popup-value">${esc(rec.descriptor)}</span></div>`;
    }

    html += `<div class="popup-row"><span class="popup-label">Status</span><span class="popup-value"><span class="popup-badge ${statusClass}">${esc(rec.status || 'Unknown')}</span></span></div>`;

    if (rec.agency_name || rec.agency) {
      html += `<div class="popup-row"><span class="popup-label">Agency</span><span class="popup-value">${esc(rec.agency_name || rec.agency)}</span></div>`;
    }

    html += `<div class="popup-row"><span class="popup-label">Created</span><span class="popup-value">${formatDate(rec.created_date)}</span></div>`;

    if (rec.closed_date) {
      html += `<div class="popup-row"><span class="popup-label">Closed</span><span class="popup-value">${formatDate(rec.closed_date)}</span></div>`;
    }

    if (rec.incident_address) {
      html += `<div class="popup-row"><span class="popup-label">Address</span><span class="popup-value">${esc(rec.incident_address)}</span></div>`;
    }

    if (rec.community_board) {
      html += `<div class="popup-row"><span class="popup-label">Community Board</span><span class="popup-value">${esc(rec.community_board)}</span></div>`;
    }

    if (rec.open_data_channel_type) {
      html += `<div class="popup-row"><span class="popup-label">Channel</span><span class="popup-value">${esc(rec.open_data_channel_type)}</span></div>`;
    }

    html += `<div class="popup-row"><span class="popup-label">Source</span><span class="popup-value"><span class="popup-badge ${sourceClass}">${sourceLabel}</span></span></div>`;

    if (rec.srnumber) {
      html += `<div class="popup-row"><span class="popup-label">SR#</span><span class="popup-value">${esc(rec.srnumber)}</span></div>`;
    }

    if (rec.resolution_description) {
      const resTruncated = rec.resolution_description.length > 300
        ? rec.resolution_description.substring(0, 300) + '...'
        : rec.resolution_description;
      html += `<div class="popup-resolution"><strong>Resolution:</strong> ${esc(resTruncated)}</div>`;
    }

    if (rec.portalUrl) {
      html += `<a href="${rec.portalUrl}" target="_blank" class="popup-link">View on 311 Portal &rarr;</a>`;
    }

    return html;
  }

  /**
   * Update heatmap layer
   */
  function updateHeatmap(records) {
    if (heatLayer) {
      map.removeLayer(heatLayer);
      heatLayer = null;
    }

    const points = records
      .filter(r => r.latitude && r.longitude)
      .map(r => [r.latitude, r.longitude, 0.5]);

    heatLayer = L.heatLayer(points, {
      radius: 20,
      blur: 15,
      maxZoom: 16,
      gradient: { 0.2: '#60a5fa', 0.4: '#34d399', 0.6: '#fbbf24', 0.8: '#fb923c', 1: '#f87171' }
    });
  }

  /**
   * Show/hide heatmap
   */
  function toggleHeatmap(show) {
    if (!heatLayer) return;
    if (show) {
      map.addLayer(heatLayer);
      markersLayer.clearLayers(); // Hide pins when heatmap is on
    } else {
      map.removeLayer(heatLayer);
      // Re-plot current records
      if (currentRecords.length > 0) {
        // Caller should re-plot
      }
    }
  }

  function toggleParcels(show) {
    if (!parcelsLayer) return;
    if (show) map.addLayer(parcelsLayer);
    else map.removeLayer(parcelsLayer);
  }

  function toggleBuffer(show) {
    if (!bufferLayer) return;
    if (show) map.addLayer(bufferLayer);
    else map.removeLayer(bufferLayer);
  }

  function clearPolygonLayers() {
    if (parcelsLayer) { map.removeLayer(parcelsLayer); parcelsLayer = null; }
    if (bufferLayer) { map.removeLayer(bufferLayer); bufferLayer = null; }
  }

  function clearMarkers() {
    if (markersLayer) markersLayer.clearLayers();
    if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }
    currentRecords = [];
  }

  /**
   * Filter visible markers by complaint type set
   */
  function filterByTypes(activeTypes) {
    if (!markersLayer) return;
    markersLayer.eachLayer(marker => {
      if (marker.record) {
        // markercluster doesn't support hide/show, so we rebuild
      }
    });

    // Rebuild markers with only active types
    markersLayer.clearLayers();
    const filtered = currentRecords.filter(r => activeTypes.has(r.complaint_type));
    for (const rec of filtered) {
      if (!rec.latitude || !rec.longitude) continue;
      const sourceColor = COLORS[rec._source] || COLORS.opendata;
      const marker = L.circleMarker([rec.latitude, rec.longitude], {
        radius: 6,
        fillColor: App.getTypeColor(rec.complaint_type),
        fillOpacity: 0.8,
        color: sourceColor,
        weight: 2,
        opacity: 1
      });
      marker.bindPopup(() => buildPopup(rec), { maxWidth: 320, minWidth: 260 });
      marker.record = rec;
      markersLayer.addLayer(marker);
    }

    return filtered;
  }

  // Helpers
  function esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatDate(str) {
    if (!str) return '—';
    try {
      // Handle both formats
      if (str.includes('T')) {
        return new Date(str).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
      }
      // Portal format: M/D/YYYY H:MM:SS AM/PM
      return str.replace(/:\d{2}\s/, ' ');
    } catch (e) {
      return str;
    }
  }

  function getMap() { return map; }

  return {
    init, drawBIDPolygon, plotRecords, updateHeatmap, toggleHeatmap,
    toggleParcels, toggleBuffer, clearMarkers, clearPolygonLayers,
    filterByTypes, getMap, TYPE_COLORS, COLORS
  };
})();
