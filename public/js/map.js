/**
 * map.js — Leaflet map rendering, layers, popups, category legend
 */
const MapView = (() => {
  let map;
  let bidOverviewLayer = null;
  let bidOverviewFeatures = [];
  let selectedBIDIndex = null;
  let touchPreviewBIDIndex = null;
  let parcelsLayer = null;
  let bufferLayer = null;
  let selectedBIDBounds = null;
  let markersLayer = null;
  let heatLayer = null;
  let currentRecords = [];
  let currentTypeColorMap = {};
  let activeCategories = new Set();
  let desktopHoverPopupMarker = null;
  let mapResizeObserver = null;
  let mapLayoutFrame = null;

  const MARKER_RADIUS = 8;
  const MARKER_STROKE = '#3a3a3a';
  const MARKER_STROKE_WEIGHT = 1.5;

  // Color palette for complaint types
  const TYPE_COLORS = [
    '#f87171', '#fb923c', '#fbbf24', '#34d399', '#22d3ee',
    '#60a5fa', '#a78bfa', '#f472b6', '#a3e635', '#e879f9',
    '#94a3b8', '#fca5a5', '#fdba74', '#fde047', '#6ee7b7'
  ];

  function isMobileLayout() {
    return window.matchMedia('(max-width: 768px)').matches;
  }

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
    if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      document.addEventListener('mousemove', handleDesktopPopupPointerMove, { passive: true });
    }
    installResponsiveMapLayout();

    return map;
  }

  function installResponsiveMapLayout() {
    const container = map.getContainer();
    if (typeof ResizeObserver !== 'undefined') {
      mapResizeObserver = new ResizeObserver(scheduleMapLayoutFit);
      mapResizeObserver.observe(container);
    }
    window.addEventListener('resize', scheduleMapLayoutFit, { passive: true });
    window.addEventListener('load', scheduleMapLayoutFit, { once: true });
    scheduleMapLayoutFit();
  }

  function scheduleMapLayoutFit() {
    if (!map) return;
    if (mapLayoutFrame !== null) window.cancelAnimationFrame(mapLayoutFrame);
    mapLayoutFrame = window.requestAnimationFrame(() => {
      mapLayoutFrame = null;
      map.invalidateSize({ pan: false, debounceMoveend: true });
      if (selectedBIDBounds) fitSelectedBID();
    });
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
      '#map-legend, .leaflet-control, .leaflet-popup, .leaflet-tooltip, .bid-overview-boundary'
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
   * Draw every BID's gap-filled boundary as a lightweight, clickable overview layer.
   */
  function drawBIDOverview(geojson, onSelect) {
    closeTouchPreview();
    if (bidOverviewLayer) map.removeLayer(bidOverviewLayer);
    bidOverviewFeatures = [];
    selectedBIDIndex = null;
    touchPreviewBIDIndex = null;

    const boundaryOverview = {
      type: 'FeatureCollection',
      features: geojson.features.map((feature, index) => {
        const processed = Polygons.processFeature(feature);
        const displayFeature = processed ? processed.buffered : feature;
        return {
          type: 'Feature',
          properties: { ...(feature.properties || {}), __bidIndex: index },
          geometry: displayFeature.geometry
        };
      })
    };

    bidOverviewLayer = L.geoJSON(boundaryOverview, {
      style: (feature) => overviewStyle(feature.properties.__bidIndex),
      onEachFeature: (feature, layer) => {
        const index = feature.properties.__bidIndex;
        const name = feature.properties.f_all_bi_2 || `BID ${index}`;
        bidOverviewFeatures[index] = layer;
        layer.on('add', () => {
          const element = layer.getElement();
          if (element) element.style.pointerEvents = 'all';
        });
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
            const resolvedIndex = Polygons.resolveOwnerIndex(event.latlng.lng, event.latlng.lat);
            const targetIndex = resolvedIndex == null ? index : resolvedIndex;
            const targetLayer = bidOverviewFeatures[targetIndex] || layer;
            if (targetIndex === selectedBIDIndex) return;

            if (isTouchDevice() && touchPreviewBIDIndex !== targetIndex) {
              closeTouchPreview();
              touchPreviewBIDIndex = targetIndex;
              targetLayer.openTooltip(event.latlng);
              return;
            }

            touchPreviewBIDIndex = null;
            targetLayer.closeTooltip();
            if (typeof onSelect === 'function') onSelect(targetIndex);
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

    map.off('click', closeTouchPreview);
    map.on('click', closeTouchPreview);

    if (bidOverviewLayer.getBounds().isValid()) {
      const bounds = bidOverviewLayer.getBounds();
      const overviewZoom = isMobileLayout() ? 10 : 11;
      map.setView(bounds.getCenter(), overviewZoom, { animate: false });
    }
  }

  function isTouchDevice() {
    return navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
  }

  function closeTouchPreview() {
    if (touchPreviewBIDIndex === null) return;
    const layer = bidOverviewFeatures[touchPreviewBIDIndex];
    if (layer) layer.closeTooltip();
    touchPreviewBIDIndex = null;
  }

  function overviewStyle(index, selected = false, hovered = false) {
    const dimmed = selectedBIDIndex !== null && !selected;
    return {
      fill: true,
      fillColor: '#4f9cf7',
      fillOpacity: selected ? 0.28 : hovered ? 0.12 : dimmed ? 0.015 : 0.08,
      color: selected ? '#fbbf24' : hovered ? '#8cc4ff' : '#4f9cf7',
      opacity: selected ? 1 : hovered ? 0.78 : dimmed ? 0.25 : 0.92,
      weight: selected ? 2.5 : hovered ? 1.8 : dimmed ? 1 : 1.2,
      className: 'bid-overview-boundary'
    };
  }

  function setSelectedBID(index) {
    closeTouchPreview();
    selectedBIDIndex = index;
    for (let i = 0; i < bidOverviewFeatures.length; i++) {
      const layer = bidOverviewFeatures[i];
      if (!layer) continue;
      layer.closeTooltip();
      if (i === index) {
        if (bidOverviewLayer.hasLayer(layer)) bidOverviewLayer.removeLayer(layer);
      } else {
        if (!bidOverviewLayer.hasLayer(layer)) bidOverviewLayer.addLayer(layer);
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

    const displayBoundary = processedPoly.displayBoundary || processedPoly.buffered;
    const boundaryCasing = L.geoJSON(displayBoundary, {
      interactive: false,
      style: {
        fill: false,
        color: '#111827',
        opacity: 0.9,
        weight: 6,
        lineCap: 'round',
        lineJoin: 'round'
      }
    });
    const boundarySurface = L.geoJSON(displayBoundary, {
      interactive: false,
      style: {
        fillColor: '#4f9cf7',
        fillOpacity: 0.06,
        color: '#fbbf24',
        opacity: 1,
        weight: 2.5,
        lineCap: 'round',
        lineJoin: 'round'
      }
    });
    bufferLayer = L.layerGroup([boundaryCasing, boundarySurface]).addTo(map);

    selectedBIDBounds = Polygons.bboxToLatLngBounds(processedPoly.bbox);
    fitSelectedBID();
  }

  function fitSelectedBID() {
    if (!selectedBIDBounds || !selectedBIDBounds.isValid()) return;

    const mapContainer = map.getContainer();
    const mapRect = mapContainer.getBoundingClientRect();
    const mobile = isMobileLayout();
    const sidebar = document.getElementById('sidebar');
    const sidebarState = sidebar ? sidebar.dataset.state : null;
    if (mobile && sidebarState === 'full') return;

    let coveredHeight = 0;
    let coveredWidth = 0;
    if (mobile && sidebar && sidebarState !== 'closed') {
      const sidebarRect = sidebar.getBoundingClientRect();
      coveredHeight = Math.max(0, mapRect.bottom - Math.max(mapRect.top, sidebarRect.top));
    }
    if (!mobile) {
      const legend = document.getElementById('map-legend');
      if (legend && !legend.classList.contains('hidden') && legend.dataset.state === 'open') {
        const legendRect = legend.getBoundingClientRect();
        coveredWidth = Math.max(0, mapRect.right - Math.max(mapRect.left, legendRect.left));
      }
    }

    const edge = mobile ? 20 : 30;
    map.fitBounds(selectedBIDBounds, {
      paddingTopLeft: [edge, edge],
      paddingBottomRight: [edge + coveredWidth, edge + coveredHeight],
      maxZoom: mobile ? 17 : 18,
      animate: false
    });
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
    const legendWasHidden = legend.classList.contains('hidden');
    legend.classList.remove('hidden');
    if (legendWasHidden) scheduleMapLayoutFit();
  }

  function focusRecord(record) {
    if (!record || !markersLayer) return;
    let targetMarker = null;
    let targetIndex = 0;

    markersLayer.eachLayer(marker => {
      if (targetMarker || !marker._group) return;
      const index = marker._group.records.findIndex(candidate =>
        candidate === record ||
        (record.portalId && candidate.portalId === record.portalId) ||
        (record.srnumber && candidate.srnumber === record.srnumber)
      );
      if (index >= 0) {
        targetMarker = marker;
        targetIndex = index;
      }
    });
    if (!targetMarker) return;

    const targetZoom = Math.min(map.getMaxZoom(), Math.max(map.getZoom(), 18));
    map.invalidateSize({ pan: false });
    map.setView(targetMarker.getLatLng(), targetZoom, { animate: false });

    const open = () => {
      targetMarker._pageIdx = targetIndex;
      targetMarker._popupPinned = true;
      targetMarker.getPopup().options.autoPan = true;
      targetMarker.openPopup();
      const popupElement = targetMarker.getPopup().getElement();
      if (popupElement) popupElement.classList.remove('hover-preview');
    };

    if (markersLayer.zoomToShowLayer) markersLayer.zoomToShowLayer(targetMarker, open);
    else open();
  }

  /**
   * One marker per unique location. If the group has multiple records, the popup
   * paginates through them. A small "N" badge on the marker indicates stack size.
   */
  function addStackedMarker(group, typeColor) {
    const count = group.records.length;
    const useTouchTarget = isMobileLayout() ||
      window.matchMedia('(pointer: coarse)').matches;
    const marker = useTouchTarget
      ? L.marker([group.lat, group.lng], {
          icon: L.divIcon({
            className: 'case-touch-target',
            html: `<span class="case-touch-dot${count > 1 ? ' stacked' : ''}" style="--case-color:${typeColor}">${count > 1 ? count : ''}</span>`,
            iconSize: [44, 44],
            iconAnchor: [22, 22],
            popupAnchor: [0, -13]
          }),
          keyboard: true,
          riseOnHover: true,
          title: group.records[0].complaint_type || '311 request'
        })
      : L.circleMarker([group.lat, group.lng], {
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
      autoPan: true,
      autoPanPaddingTopLeft: useTouchTarget ? L.point(16, 72) : L.point(16, 16),
      autoPanPaddingBottomRight: useTouchTarget ? L.point(16, 96) : L.point(16, 16)
    });

    installDesktopHoverPopup(marker);

    markersLayer.addLayer(marker);
  }

  function installDesktopHoverPopup(marker) {
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

    marker._popupPinned = false;
    marker._popupHovered = false;
    marker._popupCloseTimer = null;

    const cancelClose = () => {
      if (marker._popupCloseTimer !== null) {
        window.clearTimeout(marker._popupCloseTimer);
        marker._popupCloseTimer = null;
      }
    };
    const scheduleClose = () => {
      if (marker._popupCloseTimer !== null) return;
      marker._popupCloseTimer = window.setTimeout(() => {
        marker._popupCloseTimer = null;
        if (!marker._popupPinned && !marker._popupHovered) marker.closePopup();
      }, 100);
    };
    marker._scheduleHoverPopupClose = scheduleClose;

    const openHoverPopup = () => {
      cancelClose();
      desktopHoverPopupMarker = marker;
      marker.getPopup().options.autoPan = false;
      if (!marker.isPopupOpen || !marker.isPopupOpen()) marker.openPopup();
      const popupElement = marker.getPopup().getElement();
      if (popupElement) popupElement.classList.add('hover-preview');
    };
    marker.on('mouseover', openHoverPopup);
    marker.on('mouseout', scheduleClose);
    marker.on('add', () => {
      const element = marker.getElement();
      if (!element || element._bidHoverBound) return;
      element._bidHoverBound = true;
      element.addEventListener('mouseenter', openHoverPopup);
      element.addEventListener('mouseleave', scheduleClose);
    });
    marker.on('click', () => {
      cancelClose();
      marker._popupPinned = true;
      marker.getPopup().options.autoPan = true;
      marker.openPopup();
      const popupElement = marker.getPopup().getElement();
      if (popupElement) popupElement.classList.remove('hover-preview');
    });
    marker.on('popupopen', () => {
      const element = marker.getPopup().getElement();
      if (!element) return;
      element.classList.toggle('hover-preview', !marker._popupPinned);
      element.onmouseenter = () => {
        marker._popupHovered = true;
        cancelClose();
      };
      element.onmouseleave = () => {
        marker._popupHovered = false;
        scheduleClose();
      };
      element.onpointerdown = () => {
        marker._popupPinned = true;
        element.classList.remove('hover-preview');
        cancelClose();
      };
    });
    marker.on('popupclose', () => {
      cancelClose();
      marker._popupPinned = false;
      marker._popupHovered = false;
      if (desktopHoverPopupMarker === marker) desktopHoverPopupMarker = null;
      marker.getPopup().options.autoPan = true;
    });
  }

  function handleDesktopPopupPointerMove(event) {
    const marker = desktopHoverPopupMarker;
    if (!marker || marker._popupPinned || marker._popupHovered) return;
    const markerElement = marker.getElement();
    const popupElement = marker.getPopup().getElement();
    if (markerElement && markerElement.contains(event.target)) return;
    if (popupElement && popupElement.contains(event.target)) return;
    if (marker._scheduleHoverPopupClose) marker._scheduleHoverPopupClose();
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
      hydratePopupDetails(rec);
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
    const reported = formatDate(rec.created_date);
    const age = formatRelativeAge(rec.created_date);

    let html = `<div class="popup-case-header">
      <div>
        <div class="popup-title">${Utils.esc(rec.complaint_type || 'Unknown')}</div>
        ${rec.srnumber ? `<div class="popup-case-number">${Utils.esc(rec.srnumber)}</div>` : ''}
      </div>
      <span class="popup-badge ${statusClass}">${Utils.esc(rec.status || 'Unknown')}</span>
    </div>`;

    if (rec.incident_address) {
      html += `<div class="popup-address">${Utils.esc(rec.incident_address)}</div>`;
    }

    html += `<div class="popup-facts">
      <div class="popup-fact"><span>Reported</span><strong>${Utils.esc(reported)}</strong></div>
      ${age ? `<div class="popup-fact"><span>Age</span><strong>${Utils.esc(age)}</strong></div>` : ''}
    </div>`;

    if (rec.portalId) {
      html += `<div class="popup-enrichment" data-portal-id="${Utils.esc(rec.portalId)}"><span class="popup-detail-loading">Loading case details...</span></div>`;
    }

    html += '<div class="popup-case-footer"><span>Live NYC311 Portal</span>';
    if (rec.portalUrl) {
      html += `<a href="${rec.portalUrl}" target="_blank" rel="noopener" class="popup-link">Open full case &rarr;</a>`;
    }
    html += '</div>';
    return html;
  }

  async function hydratePopupDetails(rec) {
    if (!rec.portalId || !Data.fetchPortalDetail) return;

    const findTarget = () => {
      const root = document.querySelector('.leaflet-popup-content');
      if (!root) return null;
      return Array.from(root.querySelectorAll('.popup-enrichment'))
        .find(el => el.dataset.portalId === rec.portalId) || null;
    };
    const loadingTimeout = window.setTimeout(() => {
      const target = findTarget();
      if (target && target.querySelector('.popup-detail-loading')) {
        target.innerHTML = '<span class="popup-detail-unavailable">No additional case details were provided.</span>';
      }
    }, 8500);

    let detail = null;
    try {
      detail = await Data.fetchPortalDetail(rec.portalId);
    } catch (err) {
      detail = null;
    } finally {
      window.clearTimeout(loadingTimeout);
    }

    const target = findTarget();
    if (!target) return;

    if (!detail) {
      target.innerHTML = '<span class="popup-detail-unavailable">Additional case details are currently unavailable.</span>';
      return;
    }

    const rows = [];
    const useful = value => value && !['n/a', 'none', 'not available'].includes(String(value).trim().toLowerCase());
    const reportedTime = parseTimestamp(detail.dateReported || rec.created_date);
    const updatedTime = parseTimestamp(detail.updatedOn);
    const updateIsMeaningful = updatedTime && (!reportedTime || updatedTime - reportedTime >= 60000);
    const nextUpdateMatch = useful(detail.nextUpdate) && String(detail.nextUpdate).trim().match(/^(-?\d+)/);
    const nextUpdateIsUseful = useful(detail.nextUpdate) && (!nextUpdateMatch || Number(nextUpdateMatch[1]) > 0);
    if (useful(detail.problemDetails)) rows.push(['Problem details', detail.problemDetails]);
    if (useful(detail.additionalDetails)) rows.push(['Additional details', detail.additionalDetails]);
    if (updateIsMeaningful) rows.push(['Portal updated', formatDate(detail.updatedOn)]);
    if (detail.dateClosed) rows.push(['Closed', formatDate(detail.dateClosed)]);
    if (!detail.dateClosed && nextUpdateIsUseful) rows.push(['Next update', detail.nextUpdate]);

    if (rows.length === 0) {
      target.innerHTML = '<span class="popup-detail-unavailable">No additional case details were provided.</span>';
      return;
    }
    target.innerHTML = rows.map(([label, value]) =>
      `<div class="popup-detail-row"><span>${Utils.esc(label)}</span><strong>${Utils.esc(value)}</strong></div>`
    ).join('');
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
  function parseTimestamp(str) {
    if (!str) return null;
    const text = String(str).trim();
    const portalDate = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i);
    if (portalDate) {
      const [, month, day, year, rawHour, minute, second, period] = portalDate;
      let hour = Number(rawHour) % 12;
      if (period.toUpperCase() === 'PM') hour += 12;
      return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), hour, Number(minute), Number(second)));
    }

    const parsed = new Date(text);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }

  function formatDate(str) {
    if (!str) return '\u2014';
    try {
      const date = parseTimestamp(str);
      if (!date) return str;
      return new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short'
      }).format(date);
    } catch (e) { return str; }
  }

  function formatRelativeAge(str) {
    if (!str) return null;
    const parsed = parseTimestamp(str);
    const timestamp = parsed && parsed.getTime();
    if (!Number.isFinite(timestamp)) return null;
    const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours} hr`;
    return `${Math.floor(hours / 24)} days`;
  }

  return {
    init, drawBIDOverview, drawBIDPolygon, plotRecords, buildCategoryLegend, updateHeatmap,
    toggleHeatmap, toggleParcels, toggleBuffer, clearMarkers, clearPolygonLayers,
    fitSelectedBID, focusRecord, getMap, TYPE_COLORS
  };
})();
