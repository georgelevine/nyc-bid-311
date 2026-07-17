/**
 * map.js — Leaflet map rendering, layers, popups, category legend
 */
const MapView = (() => {
  let map;
  let bidOverviewLayer = null;
  let bidOverviewFeatures = [];
  let selectedBIDIndex = null;
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
      zoomControl: false,        // add manually so we can position it
      doubleClickZoom: true,
      touchZoom: true
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
        const count = cluster.getAllChildMarkers()
          .reduce((sum, marker) => sum + (marker._recordCount || 1), 0);
        const size = count >= 100 ? 44 : count >= 25 ? 40 : 36;
        return L.divIcon({
          html: `<div class="cluster-inner"><span>${count}</span></div>`,
          className: 'cluster-neutral',
          iconSize: L.point(size, size)
        });
      }
    });
    map.addLayer(markersLayer);
    installMobileDoubleTapZoom();

    return map;
  }

  function installMobileDoubleTapZoom() {
    const hasTouch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
    if (!hasTouch) return;

    map.doubleClickZoom.disable();
    const container = map.getContainer();
    let touchStart = null;
    let touchMoved = false;
    let lastTap = null;
    let consumeTouch = false;

    const touchPoint = (touch) => {
      const rect = container.getBoundingClientRect();
      return L.point(touch.clientX - rect.left, touch.clientY - rect.top);
    };
    const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const isMapGesture = (target) => target instanceof Element && !target.closest(
      '#map-legend, .leaflet-control, .leaflet-popup, .leaflet-tooltip'
    );

    container.addEventListener('touchstart', (event) => {
      if (event.touches.length !== 1 || !isMapGesture(event.target)) {
        touchStart = null;
        touchMoved = false;
        lastTap = null;
        return;
      }

      const now = Date.now();
      const point = touchPoint(event.touches[0]);
      if (lastTap && now - lastTap.time < 350 && distance(lastTap.point, point) < 40) {
        // Capture the second tap before Leaflet turns it into a click or drag.
        event.preventDefault();
        event.stopImmediatePropagation();
        map.stop();
        map.setZoomAround(point, Math.min(map.getZoom() + 1, map.getMaxZoom()));
        touchStart = null;
        lastTap = null;
        consumeTouch = true;
        return;
      }

      touchStart = { point, time: now };
      touchMoved = false;
      consumeTouch = false;
    }, { passive: false, capture: true });

    container.addEventListener('touchmove', (event) => {
      if (!touchStart || event.touches.length !== 1) return;
      if (distance(touchStart.point, touchPoint(event.touches[0])) > 12) touchMoved = true;
    }, { passive: true, capture: true });

    container.addEventListener('touchend', (event) => {
      if (consumeTouch) {
        event.preventDefault();
        event.stopImmediatePropagation();
        consumeTouch = false;
        return;
      }

      if (!touchStart || touchMoved || event.changedTouches.length !== 1) {
        touchStart = null;
        return;
      }

      const now = Date.now();
      const point = touchPoint(event.changedTouches[0]);
      const wasQuickTap = now - touchStart.time < 350;
      touchStart = null;
      if (!wasQuickTap) {
        lastTap = null;
        return;
      }

      lastTap = { point, time: now };
    }, { passive: false, capture: true });

    container.addEventListener('touchcancel', () => {
      touchStart = null;
      touchMoved = false;
      lastTap = null;
      consumeTouch = false;
    }, { passive: true, capture: true });
  }

  /**
   * Draw every BID as a lightweight, clickable overview layer.
   */
  function drawBIDOverview(geojson, onSelect) {
    if (bidOverviewLayer) map.removeLayer(bidOverviewLayer);
    bidOverviewFeatures = [];
    selectedBIDIndex = null;

    const featureIndexes = new Map(geojson.features.map((feature, index) => [feature, index]));
    bidOverviewLayer = L.geoJSON(geojson, {
      style: (feature) => overviewStyle(featureIndexes.get(feature)),
      onEachFeature: (feature, layer) => {
        const index = featureIndexes.get(feature);
        const name = feature.properties.f_all_bi_2 || `BID ${index}`;
        bidOverviewFeatures[index] = layer;
        layer.bindTooltip(name, {
          className: 'bid-map-tooltip',
          direction: 'top',
          sticky: true,
          opacity: 1
        });
        layer.on({
          mouseover: () => {
            if (index === selectedBIDIndex) {
              layer.closeTooltip();
              return;
            }
            if (index !== selectedBIDIndex) layer.setStyle(overviewStyle(index, false, true));
            layer.bringToFront();
          },
          mouseout: () => {
            layer.setStyle(overviewStyle(index, index === selectedBIDIndex));
          },
          click: (event) => {
            L.DomEvent.stopPropagation(event);
            layer.closeTooltip();
            if (index === selectedBIDIndex) return;
            if (typeof onSelect === 'function') onSelect(index);
          },
          dblclick: (event) => {
            L.DomEvent.stopPropagation(event);
            layer.closeTooltip();
            const nextZoom = Math.min(map.getZoom() + 1, map.getMaxZoom());
            map.setView(event.latlng, nextZoom, { animate: true });
          }
        });
      }
    }).addTo(map);

    if (bidOverviewLayer.getBounds().isValid()) {
      const bounds = bidOverviewLayer.getBounds();
      const overviewZoom = map.getContainer().clientWidth <= 768 ? 10 : 11;
      map.setView(bounds.getCenter(), overviewZoom, { animate: false });
    }
  }

  function overviewStyle(index, selected = false, hovered = false) {
    const dimmed = selectedBIDIndex !== null && !selected;
    return {
      fillColor: '#4f9cf7',
      fillOpacity: selected ? 0.28 : hovered ? 0.12 : dimmed ? 0.015 : 0.08,
      color: selected ? '#fbbf24' : hovered ? '#8cc4ff' : '#4f9cf7',
      opacity: selected ? 1 : hovered ? 0.78 : dimmed ? 0.25 : 0.92,
      weight: selected ? 2.5 : hovered ? 1.8 : dimmed ? 1 : 1.2,
      className: 'bid-overview-boundary'
    };
  }

  function setSelectedBID(index) {
    selectedBIDIndex = index;
    for (let i = 0; i < bidOverviewFeatures.length; i++) {
      const layer = bidOverviewFeatures[i];
      if (!layer) continue;
      layer.closeTooltip();
      if (!bidOverviewLayer.hasLayer(layer)) bidOverviewLayer.addLayer(layer);
      if (i === index) {
        layer.setStyle(overviewStyle(i, true));
        layer.bringToFront();
      } else {
        layer.setStyle(overviewStyle(i));
      }
    }
  }

  /**
   * Draw BID polygon layers
   */
  function drawBIDPolygon(processedPoly, bidIndex) {
    clearPolygonLayers();
    if (!processedPoly) return;

    setSelectedBID(bidIndex);

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
    marker._recordCount = count;

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
    const sourceLabel = '311 Portal';
    const sourceClass = 'source-portal';

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
    init, drawBIDOverview, drawBIDPolygon, plotRecords, buildCategoryLegend, updateHeatmap,
    toggleHeatmap, toggleParcels, toggleBuffer, clearMarkers, clearPolygonLayers,
    getMap, TYPE_COLORS
  };
})();
