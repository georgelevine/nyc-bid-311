/**
 * data.js — BID boundaries and live NYC 311 Portal data
 */
const Data = (() => {
  const BID_URL = 'https://data.cityofnewyork.us/resource/7jdm-inj8.geojson?$limit=100';
  const BID_CACHE_KEY = 'nyc_bid_geojson';
  const BID_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
  const portalDetailCache = new Map();

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

  function portalRecord(pin) {
    return {
      unique_key: null,
      complaint_type: pin.problem,
      descriptor: null,
      status: pin.status,
      agency: null,
      agency_name: null,
      created_date: pin.submitteddate,
      closed_date: null,
      resolution_description: null,
      incident_address: pin.address,
      city: null,
      borough: null,
      incident_zip: null,
      latitude: pin.latitude,
      longitude: pin.longitude,
      community_board: null,
      open_data_channel_type: null,
      location_type: null,
      bbl: null,
      srnumber: pin.srnumber,
      portalUrl: pin.portalUrl,
      portalId: pin.id,
      _source: 'portal'
    };
  }

  function fetchPortalDetail(portalId) {
    if (!portalId) return Promise.resolve(null);
    if (portalDetailCache.has(portalId)) return portalDetailCache.get(portalId);

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    const request = fetch(`/api/portal-detail?id=${encodeURIComponent(portalId)}`, {
      signal: controller.signal
    })
      .then(resp => {
        if (!resp.ok) throw new Error(`Portal detail fetch failed: ${resp.status}`);
        return resp.json();
      })
      .catch(err => {
        portalDetailCache.delete(portalId);
        console.warn('Portal case detail unavailable:', err.message);
        return null;
      })
      .finally(() => window.clearTimeout(timeout));

    portalDetailCache.set(portalId, request);
    return request;
  }

  return { fetchBIDs, fetch311Portal, fetchPortalDetail, portalRecord };
})();
