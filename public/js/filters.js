/**
 * filters.js — BID dropdown, date range picker, complaint type chips
 */
const Filters = (() => {
  let bidData = null;  // Full GeoJSON
  let selectedBID = null;
  let datePicker = null;
  let activeTypes = new Set(); // Empty = show all
  let allTypes = [];

  function init(geojson) {
    bidData = geojson;
    populateDropdown();
    initDatePicker();
    bindEvents();
  }

  function populateDropdown() {
    const select = document.getElementById('bid-select');

    // Extract BIDs, sort by borough then name
    const bids = bidData.features.map((f, idx) => ({
      idx,
      name: f.properties.f_all_bi_2 || `BID ${idx}`,
      borough: f.properties.f_all_bi_1 || 'Unknown',
      website: f.properties.f_all_bi_4 || null,
      yearFounded: f.properties.year_found || null
    })).sort((a, b) => a.borough.localeCompare(b.borough) || a.name.localeCompare(b.name));

    // Group by borough
    let currentBorough = '';
    let optgroup = null;

    for (const bid of bids) {
      if (bid.borough !== currentBorough) {
        currentBorough = bid.borough;
        optgroup = document.createElement('optgroup');
        optgroup.label = currentBorough;
        select.appendChild(optgroup);
      }
      const option = document.createElement('option');
      option.value = bid.idx;
      option.textContent = bid.name;
      optgroup.appendChild(option);
    }
  }

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
      onChange: () => updateLoadButton()
    });
  }

  function bindEvents() {
    document.getElementById('bid-select').addEventListener('change', onBIDChange);
    document.getElementById('load-btn').addEventListener('click', onLoadClick);
    document.getElementById('chips-clear').addEventListener('click', clearChipFilters);

    // Legend toggles
    document.getElementById('toggle-parcels').addEventListener('change', e => MapView.toggleParcels(e.target.checked));
    document.getElementById('toggle-buffer').addEventListener('change', e => MapView.toggleBuffer(e.target.checked));
    document.getElementById('toggle-heatmap').addEventListener('change', e => {
      MapView.toggleHeatmap(e.target.checked);
      if (!e.target.checked) {
        // Re-plot pins
        App.replotCurrentData();
      }
    });
  }

  function onBIDChange() {
    const select = document.getElementById('bid-select');
    const idx = parseInt(select.value);

    if (isNaN(idx)) {
      selectedBID = null;
      MapView.clearPolygonLayers();
      MapView.clearMarkers();
      hideBIDInfo();
      updateLoadButton();
      return;
    }

    const feature = bidData.features[idx];
    selectedBID = {
      feature,
      idx,
      name: feature.properties.f_all_bi_2,
      borough: feature.properties.f_all_bi_1,
      website: feature.properties.f_all_bi_4,
      yearFounded: feature.properties.year_found
    };

    // Process polygon
    const processed = Polygons.processFeature(feature);
    if (processed) {
      selectedBID.processed = processed;
      MapView.drawBIDPolygon(processed);
    }

    showBIDInfo();
    updateLoadButton();

    // Update URL hash
    updateHash();
  }

  function onLoadClick() {
    if (!selectedBID || !selectedBID.processed) return;
    const dates = datePicker.selectedDates;
    if (dates.length < 2) return;

    const fromDate = formatDateStr(dates[0]);
    const toDate = formatDateStr(dates[1]);

    App.loadData(selectedBID, fromDate, toDate);
  }

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

  /**
   * Build complaint type filter chips from loaded data
   */
  function buildChips(typeCounts) {
    const section = document.getElementById('chips-section');
    const container = document.getElementById('complaint-chips');
    container.innerHTML = '';

    // Sort by count descending, take top 15
    allTypes = Object.entries(typeCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);

    activeTypes = new Set(allTypes.map(([type]) => type));
    // Also include types not in top 15
    Object.keys(typeCounts).forEach(t => activeTypes.add(t));

    for (const [type, count] of allTypes) {
      const chip = document.createElement('div');
      chip.className = 'chip active';
      chip.dataset.type = type;
      chip.innerHTML = `${esc(type)} <span class="chip-count">${count}</span>`;
      chip.addEventListener('click', () => toggleChip(chip, type));
      container.appendChild(chip);
    }

    section.classList.remove('hidden');
  }

  function toggleChip(chipEl, type) {
    chipEl.classList.toggle('active');
    if (activeTypes.has(type)) {
      activeTypes.delete(type);
    } else {
      activeTypes.add(type);
    }
    App.onChipFilterChange(activeTypes);
  }

  function clearChipFilters() {
    document.querySelectorAll('.chip').forEach(c => c.classList.add('active'));
    activeTypes = new Set();
    // Re-add all types
    App.getAllRecords().forEach(r => activeTypes.add(r.complaint_type));
    App.onChipFilterChange(activeTypes);
  }

  function getActiveTypes() { return activeTypes; }
  function getSelectedBID() { return selectedBID; }
  function getDateRange() {
    const dates = datePicker ? datePicker.selectedDates : [];
    if (dates.length < 2) return null;
    return { from: formatDateStr(dates[0]), to: formatDateStr(dates[1]) };
  }

  /**
   * Restore state from URL hash
   */
  function restoreFromHash() {
    const hash = window.location.hash.replace('#', '');
    if (!hash) return;

    const params = new URLSearchParams(hash);
    const bidName = params.get('bid');
    const from = params.get('from');
    const to = params.get('to');

    if (bidName && bidData) {
      const select = document.getElementById('bid-select');
      for (const feature of bidData.features) {
        if (feature.properties.f_all_bi_2 === bidName) {
          const idx = bidData.features.indexOf(feature);
          select.value = idx;
          onBIDChange();
          break;
        }
      }
    }

    if (from && to && datePicker) {
      datePicker.setDate([from, to]);
    }

    // Auto-load if both are set
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
  function formatDateStr(d) {
    return d.toISOString().split('T')[0];
  }

  function esc(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  return {
    init, buildChips, getActiveTypes, getSelectedBID, getDateRange,
    restoreFromHash, updateHash
  };
})();
