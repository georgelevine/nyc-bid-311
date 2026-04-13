const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Proxy: 311 Portal pin fetch
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
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (compatible; NYC-BID-311-Explorer/1.0)',
        'Referer': 'https://portal.311.nyc.gov/check-status/',
        'Origin': 'https://portal.311.nyc.gov'
      }
    });

    const text = await response.text();

    // The portal may return HTML wrapping JSON, or pure JSON
    // Try to extract JSON array from the response
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      // Try to find JSON array within HTML
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        data = JSON.parse(jsonMatch[0]);
      } else {
        return res.json({ error: 'Could not parse portal response', pins: [] });
      }
    }

    // Normalize response
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
