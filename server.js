const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// Portal fetch helpers
// ============================================================

const PORTAL_URL = 'https://portal.311.nyc.gov/entity-pin-fetch-service-requests/';
const PORTAL_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'User-Agent': 'Mozilla/5.0 (compatible; NYC-BID-311-Explorer/1.0)',
  'Referer': 'https://portal.311.nyc.gov/check-status/',
  'Origin': 'https://portal.311.nyc.gov'
};
const PORTAL_CAP = 100;       // Hard limit per request
const CONCURRENCY = 8;        // Max parallel portal calls
const CACHE_TTL = 10 * 60 * 1000; // 10-minute cache

// Simple in-memory cache: key → { data, timestamp }
const cache = new Map();

function cacheKey(params) {
  return JSON.stringify(params);
}

function getCached(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) return entry.data;
  if (entry) cache.delete(key);
  return null;
}

function setCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
  // Evict old entries if cache grows too large
  if (cache.size > 500) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

/**
 * Fetch a single portal window. Returns normalized pins array.
 */
async function fetchPortalWindow(bbox, fromdate, todate) {
  const params = new URLSearchParams();
  if (bbox.minlatitude) params.append('minlatitude', bbox.minlatitude);
  if (bbox.minlongitude) params.append('minlongitude', bbox.minlongitude);
  if (bbox.maxlatitude) params.append('maxlatitude', bbox.maxlatitude);
  if (bbox.maxlongitude) params.append('maxlongitude', bbox.maxlongitude);
  params.append('fromdate', fromdate);
  params.append('todate', todate);

  const url = `${PORTAL_URL}?${params.toString()}`;
  const response = await fetch(url, { headers: PORTAL_HEADERS });
  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      data = JSON.parse(jsonMatch[0]);
    } else {
      return { pins: [], hitCap: false };
    }
  }

  const pins = Array.isArray(data) ? data.map(pin => ({
    id: pin.id || null,
    srnumber: (pin.data && pin.data.srnumber) || null,
    problem: (pin.data && pin.data.problem) || pin.label || null,
    address: (pin.data && pin.data.address) || pin.sublabel || null,
    latitude: parseFloat(pin.latitude) || null,
    longitude: parseFloat(pin.longitude) || null,
    submitteddate: (pin.data && pin.data.submitteddate) || null,
    status: (pin.data && pin.data.status) || null,
    portalUrl: pin.id ? `https://portal.311.nyc.gov/sr-details/?id=${pin.id}` : null
  })) : [];

  return { pins, hitCap: pins.length >= PORTAL_CAP };
}

/**
 * Run promises with concurrency limit
 */
async function parallelLimit(tasks, limit) {
  const results = [];
  const executing = new Set();

  for (const task of tasks) {
    const p = task().then(result => {
      executing.delete(p);
      return result;
    });
    executing.add(p);
    results.push(p);

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

/**
 * Generate date pairs: split a range into daily windows.
 * Returns array of { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
 */
function dailyWindows(fromDate, toDate) {
  const windows = [];
  const start = new Date(fromDate + 'T00:00:00');
  const end = new Date(toDate + 'T00:00:00');

  const cursor = new Date(start);
  while (cursor <= end) {
    const dayStr = cursor.toISOString().split('T')[0];
    windows.push({ from: dayStr, to: dayStr });
    cursor.setDate(cursor.getDate() + 1);
  }
  return windows;
}

/**
 * Split a single day into sub-windows (6-hour chunks).
 * Portal accepts YYYY-MM-DD format, but we can use the same date
 * with different time ranges. Since the portal only takes date (not time),
 * we can't actually split within a day using the portal's fromdate/todate.
 *
 * WORKAROUND: We accept that within a single day, we can only get 100.
 * But we log which days hit the cap so the frontend can display it.
 *
 * ALTERNATIVE: We could try spatial subdivision for capped days.
 */
function spatialSubdivide(bbox, divisions) {
  const latStep = (parseFloat(bbox.maxlatitude) - parseFloat(bbox.minlatitude)) / divisions;
  const lngStep = (parseFloat(bbox.maxlongitude) - parseFloat(bbox.minlongitude)) / divisions;
  const tiles = [];

  for (let i = 0; i < divisions; i++) {
    for (let j = 0; j < divisions; j++) {
      tiles.push({
        minlatitude: (parseFloat(bbox.minlatitude) + latStep * i).toFixed(8),
        maxlatitude: (parseFloat(bbox.minlatitude) + latStep * (i + 1)).toFixed(8),
        minlongitude: (parseFloat(bbox.minlongitude) + lngStep * j).toFixed(8),
        maxlongitude: (parseFloat(bbox.minlongitude) + lngStep * (j + 1)).toFixed(8),
      });
    }
  }
  return tiles;
}

// ============================================================
// Adaptive portal endpoint
// ============================================================

app.get('/api/portal-pins-adaptive', async (req, res) => {
  const { minlatitude, minlongitude, maxlatitude, maxlongitude, fromdate, todate } = req.query;

  if (!fromdate || !todate) {
    return res.status(400).json({ error: 'fromdate and todate required' });
  }

  const bbox = { minlatitude, minlongitude, maxlatitude, maxlongitude };

  // Check cache
  const ck = cacheKey({ bbox, fromdate, todate, endpoint: 'adaptive' });
  const cached = getCached(ck);
  if (cached) {
    return res.json(cached);
  }

  try {
    // Phase 1: Daily windows
    const days = dailyWindows(fromdate, todate);
    console.log(`[adaptive] Phase 1: ${days.length} daily windows for ${fromdate} to ${todate}`);

    const dayTasks = days.map(day => () => fetchPortalWindow(bbox, day.from, day.to));
    const dayResults = await parallelLimit(dayTasks, CONCURRENCY);

    // Collect results and identify capped days
    let allPins = [];
    const cappedDays = [];

    for (let i = 0; i < dayResults.length; i++) {
      const { pins, hitCap } = dayResults[i];
      allPins = allPins.concat(pins);
      if (hitCap) {
        cappedDays.push(days[i]);
      }
    }

    const phase1Count = allPins.length;
    const phase1Calls = days.length;

    // Phase 2: For capped days, retry with spatial subdivision (2x2 grid = 4 tiles)
    let phase2Calls = 0;
    if (cappedDays.length > 0) {
      console.log(`[adaptive] Phase 2: ${cappedDays.length} capped days, subdividing spatially (2x2)`);

      const tileTasks = [];
      for (const day of cappedDays) {
        const tiles = spatialSubdivide(bbox, 2); // 2x2 = 4 tiles
        for (const tile of tiles) {
          tileTasks.push(() => fetchPortalWindow(tile, day.from, day.to));
        }
      }

      const tileResults = await parallelLimit(tileTasks, CONCURRENCY);
      phase2Calls = tileTasks.length;

      // Remove the capped-day pins (we're replacing them with tile results)
      const cappedDateSet = new Set(cappedDays.map(d => d.from));
      allPins = allPins.filter(pin => {
        // Keep pin if its date is NOT in a capped day
        if (!pin.submitteddate) return true;
        // Parse portal date to get the day
        const match = pin.submitteddate.match(/(\d+)\/(\d+)\/(\d+)/);
        if (!match) return true;
        const [, m, d, y] = match;
        const dayStr = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
        return !cappedDateSet.has(dayStr);
      });

      // Add tile results
      for (const { pins } of tileResults) {
        allPins = allPins.concat(pins);
      }
    }

    // Phase 3: Deduplicate by srnumber (tiles may overlap at edges)
    const seen = new Set();
    const deduped = [];
    for (const pin of allPins) {
      const key = pin.srnumber || pin.id || `${pin.latitude}-${pin.longitude}-${pin.submitteddate}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(pin);
      }
    }

    const result = {
      pins: deduped,
      count: deduped.length,
      stats: {
        phase1_days: days.length,
        phase1_calls: phase1Calls,
        phase1_pins: phase1Count,
        phase2_capped_days: cappedDays.length,
        phase2_calls: phase2Calls,
        phase2_pins_after_dedup: deduped.length - (phase1Count - cappedDays.length * PORTAL_CAP),
        total_calls: phase1Calls + phase2Calls,
        total_pins: deduped.length,
        capped_days: cappedDays.map(d => d.from)
      }
    };

    // Cache the result
    setCache(ck, result);

    console.log(`[adaptive] Done: ${deduped.length} pins from ${phase1Calls + phase2Calls} calls (${cappedDays.length} days re-split)`);
    res.json(result);

  } catch (err) {
    console.error('Adaptive portal error:', err.message);
    res.status(500).json({ error: err.message, pins: [], stats: {} });
  }
});

// ============================================================
// Original simple portal endpoint (kept for backward compat)
// ============================================================

app.get('/api/portal-pins', async (req, res) => {
  try {
    const params = new URLSearchParams();
    if (req.query.borough) params.append('borough', req.query.borough);
    if (req.query.fromdate) params.append('fromdate', req.query.fromdate);
    if (req.query.todate) params.append('todate', req.query.todate);
    if (req.query.minlatitude) params.append('minlatitude', req.query.minlatitude);
    if (req.query.minlongitude) params.append('minlongitude', req.query.minlongitude);
    if (req.query.maxlatitude) params.append('maxlatitude', req.query.maxlatitude);
    if (req.query.maxlongitude) params.append('maxlongitude', req.query.maxlongitude);
    if (req.query.problemarea) params.append('problemarea', req.query.problemarea);
    if (req.query.problem) params.append('problem', req.query.problem);

    const url = `https://portal.311.nyc.gov/entity-pin-fetch-service-requests/?${params.toString()}`;
    const response = await fetch(url, { headers: PORTAL_HEADERS });
    const text = await response.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        data = JSON.parse(jsonMatch[0]);
      } else {
        return res.json({ error: 'Could not parse portal response', pins: [] });
      }
    }

    const pins = Array.isArray(data) ? data.map(pin => ({
      id: pin.id || null,
      srnumber: (pin.data && pin.data.srnumber) || null,
      problem: (pin.data && pin.data.problem) || pin.label || null,
      address: (pin.data && pin.data.address) || pin.sublabel || null,
      latitude: parseFloat(pin.latitude) || null,
      longitude: parseFloat(pin.longitude) || null,
      submitteddate: (pin.data && pin.data.submitteddate) || null,
      status: (pin.data && pin.data.status) || null,
      portalUrl: pin.id ? `https://portal.311.nyc.gov/sr-details/?id=${pin.id}` : null
    })) : [];

    res.json({ pins, count: pins.length, raw_count: Array.isArray(data) ? data.length : 0 });
  } catch (err) {
    console.error('Portal proxy error:', err.message);
    res.status(500).json({ error: err.message, pins: [] });
  }
});

// Proxy: 311 Portal SR number lookup
app.get('/api/portal-sr', async (req, res) => {
  try {
    const number = req.query.number;
    if (!number) return res.status(400).json({ error: 'number parameter required' });

    const url = `https://portal.311.nyc.gov/check-status/?number=${encodeURIComponent(number)}`;
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (compatible; NYC-BID-311-Explorer/1.0)',
        'Referer': 'https://portal.311.nyc.gov/check-status/'
      }
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        data = JSON.parse(jsonMatch[0]);
      } else {
        return res.json({ error: 'Could not parse SR lookup response' });
      }
    }

    res.json(data);
  } catch (err) {
    console.error('SR lookup proxy error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`NYC BID 311 Explorer running at http://localhost:${PORT}`);
});
