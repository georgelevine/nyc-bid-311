/**
 * app.js — Main app orchestration, state management, CSV export
 */
const App = (() => {
  let allRecords = [];
  let matchResult = null;
  let typeColorMap = {};

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

    // CSV export in header
    document.getElementById('export-csv-btn').addEventListener('click', exportCSV);
  }

  /**
   * Main data loading
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
      // Fetch both sources in parallel
      // Portal uses adaptive endpoint: daily windows + spatial re-split for capped days
      const [odRecords, portalPins] = await Promise.all([
        Data.fetch311OpenData(processed.paddedBbox, fromDate, toDate, (count) => {
          showLoading(`Loading Open Data... ${count.toLocaleString()} records`);
        }),
        Data.fetch311Portal(processed.paddedBbox, fromDate, toDate)
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

      // Build type color map
      typeColorMap = buildTypeColorMap(allRecords);

      // Build complaint type counts
      const typeCounts = {};
      for (const r of allRecords) {
        const t = r.complaint_type || 'Unknown';
        typeCounts[t] = (typeCounts[t] || 0) + 1;
      }

      // Build category legend on map
      MapView.buildCategoryLegend(typeCounts, typeColorMap);

      // Plot on map
      MapView.plotRecords(allRecords, typeColorMap);
      MapView.updateHeatmap(allRecords);

      // Update summary
      Summary.update(matchResult, allRecords);

      // Show export button in header
      document.getElementById('export-csv-btn').classList.remove('hidden');

      // Update URL
      Filters.updateHash();

      hideLoading();

      console.log(`Loaded ${allRecords.length} records (${matchResult.matched.length} matched, ${matchResult.odOnly.length} OD-only, ${matchResult.portalOnly.length} portal-only)`);

    } catch (err) {
      console.error('Data loading error:', err);
      showError('Error loading data: ' + err.message);
      hideLoading();
    }
  }

  /**
   * Re-plot current data (used when toggling heatmap off)
   */
  function replotCurrentData() {
    if (allRecords.length > 0) {
      const active = MapView.getActiveCategories();
      const filtered = allRecords.filter(r => active.has(r.complaint_type));
      MapView.plotRecords(filtered, typeColorMap);
    }
  }

  /**
   * Handle category toggle from legend
   */
  function onCategoryChange(activeCategories) {
    if (matchResult) {
      const filtered = allRecords.filter(r => activeCategories.has(r.complaint_type));
      Summary.update(matchResult, filtered);
    }
  }

  /**
   * Build color map for complaint types
   */
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

  function getTypeColor(type) {
    return typeColorMap[type] || '#94a3b8';
  }

  function getAllRecords() { return allRecords; }

  /**
   * Export CSV
   */
  function exportCSV() {
    if (allRecords.length === 0) return;

    const headers = [
      'Source', 'Unique Key', 'SR Number', 'Complaint Type', 'Descriptor',
      'Status', 'Agency', 'Created Date', 'Closed Date', 'Address',
      'Borough', 'Zip', 'Community Board', 'Channel', 'Latitude', 'Longitude',
      'Resolution', 'Portal URL'
    ];

    const rows = allRecords.map(r => [
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

  // UI helpers
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

  return { loadData, replotCurrentData, onCategoryChange, getTypeColor, getAllRecords };
})();
