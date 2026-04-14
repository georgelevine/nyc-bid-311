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
      zoomControl: false         // add manually so we can position it
      // preferCanvas removed — it breaks marker-cluster spiderfy for circleMarker
    });

    // Zoom controls — bottom-left so they never collide with the header, legend FAB,
    // or the mobile drawer handle.
    L.control.zoom({ position: 'bottomleft' }).addTo(map);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19
    }).addTo(map);

    markersLayer = L.markerClusterGroup({
      chunkedLoading: true,
      maxClusterRadius: (zoom) => zoom >= 17 ? 20 : zoom >= 14 ? 40 : 50,
      spiderfyOnMaxZoom: false,     // we handle overlap via stacked popups instead
      showCoverageOnHover: false,
      zoomToBoundsOnClick: true,
      // Uniform neutral cluster — complaint colors only apply to individual pins.
      iconCreateFunction: (cluster) => {
        const count = cluster.getChildCount();
        const size = count >= 100 ? 44 : count >= 25 ? 40 : 36;
        return L.divIcon({
          html: `<div class="cluster-inner"><span>${count}</span></div>`,
          className: 'cluster-neutral',
          iconSize: L.point(size, size)
        });
      }
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
   * Plot records on the map. Records sharing the same lat/lng are grouped into ONE
   * marker with a paginated popup ("1 of N", Next/Prev), NOT spiderfied.
   */
  function plotRecords(records, typeColorMap) {
    clearMarkers();
    currentRecords = records;
    currentTypeColorMap = typeColorMap;

    // Group by rounded coords (~1-meter bucket) so true duplicates share a marker
    const groups = new Map();
    for (const rec of records) {
      if (rec.latitude == null || rec.longitude == null) continue;
      const key = `${rec.latitude.toFixed(6)},${rec.longitude.toFixed(6)}`;
      if (!groups.has(key)) groups.set(key, { lat: rec.latitude, lng: rec.longitude, records: [] });
      groups.get(key).records.push(rec);
    }

    for (const group of groups.values()) {
      const primary = group.records[0];
      const typeColor = typeColorMap[primary.complaint_type] || '#94a3b8';
      addStackedMarker(group, typeColor);
    }

    const legend = document.getElementById('map-legend');
    legend.classList.remove('hidden');
    if (window.matchMedia('(max-width: 768px)').matches) {
      legend.dataset.state = 'closed';
    }
  }

  /**
   * One marker per unique location. If the group has multiple records, the popup
   * paginates through them. A small "N" badge on the marker indicates stack size.
   */
  function addStackedMarker(group, typeColor) {
    const count = group.records.length;
    const marker = L.circleMarker([group.lat, group.lng], {
      radius: count > 1 ? MARKER_RADIUS + 2 : MARKER_RADIUS,
      fillColor: typeColor,
      fillOpacity: 0.9,
      color: count > 1 ? '#fff' : MARKER_STROKE,
      weight: count > 1 ? 2 : MARKER_STROKE_WEIGHT,
      opacity: 1
    });

    // Paging state is per-popup; store index on the marker
    marker._pageIdx = 0;
    marker._group = group;

    marker.bindPopup(() => buildStackedPopup(marker), {
      maxWidth: 340,
      minWidth: 280,
      keepInView: true,
      autoPan: true
    });

    markersLayer.addLayer(marker);
  }

  /**
   * Build the popup HTML for a stacked marker. Shows "i of N" and Next/Prev when N > 1.
   */
  function buildStackedPopup(marker) {
    const group = marker._group;
    const idx = Math.max(0, Math.min(marker._pageIdx, group.records.length - 1));
    const rec = group.records[idx];
    const count = group.records.length;

    const pager = count > 1
      ? `<div class="popup-pager">
           <button class="pager-btn pager-prev" aria-label="Previous complaint" ${idx === 0 ? 'disabled' : ''}>&lsaquo;</button>
           <span class="pager-count">Complaint <strong>${idx + 1}</strong> of <strong>${count}</strong></span>
           <button class="pager-btn pager-next" aria-label="Next complaint" ${idx === count - 1 ? 'disabled' : ''}>&rsaquo;</button>
         </div>`
      : '';

    // Defer wiring until Leaflet injects the popup DOM
    setTimeout(() => {
      const root = document.querySelector('.leaflet-popup-content');
      if (!root) return;
      const prev = root.querySelector('.pager-prev');
      const next = root.querySelector('.pager-next');
      if (prev) prev.onclick = (e) => { e.stopPropagation(); if (marker._pageIdx > 0) { marker._pageIdx--; marker.setPopupContent(buildStackedPopup(marker)); } };
      if (next) next.onclick = (e) => { e.stopPropagation(); if (marker._pageIdx < count - 1) { marker._pageIdx++; marker.setPopupContent(buildStackedPopup(marker)); } };
    }, 0);

    return pager + buildPopupForRecord(rec);
  }

  /**
   * Build the interactive category legend
   */
  const MAX_LEGEND_ITEMS = 15;

  /**
   * Click-to-isolate category list. No checkboxes.
   *   - Clicking a type sets App.setFilter('complaintType', type) — map isolates to that type.
   *   - Clicking the same type again clears the filter (shows all).
   *   - "Show all" button also clears.
   *   - The currently isolated type is highlighted; others dim.
   */
  function buildCategoryLegend(typeCounts, typeColorMap, isolatedType) {
    const container = document.getElementById('legend-categories');
    container.innerHTML = '';

    const sorted = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);
    const topTypes = sorted.slice(0, MAX_LEGEND_ITEMS);
    const otherTypes = sorted.slice(MAX_LEGEND_ITEMS);
    const otherCount = otherTypes.reduce((sum, [, c]) => sum + c, 0);

    const hasIsolation = !!isolatedType;

    function renderRow(type, displayName, count, color, onClick) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'legend-cat-row';
      row.dataset.type = type;
      const isActive = !hasIsolation || type === isolatedType;
      row.innerHTML =
        `<span class="legend-cat-dot" style="background:${color};"></span>` +
        `<span class="legend-cat-name" title="${Utils.esc(displayName)}">${Utils.esc(displayName)}</span>` +
        `<span class="legend-cat-count">${count}</span>`;
      row.classList.toggle('isolated', type === isolatedType);
      row.classList.toggle('inactive', hasIsolation && type !== isolatedType);
      row.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
      container.appendChild(row);
      return row;
    }

    for (const [type, count] of topTypes) {
      const color = typeColorMap[type] || '#94a3b8';
      renderRow(type, type, count, color, () => App.setFilter('complaintType', type));
    }

    if (otherCount > 0) {
      // "Other" lets the user isolate to any of the less-common types via a sub-menu prompt.
      const names = otherTypes.map(([t]) => t);
      renderRow('__other__', `Other (${names.length} types)`, otherCount, '#94a3b8', () => {
        // Quick-and-dirty: prompt to pick one. A real submenu would be a follow-up.
        const pick = window.prompt(`Filter to which complaint type?\n\n${names.join('\n')}\n\n(Leave blank to cancel.)`);
        if (pick && names.includes(pick)) App.setFilter('complaintType', pick);
      });
    }

    document.getElementById('legend-select-all').onclick = () => App.clearFilter('complaintType');
    document.getElementById('legend-deselect-all').onclick = () => App.clearFilter('complaintType');
  }

  /**
   * Build HTML popup for a single record
   */
  function buildPopupForRecord(rec) {
    const statusClass = (rec.status || '').toLowerCase().replace(/\s+/g, '-');
    const sourceLabel = rec._source === 'matched' ? 'Both Sources' :
                        rec._source === 'portal' ? 'Portal Only' : 'Open Data Only';
    const sourceClass = rec._source === 'matched' ? 'source-matched' :
                        rec._source === 'portal' ? 'source-portal' : 'source-od';

    let html = `<div class="popup-title">${Utils.esc(rec.complaint_type || 'Unknown')}</div>`;

    if (rec.descriptor) {
      html += `<div class="popup-row"><span class="popup-label">Detail</span><span class="popup-value">${Utils.esc(rec.descriptor)}</span></div>`;
    }

    html += `<div class="popup-row"><span class="popup-label">Status</span><span class="popup-value"><span class="popup-badge ${statusClass}">${Utils.esc(rec.status || 'Unknown')}</span></span></div>`;

    if (rec.agency_name || rec.agency) {
      html += `<div class="popup-row"><span class="popup-label">Agency</span><span class="popup-value">${Utils.esc(rec.agency_name || rec.agency)}</span></div>`;
    }

    html += `<div class="popup-row"><span class="popup-label">Created</span><span class="popup-value">${formatDate(rec.created_date)}</span></div>`;

    if (rec.closed_date) {
      html += `<div class="popup-row"><span class="popup-label">Closed</span><span class="popup-value">${formatDate(rec.closed_date)}</span></div>`;
    }

    if (rec.incident_address) {
      html += `<div class="popup-row"><span class="popup-label">Address</span><span class="popup-value">${Utils.esc(rec.incident_address)}</span></div>`;
    }

    if (rec.community_board) {
      html += `<div class="popup-row"><span class="popup-label">Community Board</span><span class="popup-value">${Utils.esc(rec.community_board)}</span></div>`;
    }

    if (rec.open_data_channel_type) {
      html += `<div class="popup-row"><span class="popup-label">Channel</span><span class="popup-value">${Utils.esc(rec.open_data_channel_type)}</span></div>`;
    }

    html += `<div class="popup-row"><span class="popup-label">Source</span><span class="popup-value"><span class="popup-badge ${sourceClass}">${sourceLabel}</span></span></div>`;

    if (rec.srnumber) {
      html += `<div class="popup-row"><span class="popup-label">SR#</span><span class="popup-value">${Utils.esc(rec.srnumber)}</span></div>`;
    }

    if (rec.resolution_description) {
      const resTruncated = rec.resolution_description.length > 300
        ? rec.resolution_description.substring(0, 300) + '...'
        : rec.resolution_description;
      html += `<div class="popup-resolution"><strong>Resolution:</strong> ${Utils.esc(resTruncated)}</div>`;
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
    getMap, TYPE_COLORS
  };
})();
