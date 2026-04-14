/**
 * data.js — API calls to NYC Open Data (direct) and 311 Portal (via proxy)
 */
const Data = (() => {
  const BID_URL = 'https://data.cityofnewyork.us/resource/7jdm-inj8.geojson?$limit=100';
  const OD_311_URL = 'https://data.cityofnewyork.us/resource/erm2-nwe9.json';
  const PORTAL_PROXY_URL = '/api/portal-pins';
  const OD_PAGE_SIZE = 10000;
  const BID_CACHE_KEY = 'nyc_bid_geojson';
  const BID_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

  const OD_FIELDS = [
    'unique_key', 'complaint_type', 'descriptor', 'status', 'agency', 'agency_name',
    'created_date', 'closed_date', 'resolution_description', 'resolution_action_updated_date',
    'incident_address', 'city', 'borough', 'incident_zip', 'latitude', 'longitude',
    'community_board', 'open_data_channel_type', 'location_type', 'bbl'
  ].join(',');

  /**
   * Fetch BID GeoJSON (with localStorage caching)
   */
  async function fetchBIDs() {
    // Check cache
    try {
      const cached = localStorage.getItem(BID_CACHE_KEY);
      if (cached) {
        const { data, timestamp } = JSON.parse(cached);
        if (Date.now() - timestamp < BID_CACHE_TTL) {
          console.log('BID data loaded from cache');
          return data;
        }
      }
    } catch (e) { /* cache miss */ }

    const resp = await fetch(BID_URL);
    if (!resp.ok) throw new Error(`BID fetch failed: ${resp.status}`);
    const data = await resp.json();

    // Cache it
    try {
      localStorage.setItem(BID_CACHE_KEY, JSON.stringify({ data, timestamp: Date.now() }));
    } catch (e) { /* storage full, skip */ }

    return data;
  }

  /**
   * Fetch 311 requests from Open Data within a bounding box + date range.
   * paddedBbox: [west, south, east, north]
   * fromDate, toDate: 'YYYY-MM-DD'
   * onProgress: callback(count) for progress updates
   */
  async function fetch311OpenData(paddedBbox, fromDate, toDate, onProgress) {
    const [west, south, east, north] = paddedBbox;
    const whereClause = [
      `within_box(location, ${south}, ${west}, ${north}, ${east})`,
      `created_date >= '${fromDate}T00:00:00'`,
      `created_date <= '${toDate}T23:59:59'`
    ].join(' AND ');

    let allResults = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const params = new URLSearchParams({
        '$where': whereClause,
        '$select': OD_FIELDS,
        '$limit': OD_PAGE_SIZE,
        '$offset': offset,
        '$order': 'created_date DESC'
      });

      const resp = await fetch(`${OD_311_URL}?${params}`);
      if (!resp.ok) throw new Error(`Open Data fetch failed: ${resp.status}`);
      const page = await resp.json();

      allResults = allResults.concat(page);
      if (onProgress) onProgress(allResults.length);

      if (page.length < OD_PAGE_SIZE) {
        hasMore = false;
      } else {
        offset += OD_PAGE_SIZE;
      }
    }

    // Parse coordinates
    return allResults.map(r => ({
      ...r,
      latitude: parseFloat(r.latitude) || null,
      longitude: parseFloat(r.longitude) || null,
      _source: 'opendata'
    })).filter(r => r.latitude && r.longitude);
  }

  /**
   * Fetch 311 requests from portal via adaptive proxy.
   * Server-side: breaks date range into daily windows, re-splits capped days
   * spatially, deduplicates, and returns all results in one response.
   */
  async function fetch311Portal(paddedBbox, fromDate, toDate, opts = {}) {
    const [west, south, east, north] = paddedBbox;
    const params = new URLSearchParams({
      minlatitude: south,
      minlongitude: west,
      maxlatitude: north,
      maxlongitude: east,
      fromdate: fromDate,
      todate: toDate
    });
    if (opts.refresh) params.append('refresh', '1');

    try {
      const resp = await fetch(`/api/portal-pins-adaptive?${params}`);
      if (!resp.ok) throw new Error(`Portal fetch failed: ${resp.status}`);
      const data = await resp.json();

      if (data.error) {
        console.warn('Portal API returned error:', data.error);
        return [];
      }

      if (data.stats) {
        console.log(`Portal adaptive: ${data.stats.total_pins} pins from ${data.stats.total_calls} calls` +
          (data.stats.phase2_capped_days > 0
            ? ` (${data.stats.phase2_capped_days} days re-split spatially)`
            : ''));
      }

      return (data.pins || []).map(p => ({
        ...p,
        _source: 'portal'
      }));
    } catch (err) {
      console.warn('Portal fetch failed (non-critical):', err.message);
      return []; // Portal data is supplementary, don't break the app
    }
  }

  return { fetchBIDs, fetch311OpenData, fetch311Portal };
})();
