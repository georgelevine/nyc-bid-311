/**
 * filters.js — Searchable BID dropdown, quick date buttons, date range picker
 */
const Filters = (() => {
  let bidData = null;
  let bidList = [];       // sorted list of { idx, name, borough, website, yearFounded }
  let selectedBID = null;
  let datePicker = null;
  let activeQuickRange = '30';

  function init(geojson) {
    bidData = geojson;
    buildBIDList();
    initBIDSearch();
    initDatePicker();
    initQuickDates();
    initDrawer();
    bindEvents();
    MapView.drawBIDOverview(bidData, selectBIDByIndex);
  }

  // ===== Drawer / Sidebar state =====
  // Desktop: sidebar has data-state="open|closed" (toggleable via header button)
  // Mobile: sidebar is a draggable bottom sheet with collapsed, half, and full snaps.

  function isMobile() { return window.matchMedia('(max-width: 768px)').matches; }

  function setSidebarState(state) {
    const sidebar = document.getElementById('sidebar');
    sidebar.dataset.state = state;
    sidebar.style.removeProperty('height');
    updateDrawerControls(state);
    // Invalidate Leaflet size when sidebar width changes on desktop
    setTimeout(() => {
      if (window.MapView && MapView.getMap) {
        try {
          MapView.getMap().invalidateSize();
          if (MapView.fitSelectedBID) MapView.fitSelectedBID();
        } catch (e) {}
      }
    }, 260);
  }

  function updateDrawerControls(state) {
    const grip = document.getElementById('drawer-grip');
    const minimize = document.getElementById('drawer-minimize');
    if (grip) {
      const expanded = !['collapsed', 'closed'].includes(state);
      grip.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      grip.setAttribute('aria-label', state === 'full'
        ? 'Drag details panel or tap for half height'
        : state === 'half'
          ? 'Drag details panel or tap for full height'
          : 'Drag or tap to expand details panel');
    }
    if (minimize) minimize.disabled = ['collapsed', 'closed'].includes(state);
  }

  function mobileDrawerSnaps() {
    const viewportHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    const full = Math.round(viewportHeight * 0.92);
    const half = Math.min(full - 76, Math.max(240, Math.round(viewportHeight * 0.62)));
    return { collapsed: 76, half, full };
  }

  function nearestDrawerState(height, velocityY = 0) {
    const snaps = mobileDrawerSnaps();
    const projectedHeight = height - velocityY * 140;
    return Object.entries(snaps).reduce((closest, entry) =>
      Math.abs(entry[1] - projectedHeight) < Math.abs(closest[1] - projectedHeight) ? entry : closest
    )[0];
  }

  function initDrawerDrag(handle) {
    const sidebar = document.getElementById('sidebar');
    let drag = null;
    let suppressClick = false;

    handle.addEventListener('pointerdown', event => {
      if (!isMobile() || event.button > 0 || event.target.closest('#drawer-minimize')) return;
      drag = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startHeight: sidebar.getBoundingClientRect().height,
        currentHeight: sidebar.getBoundingClientRect().height,
        lastY: event.clientY,
        lastTime: performance.now(),
        velocityY: 0,
        moved: false
      };
      handle.setPointerCapture(event.pointerId);
    });

    const moveDrag = event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const deltaY = event.clientY - drag.startY;
      if (!drag.moved && Math.abs(deltaY) < 6) return;

      drag.moved = true;
      event.preventDefault();
      const snaps = mobileDrawerSnaps();
      const nextHeight = Math.max(snaps.collapsed, Math.min(snaps.full, drag.startHeight - deltaY));
      const now = performance.now();
      const elapsed = Math.max(1, now - drag.lastTime);
      drag.velocityY = (event.clientY - drag.lastY) / elapsed;
      drag.lastY = event.clientY;
      drag.lastTime = now;
      drag.currentHeight = nextHeight;
      sidebar.classList.add('is-dragging');
      sidebar.style.height = `${nextHeight}px`;
    };

    const finishDrag = event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);

      const completedDrag = drag.moved;
      const targetState = completedDrag
        ? nearestDrawerState(drag.currentHeight, drag.velocityY)
        : null;
      drag = null;
      sidebar.classList.remove('is-dragging');

      if (completedDrag) {
        event.preventDefault();
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 350);
        setSidebarState(targetState);
      }
    };

    const cancelDrag = event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag = null;
      sidebar.classList.remove('is-dragging');
      setSidebarState(sidebar.dataset.state || 'half');
    };

    // Listen at the window so a fast swipe remains tracked after leaving the grip.
    window.addEventListener('pointermove', moveDrag, { passive: false });
    window.addEventListener('pointerup', finishDrag);
    window.addEventListener('pointercancel', cancelDrag);

    handle.addEventListener('click', event => {
      if (!isMobile() || event.target.closest('#drawer-minimize')) return;
      if (suppressClick) {
        event.preventDefault();
        event.stopPropagation();
        suppressClick = false;
        return;
      }
      const current = sidebar.dataset.state || 'half';
      const next = current === 'collapsed' ? 'half' : current === 'half' ? 'full' : 'half';
      setSidebarState(next);
    });
  }

  function initDrawer() {
    const handle = document.getElementById('drawer-handle');
    const minimize = document.getElementById('drawer-minimize');
    const toggle = document.getElementById('sidebar-toggle');

    if (handle) initDrawerDrag(handle);
    if (minimize) {
      minimize.addEventListener('click', event => {
        event.stopPropagation();
        if (isMobile()) setSidebarState('collapsed');
      });
    }

    if (toggle) {
      toggle.addEventListener('click', () => {
        const sidebar = document.getElementById('sidebar');
        if (isMobile()) {
          const cur = sidebar.dataset.state || 'collapsed';
          setSidebarState(cur === 'collapsed' ? 'half' : 'collapsed');
        } else {
          const cur = sidebar.dataset.state || 'open';
          setSidebarState(cur === 'open' ? 'closed' : 'open');
        }
      });
    }

    document.querySelectorAll('.drawer-tab').forEach(tab => {
      tab.addEventListener('click', () => setDrawerView(tab.dataset.drawerView));
    });

    // Legend toggle (mobile defaults to closed — FAB-only — to keep map visible)
    const legend = document.getElementById('map-legend');
    if (legend) {
      legend.dataset.state = isMobile() ? 'closed' : 'open';
    }
    const legendToggle = document.getElementById('legend-toggle');
    const legendClose = document.getElementById('legend-close');
    if (legendToggle) {
      legendToggle.addEventListener('click', () => {
        document.getElementById('map-legend').dataset.state = 'open';
      });
    }
    if (legendClose) {
      legendClose.addEventListener('click', () => {
        document.getElementById('map-legend').dataset.state = 'closed';
      });
    }

    // Set initial state based on viewport
    if (isMobile()) {
      setSidebarState(window.location.hash.includes('bid=') ? 'half' : 'collapsed');
    } else {
      setSidebarState('open');
    }

    // Handle orientation / resize: swap state vocab cleanly
    let lastIsMobile = isMobile();
    window.addEventListener('resize', () => {
      const nowMobile = isMobile();
      if (nowMobile !== lastIsMobile) {
        setSidebarState(nowMobile ? 'half' : 'open');
        lastIsMobile = nowMobile;
      }
    });
  }

  function updateDrawerHandle() {
    const titleEl = document.getElementById('drawer-handle-title');
    const subEl = document.getElementById('drawer-handle-subtitle');
    if (!titleEl || !subEl) return;

    if (selectedBID) {
      titleEl.textContent = selectedBID.name;
      const sidebar = document.getElementById('sidebar');
      if (sidebar.dataset.contentState === 'loading') {
        subEl.textContent = 'Loading 311 data...';
        return;
      }
      if (sidebar.dataset.contentState === 'ready') {
        const count = Number(sidebar.dataset.resultCount || 0).toLocaleString();
        subEl.textContent = `${count} requests - View summary`;
        return;
      }
      const dates = datePicker ? datePicker.selectedDates : [];
      if (dates.length === 2) {
        subEl.textContent = `${formatDateStr(dates[0])} to ${formatDateStr(dates[1])}`;
      } else {
        subEl.textContent = selectedBID.borough;
      }
    } else {
      titleEl.textContent = 'Filters';
      subEl.textContent = 'Choose a BID to begin';
    }
  }

  function setDrawerView(view) {
    const next = view === 'filters' ? 'filters' : 'summary';
    const sidebar = document.getElementById('sidebar');
    sidebar.dataset.view = next;
    document.querySelectorAll('.drawer-tab').forEach(tab => {
      const active = tab.dataset.drawerView === next;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  }

  function setResultsState(state, count = 0) {
    const sidebar = document.getElementById('sidebar');
    sidebar.dataset.contentState = state;
    sidebar.dataset.resultCount = String(count);
    sidebar.classList.toggle('has-results', state === 'ready');

    if (state === 'ready') {
      setDrawerView('summary');
      if (isMobile()) setSidebarState('half');
      document.getElementById('load-btn').textContent = 'Refresh 311 Data';
    } else {
      document.getElementById('load-btn').textContent = 'Load 311 Data';
      if (state === 'error' && isMobile()) setSidebarState('half');
    }
    updateDrawerHandle();
  }

  // ===== BID Search Dropdown =====

  function buildBIDList() {
    bidList = bidData.features.map((f, idx) => ({
      idx,
      name: f.properties.f_all_bi_2 || `BID ${idx}`,
      borough: f.properties.f_all_bi_1 || 'Unknown',
      website: f.properties.f_all_bi_4 || null,
      yearFounded: f.properties.year_found || null
    })).sort((a, b) => a.borough.localeCompare(b.borough) || a.name.localeCompare(b.name));
  }

  function initBIDSearch() {
    const input = document.getElementById('bid-search');
    const dropdown = document.getElementById('bid-dropdown-list');

    input.addEventListener('focus', () => {
      renderBIDDropdown(input.value);
      dropdown.classList.remove('hidden');
    });

    input.addEventListener('input', () => {
      renderBIDDropdown(input.value);
      dropdown.classList.remove('hidden');
    });

    // Close on click outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#bid-search-wrapper')) {
        dropdown.classList.add('hidden');
      }
    });

    // Keyboard nav
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') dropdown.classList.add('hidden');
    });
  }

  function renderBIDDropdown(query) {
    const dropdown = document.getElementById('bid-dropdown-list');
    dropdown.innerHTML = '';

    const q = (query || '').toLowerCase().trim();
    const filtered = q ? bidList.filter(b => b.name.toLowerCase().includes(q) || b.borough.toLowerCase().includes(q)) : bidList;

    if (filtered.length === 0) {
      dropdown.innerHTML = '<div class="bid-dropdown-item" style="color:var(--text-muted);">No matches</div>';
      return;
    }

    let currentBorough = '';
    for (const bid of filtered) {
      if (bid.borough !== currentBorough) {
        currentBorough = bid.borough;
        const header = document.createElement('div');
        header.className = 'bid-dropdown-group';
        header.textContent = currentBorough;
        dropdown.appendChild(header);
      }
      const item = document.createElement('div');
      item.className = 'bid-dropdown-item';
      item.textContent = bid.name;
      item.addEventListener('click', () => selectBID(bid));
      dropdown.appendChild(item);
    }
  }

  function selectBID(bid, options = {}) {
    const input = document.getElementById('bid-search');
    const dropdown = document.getElementById('bid-dropdown-list');

    input.value = bid.name;
    dropdown.classList.add('hidden');

    const feature = bidData.features[bid.idx];
    selectedBID = {
      feature,
      idx: bid.idx,
      name: bid.name,
      borough: bid.borough,
      website: bid.website,
      yearFounded: bid.yearFounded
    };
    setResultsState('idle');

    const processed = Polygons.processFeature(feature);
    if (processed) {
      selectedBID.processed = processed;
      MapView.drawBIDPolygon(processed, bid.idx);
    }

    showBIDInfo();
    updateLoadButton();
    updateHash();
    updateDrawerHandle();

    // Auto-load 311 data as soon as a BID is picked and a date range exists.
    // No need to make the user hunt for the Load button.
    if (!options.suppressLoad && datePicker && datePicker.selectedDates.length === 2) {
      // Defer one tick so the polygon has been drawn before we start the fetch spinner
      setTimeout(() => onLoadClick(), 50);
    }
  }

  function selectBIDByIndex(index) {
    const bid = bidList.find(item => item.idx === index);
    if (bid) selectBID(bid);
  }

  // ===== Quick Date Buttons =====

  function initQuickDates() {
    document.querySelectorAll('.date-quick').forEach(btn => {
      btn.addEventListener('click', () => {
        const range = btn.dataset.range;
        if (range === 'custom') {
          datePicker.open();
          setActiveQuickButton('custom');
          return;
        }

        // Normalize "today" to midnight so flatpickr range works cleanly.
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const from = new Date(today);

        switch (range) {
          case 'today': break;
          case 'week': from.setDate(from.getDate() - 7); break;
          case '30':   from.setDate(from.getDate() - 30); break;
          case '90':   from.setDate(from.getDate() - 90); break;
        }

        // Pass triggerChange=true so flatpickr fires onChange and redraws.
        datePicker.setDate([from, today], true);
        setActiveQuickButton(range);
        updateLoadButton();
        updateDrawerHandle();
      });
    });
  }

  function setActiveQuickButton(range) {
    activeQuickRange = range;
    document.querySelectorAll('.date-quick').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.range === range);
    });
  }

  // ===== Date Picker =====

  function initDatePicker() {
    const today = new Date();
    const thirtyDaysAgo = new Date(today);
    thirtyDaysAgo.setDate(today.getDate() - 30);

    datePicker = flatpickr('#date-range', {
      mode: 'range',
      dateFormat: 'Y-m-d',
      defaultDate: [thirtyDaysAgo, today],
      maxDate: today,
      theme: 'dark',
      onChange: () => {
        setActiveQuickButton('custom');
        updateLoadButton();
      }
    });
  }

  // ===== Events =====

  function bindEvents() {
    document.getElementById('load-btn').addEventListener('click', onLoadClick);

    // Legend layer toggles
    document.getElementById('toggle-parcels').addEventListener('change', e => MapView.toggleParcels(e.target.checked));
    document.getElementById('toggle-buffer').addEventListener('change', e => MapView.toggleBuffer(e.target.checked));
    document.getElementById('toggle-heatmap').addEventListener('change', e => {
      MapView.toggleHeatmap(e.target.checked);
      if (!e.target.checked) App.replotCurrentData();
    });

    // Status filter (Open / Closed / All)
    document.querySelectorAll('#status-filter .seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const status = btn.dataset.status;
        document.querySelectorAll('#status-filter .seg-btn').forEach(b => {
          const active = b === btn;
          b.classList.toggle('active', active);
          b.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        App.setStatusFilter(status);
      });
    });
  }

  function onLoadClick() {
    if (!selectedBID || !selectedBID.processed) return;
    const dates = datePicker.selectedDates;
    if (dates.length < 2) return;
    App.loadData(selectedBID, formatDateStr(dates[0]), formatDateStr(dates[1]));
    // On mobile, collapse drawer so map is visible while loading
    if (isMobile()) setSidebarState('collapsed');
  }

  // ===== BID Info Display =====

  function showBIDInfo() {
    const info = document.getElementById('bid-info');
    info.classList.remove('hidden');
    document.getElementById('bid-borough').textContent = selectedBID.borough;
    document.getElementById('bid-year').textContent = selectedBID.yearFounded ? `Est. ${selectedBID.yearFounded}` : '';
    const link = document.getElementById('bid-website');
    if (selectedBID.website) {
      link.href = selectedBID.website;
      link.classList.remove('hidden');
    } else {
      link.classList.add('hidden');
    }
  }

  function hideBIDInfo() {
    document.getElementById('bid-info').classList.add('hidden');
  }

  function updateLoadButton() {
    const btn = document.getElementById('load-btn');
    const dates = datePicker ? datePicker.selectedDates : [];
    btn.disabled = !selectedBID || dates.length < 2;
  }

  // ===== State Getters =====

  function getSelectedBID() { return selectedBID; }
  function getDateRange() {
    const dates = datePicker ? datePicker.selectedDates : [];
    if (dates.length < 2) return null;
    return { from: formatDateStr(dates[0]), to: formatDateStr(dates[1]) };
  }

  // ===== URL Hash =====

  function restoreFromHash() {
    const hash = window.location.hash.replace('#', '');
    if (!hash) return;
    const params = new URLSearchParams(hash);
    const bidName = params.get('bid');
    const from = params.get('from');
    const to = params.get('to');

    if (bidName && bidData) {
      const bid = bidList.find(b => b.name === bidName);
      if (bid) selectBID(bid, { suppressLoad: true });
    }
    if (from && to && datePicker) {
      datePicker.setDate([from, to]);
      setActiveQuickButton('custom');
    }
    if (bidName && from && to) {
      setTimeout(() => onLoadClick(), 500);
    }
  }

  function updateHash() {
    if (!selectedBID) return;
    const dates = datePicker ? datePicker.selectedDates : [];
    const params = new URLSearchParams();
    params.set('bid', selectedBID.name);
    if (dates.length >= 2) {
      params.set('from', formatDateStr(dates[0]));
      params.set('to', formatDateStr(dates[1]));
    }
    window.location.hash = params.toString();
  }

  // Helpers
  function formatDateStr(d) { return d.toISOString().split('T')[0]; }

  return {
    init, getSelectedBID, getDateRange, restoreFromHash, updateHash, setResultsState
  };
})();
