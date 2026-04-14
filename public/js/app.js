/**
 * app.js — Main app orchestration, state management, CSV export
 *
 * Filter model (single source of truth):
 *   activeFilters = {
 *     status: 'open' | 'closed' | 'all',      // segmented control
 *     complaintType: string | null,            // click a legend row / chart bar
 *     agency: string | null,                   // click an agency row
 *     channel: string | null                   // click a channel slice
 *   }
 *
 * Any dimension can be set independently. They AND together. Click the same value
 * again (or the × on the breadcrumb) to clear that dimension.
 */
const App = (() => {
  let allRecords = [];
  let matchResult = null;
  let typeColorMap = {};

  const activeFilters = {
    status: 'open',
    complaintType: null,
    agency: null,
    channel: null
  };

  function isClosed(r) { return (r.status || '').toLowerCase() === 'closed'; }

  function matchesStatus(r) {
    if (activeFilters.status === 'all') return true;
    if (activeFilters.status === 'closed') return isClosed(r);
    return !isClosed(r);
  }
  function matchesType(r) {
    return !activeFilters.complaintType || (r.complaint_type || '') === activeFilters.complaintType;
  }
  function matchesAgency(r) {
    return !activeFilters.agency || (r.agency_name || r.agency || '') === activeFilters.agency;
  }
  function matchesChannel(r) {
    if (!activeFilters.channel) return true;
    const raw = (r.open_data_channel_type || '').trim();
    const display = raw ? (raw.charAt(0) + raw.slice(1).toLowerCase()) : 'Unknown';
    return display === activeFilters.channel;
  }

  function matchesAll(r) {
    return matchesStatus(r) && matchesType(r) && matchesAgency(r) && matchesChannel(r);
  }

  async function init() {
    MapView.init();

    try {
      showLoading('Loading BID boundaries...');
      const bidGeoJSON = await Data.fetchBIDs();
      Filters.init(bidGeoJSON);
      hideLoading();
      Filters.restoreFromHash();
    } catch (err) {
      showError('Failed to load BID data: ' + err.message);
    }

    document.getElementById('export-csv-btn').addEventListener('click', exportCSV);
  }

  /**
   * Main data loading (fetch + normalize + initial render)
   */
  async function loadData(selectedBID, fromDate, toDate) {
    showLoading('Fetching 311 data...');
    hideError();
    MapView.clearMarkers();

    const processed = selectedBID.processed;
    if (!processed) {
      showError('BID polygon could not be processed');
      return;
    }

    try {
      const [odRecords, portalPins] = await Promise.all([
        Data.fetch311OpenData(processed.paddedBbox, fromDate, toDate, (count) => {
          showLoading(`Loading Open Data... ${count.toLocaleString()} records`);
        }),
        Data.fetch311Portal(processed.paddedBbox, fromDate, toDate, { refresh: true })
      ]);

      showLoading('Filtering to BID boundary...');

      const odFiltered = odRecords.filter(r =>
        Polygons.isPointInside(r.longitude, r.latitude, processed)
      );
      const portalFiltered = portalPins.filter(r =>
        r.latitude && r.longitude && Polygons.isPointInside(r.longitude, r.latitude, processed)
      );

      showLoading('Matching records...');
      matchResult = Matching.matchRecords(odFiltered, portalFiltered);

      allRecords = [
        ...matchResult.matched.map(Matching.mergeRecord),
        ...matchResult.odOnly.map(Matching.odRecord),
        ...matchResult.portalOnly.map(Matching.portalRecord)
      ];

      if (allRecords.length === 0) {
        showError('No 311 requests found in this BID for the selected date range.');
        hideLoading();
        return;
      }

      typeColorMap = buildTypeColorMap(allRecords);

      document.getElementById('export-csv-btn').classList.remove('hidden');
      Filters.updateHash();

      applyFilters();
      hideLoading();

      console.log(`Loaded ${allRecords.length} records (${matchResult.matched.length} matched, ${matchResult.odOnly.length} OD-only, ${matchResult.portalOnly.length} portal-only)`);
    } catch (err) {
      console.error('Data loading error:', err);
      showError('Error loading data: ' + err.message);
      hideLoading();
    }
  }

  /**
   * Single render pipeline — every filter change eventually calls this.
   */
  function applyFilters() {
    if (!matchResult || allRecords.length === 0) return;

    const visible = allRecords.filter(matchesAll);

    // Legend counts reflect everything EXCEPT the complaintType filter
    // (so user sees other types available to click-to-isolate into).
    const typeCounts = {};
    for (const r of allRecords) {
      if (!matchesStatus(r) || !matchesAgency(r) || !matchesChannel(r)) continue;
      const t = r.complaint_type || 'Unknown';
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    }

    MapView.buildCategoryLegend(typeCounts, typeColorMap, activeFilters.complaintType);
    MapView.plotRecords(visible, typeColorMap);
    MapView.updateHeatmap(visible);
    Summary.update(matchResult, visible, activeFilters);
  }

  /**
   * Set a single filter dimension. Pass null to clear.
   * Clicking a value that's already selected toggles it off.
   */
  function setFilter(dimension, value) {
    if (!(dimension in activeFilters)) return;
    if (dimension === 'status') {
      activeFilters.status = value || 'all';
    } else {
      // Click same value twice = clear it
      activeFilters[dimension] = (activeFilters[dimension] === value) ? null : value;
    }
    // Sync the status segmented control visuals
    if (dimension === 'status') {
      document.querySelectorAll('#status-filter .seg-btn').forEach(b => {
        const active = b.dataset.status === activeFilters.status;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
    }
    applyFilters();
  }

  function clearFilter(dimension) {
    if (dimension === 'status') {
      setFilter('status', 'all');
    } else {
      activeFilters[dimension] = null;
      applyFilters();
    }
  }

  function clearAllFilters() {
    activeFilters.status = 'all';
    activeFilters.complaintType = null;
    activeFilters.agency = null;
    activeFilters.channel = null;
    document.querySelectorAll('#status-filter .seg-btn').forEach(b => {
      const active = b.dataset.status === 'all';
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    applyFilters();
  }

  function replotCurrentData() { applyFilters(); }

  function buildTypeColorMap(records) {
    const counts = {};
    for (const r of records) {
      const t = r.complaint_type || 'Unknown';
      counts[t] = (counts[t] || 0) + 1;
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const map = {};
    sorted.forEach(([type], i) => {
      map[type] = MapView.TYPE_COLORS[i % MapView.TYPE_COLORS.length];
    });
    return map;
  }

  function getAllRecords() { return allRecords; }
  function getTypeColorMap() { return typeColorMap; }
  function getActiveFilters() { return { ...activeFilters }; }
  function getStatusFilter() { return activeFilters.status; }

  /**
   * Export CSV (respects active filters — only exports currently-visible records)
   */
  function exportCSV() {
    if (allRecords.length === 0) return;
    const visible = allRecords.filter(matchesAll);
    if (visible.length === 0) return;

    const headers = [
      'Source', 'Unique Key', 'SR Number', 'Complaint Type', 'Descriptor',
      'Status', 'Agency', 'Created Date', 'Closed Date', 'Address',
      'Borough', 'Zip', 'Community Board', 'Channel', 'Latitude', 'Longitude',
      'Resolution', 'Portal URL'
    ];

    const rows = visible.map(r => [
      r._source, r.unique_key || '', r.srnumber || '',
      r.complaint_type || '', r.descriptor || '', r.status || '',
      r.agency_name || r.agency || '', r.created_date || '', r.closed_date || '',
      r.incident_address || '', r.borough || '', r.incident_zip || '',
      r.community_board || '', r.open_data_channel_type || '',
      r.latitude || '', r.longitude || '',
      (r.resolution_description || '').replace(/[\r\n]+/g, ' ').substring(0, 500),
      r.portalUrl || ''
    ]);

    const csvContent = [headers, ...rows]
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const bid = Filters.getSelectedBID();
    const dateRange = Filters.getDateRange();
    a.href = url;
    a.download = `311_${(bid ? bid.name : 'export').replace(/\s+/g, '_')}_${dateRange ? dateRange.from : ''}_${dateRange ? dateRange.to : ''}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function showLoading(text) {
    document.getElementById('loading-indicator').classList.remove('hidden');
    document.getElementById('loading-text').textContent = text || 'Loading...';
    document.getElementById('load-btn').disabled = true;
  }
  function hideLoading() {
    document.getElementById('loading-indicator').classList.add('hidden');
    document.getElementById('load-btn').disabled = false;
  }
  function showError(msg) {
    const el = document.getElementById('error-message');
    el.textContent = msg;
    el.classList.remove('hidden');
  }
  function hideError() {
    document.getElementById('error-message').classList.add('hidden');
  }

  document.addEventListener('DOMContentLoaded', init);

  return {
    loadData, replotCurrentData, getAllRecords, getTypeColorMap,
    setFilter, clearFilter, clearAllFilters, getActiveFilters,
    // Back-compat shims used elsewhere
    setStatusFilter: (s) => setFilter('status', s),
    getStatusFilter,
    onCategoryChange: () => applyFilters()
  };
})();
