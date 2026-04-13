/**
 * map.js — Leaflet map rendering, layers, popups, category legend
 */
const MapView = (() => {
  let map;
  let parcelsLayer = null;
  let bufferLayer = null;
  let markersLayer = null;
  let heatLayer = null;
  let currentRecords = [];
  let currentTypeColorMap = {};
  let activeCategories = new Set();

  const MARKER_RADIUS = 8;
  const MARKER_STROKE = '#3a3a3a';
  const MARKER_STROKE_WEIGHT = 1.5;

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

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19
    }).addTo(map);

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
   * Draw BID polygon layers
   */
  function drawBIDPolygon(processedPoly) {
    clearPolygonLayers();
    if (!processedPoly) return;

    parcelsLayer = L.geoJSON(processedPoly.raw, {
      style: {
        fillColor: '#4f9cf7',
        fillOpacity: 0.15,
        color: '#4f9cf7',
        weight: 1,
        dashArray: '4 4'
      }
    }).addTo(map);

    bufferLayer = L.geoJSON(processedPoly.buffered, {
      style: {
        fillColor: '#4f9cf7',
        fillOpacity: 0.05,
        color: '#fbbf24',
        weight: 2,
        dashArray: null
      }
    }).addTo(map);

    const bounds = Polygons.bboxToLatLngBounds(processedPoly.bbox);
    map.fitBounds(bounds, { padding: [30, 30] });
  }

  /**
   * Plot records on the map — fill = complaint type color, stroke = dark gray
   */
  function plotRecords(records, typeColorMap) {
    clearMarkers();
    currentRecords = records;
    currentTypeColorMap = typeColorMap;
    activeCategories = new Set(Object.keys(typeColorMap));

    for (const rec of records) {
      if (!rec.latitude || !rec.longitude) continue;
      const typeColor = typeColorMap[rec.complaint_type] || '#94a3b8';
      addMarker(rec, typeColor);
    }

    document.getElementById('map-legend').classList.remove('hidden');
  }

  function addMarker(rec, typeColor) {
    const marker = L.circleMarker([rec.latitude, rec.longitude], {
      radius: MARKER_RADIUS,
      fillColor: typeColor,
      fillOpacity: 0.85,
      color: MARKER_STROKE,
      weight: MARKER_STROKE_WEIGHT,
      opacity: 1
    });
    marker.bindPopup(() => buildPopup(rec), { maxWidth: 320, minWidth: 260 });
    marker.record = rec;
    markersLayer.addLayer(marker);
  }

  /**
   * Build the interactive category legend
   */
  const MAX_LEGEND_ITEMS = 15;

  function buildCategoryLegend(typeCounts, typeColorMap) {
    const container = document.getElementById('legend-categories');
    container.innerHTML = '';

    const sorted = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);
    const topTypes = sorted.slice(0, MAX_LEGEND_ITEMS);
    const otherTypes = sorted.slice(MAX_LEGEND_ITEMS);
    const otherCount = otherTypes.reduce((sum, [, c]) => sum + c, 0);

    // Active categories includes ALL types (including "other")
    activeCategories = new Set(sorted.map(([type]) => type));

    for (const [type, count] of topTypes) {
      const color = typeColorMap[type] || '#94a3b8';
      const row = document.createElement('div');
      row.className = 'legend-cat-row';
      row.dataset.type = type;
      row.innerHTML = `<span class="legend-cat-dot" style="background:${color};"></span>` +
        `<span class="legend-cat-name" title="${esc(type)}">${esc(type)}</span>` +
        `<span class="legend-cat-count">${count}</span>`;
      row.addEventListener('click', () => toggleCategory(type));
      container.appendChild(row);
    }

    // "Other" row grouping remaining types
    if (otherCount > 0) {
      const otherTypeNames = otherTypes.map(([t]) => t);
      const row = document.createElement('div');
      row.className = 'legend-cat-row';
      row.dataset.type = '__other__';
      row.innerHTML = `<span class="legend-cat-dot" style="background:#94a3b8;"></span>` +
        `<span class="legend-cat-name" title="${otherTypeNames.length} more types">Other (${otherTypeNames.length} types)</span>` +
        `<span class="legend-cat-count">${otherCount}</span>`;
      row.addEventListener('click', () => {
        const allActive = otherTypeNames.every(t => activeCategories.has(t));
        for (const t of otherTypeNames) {
          if (allActive) activeCategories.delete(t);
          else activeCategories.add(t);
        }
        row.classList.toggle('inactive', !otherTypeNames.some(t => activeCategories.has(t)));
        rebuildMarkers();
        App.onCategoryChange(activeCategories);
      });
      container.appendChild(row);
    }

    // Wire select all / deselect all
    document.getElementById('legend-select-all').onclick = () => selectAllCategories(sorted.map(([t]) => t));
    document.getElementById('legend-deselect-all').onclick = () => deselectAllCategories();
  }

  function toggleCategory(type) {
    if (activeCategories.has(type)) {
      activeCategories.delete(type);
    } else {
      activeCategories.add(type);
    }
    updateCategoryVisuals();
    rebuildMarkers();
    App.onCategoryChange(activeCategories);
  }

  function selectAllCategories(allTypes) {
    activeCategories = new Set(allTypes || Object.keys(currentTypeColorMap));
    updateCategoryVisuals();
    rebuildMarkers();
    App.onCategoryChange(activeCategories);
  }

  function deselectAllCategories() {
    activeCategories.clear();
    updateCategoryVisuals();
    rebuildMarkers();
    App.onCategoryChange(activeCategories);
  }

  function updateCategoryVisuals() {
    document.querySelectorAll('.legend-cat-row').forEach(row => {
      row.classList.toggle('inactive', !activeCategories.has(row.dataset.type));
    });
  }

  /**
   * Rebuild markers based on active categories
   */
  function rebuildMarkers() {
    markersLayer.clearLayers();
    const filtered = currentRecords.filter(r => activeCategories.has(r.complaint_type));
    for (const rec of filtered) {
      if (!rec.latitude || !rec.longitude) continue;
      const typeColor = currentTypeColorMap[rec.complaint_type] || '#94a3b8';
      addMarker(rec, typeColor);
    }
  }

  function getActiveCategories() { return activeCategories; }

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
   * Heatmap
   */
  function updateHeatmap(records) {
    if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }
    const points = records.filter(r => r.latitude && r.longitude).map(r => [r.latitude, r.longitude, 0.5]);
    heatLayer = L.heatLayer(points, {
      radius: 20, blur: 15, maxZoom: 16,
      gradient: { 0.2: '#60a5fa', 0.4: '#34d399', 0.6: '#fbbf24', 0.8: '#fb923c', 1: '#f87171' }
    });
  }

  function toggleHeatmap(show) {
    if (!heatLayer) return;
    if (show) {
      map.addLayer(heatLayer);
      markersLayer.clearLayers();
    } else {
      map.removeLayer(heatLayer);
    }
  }

  function toggleParcels(show) {
    if (!parcelsLayer) return;
    if (show) map.addLayer(parcelsLayer); else map.removeLayer(parcelsLayer);
  }

  function toggleBuffer(show) {
    if (!bufferLayer) return;
    if (show) map.addLayer(bufferLayer); else map.removeLayer(bufferLayer);
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

  function getMap() { return map; }

  // Helpers
  function esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatDate(str) {
    if (!str) return '\u2014';
    try {
      if (str.includes('T')) {
        return new Date(str).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
      }
      return str.replace(/:\d{2}\s/, ' ');
    } catch (e) { return str; }
  }

  return {
    init, drawBIDPolygon, plotRecords, buildCategoryLegend, updateHeatmap,
    toggleHeatmap, toggleParcels, toggleBuffer, clearMarkers, clearPolygonLayers,
    rebuildMarkers, getActiveCategories, getMap, TYPE_COLORS
  };
})();
