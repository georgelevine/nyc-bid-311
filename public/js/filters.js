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
    bindEvents();
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

  function selectBID(bid) {
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

    const processed = Polygons.processFeature(feature);
    if (processed) {
      selectedBID.processed = processed;
      MapView.drawBIDPolygon(processed);
    }

    showBIDInfo();
    updateLoadButton();
    updateHash();
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

        const today = new Date();
        let from;
        switch (range) {
          case 'today':
            from = new Date(today);
            break;
          case 'week':
            from = new Date(today);
            from.setDate(today.getDate() - 7);
            break;
          case '30':
            from = new Date(today);
            from.setDate(today.getDate() - 30);
            break;
          case '90':
            from = new Date(today);
            from.setDate(today.getDate() - 90);
            break;
        }

        datePicker.setDate([from, today]);
        setActiveQuickButton(range);
        updateLoadButton();
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
  }

  function onLoadClick() {
    if (!selectedBID || !selectedBID.processed) return;
    const dates = datePicker.selectedDates;
    if (dates.length < 2) return;
    App.loadData(selectedBID, formatDateStr(dates[0]), formatDateStr(dates[1]));
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
      if (bid) selectBID(bid);
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
    init, getSelectedBID, getDateRange, restoreFromHash, updateHash
  };
})();
