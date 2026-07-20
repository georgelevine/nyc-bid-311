/**
 * matching.js — Record matching between Open Data and Portal sources
 *
 * Strategy: Match on timestamp (±3 min) +
 *           complaint_type (case-insensitive) + address (street name)
 */
const Matching = (() => {
  const TIME_WINDOW_MS = 3 * 60 * 1000; // 3 minutes
  const LOOSE_TIME_WINDOW_MS = 24 * 60 * 60 * 1000; // same-day tolerance for duplicate suppression
  const COORD_WINDOW = 0.00025; // ~25m in NYC, enough for OD vs portal geocoding drift

  /**
   * Parse the normalized ISO timestamp or the portal's legacy unzoned UTC clock.
   */
  function parsePortalDate(str) {
    if (!str) return null;
    try {
      if (/^\d{4}-\d{2}-\d{2}T/.test(str)) {
        const parsed = new Date(str);
        return Number.isFinite(parsed.getTime()) ? parsed : null;
      }

      const parts = str.match(/(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+):(\d+)\s*(AM|PM)/i);
      if (!parts) return null;

      let [, month, day, year, hours, minutes, seconds, ampm] = parts;
      hours = parseInt(hours);
      if (ampm.toUpperCase() === 'PM' && hours !== 12) hours += 12;
      if (ampm.toUpperCase() === 'AM' && hours === 12) hours = 0;

      return new Date(Date.UTC(
        parseInt(year), parseInt(month) - 1, parseInt(day),
        hours, parseInt(minutes), parseInt(seconds)
      ));
    } catch (e) {
      return null;
    }
  }

  /**
   * Parse Open Data date "2025-03-15T23:59:49.000" to Date
   * Open Data's unzoned clock aligns with the portal's UTC clock.
   */
  function parseODDate(str) {
    if (!str) return null;
    try {
      // Parse without timezone suffix — treats as local but we only use for comparison
      // Both parsePortalDate and parseODDate produce aligned values
      return new Date(str.replace('.000', '') + 'Z');
    } catch (e) {
      return null;
    }
  }

  /**
   * Extract street name from address for fuzzy matching
   */
  function normalizeAddress(addr) {
    if (!addr) return '';
    return addr
      .toUpperCase()
      .replace(/,.*$/, '')        // Remove everything after first comma
      .replace(/\s+/g, ' ')       // Collapse whitespace
      .replace(/^\d+\s+/, '')     // Remove leading house number
      .trim();
  }

  function normalizeType(type) {
    return (type || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  }

  function sameType(a, b) {
    const ta = normalizeType(a);
    const tb = normalizeType(b);
    return !!ta && !!tb && (ta === tb || ta.includes(tb) || tb.includes(ta));
  }

  function addressCompatible(a, b) {
    const aa = normalizeAddress(a);
    const bb = normalizeAddress(b);
    if (!aa || !bb) return true;
    if (aa.includes(bb) || bb.includes(aa)) return true;
    // Street names can arrive with slightly different house-number/corner text.
    const aWords = new Set(aa.split(' ').filter(w => w.length > 2));
    const bWords = bb.split(' ').filter(w => w.length > 2);
    return bWords.some(w => aWords.has(w));
  }

  function coordsClose(od, pin) {
    if (od.latitude == null || od.longitude == null || pin.latitude == null || pin.longitude == null) return false;
    return Math.abs(parseFloat(od.latitude) - parseFloat(pin.latitude)) <= COORD_WINDOW &&
           Math.abs(parseFloat(od.longitude) - parseFloat(pin.longitude)) <= COORD_WINDOW;
  }

  /**
   * Match portal pins against Open Data records.
   * Returns { matched, odOnly, portalOnly }
   *
   * matched: array of { od, portal } pairs
   * odOnly: array of od records not matched
   * portalOnly: array of portal records not matched
   */
  function matchRecords(odRecords, portalPins) {
    const matched = [];
    const portalMatched = new Set();
    const odMatched = new Set();

    // Build index of OD records by complaint type for faster lookup
    const odByType = {};
    for (let i = 0; i < odRecords.length; i++) {
      const type = normalizeType(odRecords[i].complaint_type);
      if (!odByType[type]) odByType[type] = [];
      odByType[type].push(i);
    }

    // For each portal pin, find best OD match
    for (let pi = 0; pi < portalPins.length; pi++) {
      const pin = portalPins[pi];
      const portalDate = parsePortalDate(pin.submitteddate);
      if (!portalDate) continue;

      const portalType = normalizeType(pin.problem);
      const portalAddr = normalizeAddress(pin.address);
      const candidates = odByType[portalType] || [];

      let bestMatch = null;
      let bestTimeDiff = Infinity;

      for (const oi of candidates) {
        if (odMatched.has(oi)) continue; // Already matched

        const od = odRecords[oi];
        const odDate = parseODDate(od.created_date);
        if (!odDate) continue;

        const timeDiff = Math.abs(portalDate.getTime() - odDate.getTime());
        if (timeDiff > TIME_WINDOW_MS) continue;

        // Check address similarity
        const odAddr = normalizeAddress(od.incident_address);
        if (odAddr && portalAddr && !portalAddr.includes(odAddr) && !odAddr.includes(portalAddr)) {
          // Addresses don't match at all, skip unless both are empty
          if (odAddr.length > 3 && portalAddr.length > 3) continue;
        }

        if (timeDiff < bestTimeDiff) {
          bestTimeDiff = timeDiff;
          bestMatch = oi;
        }
      }

      if (bestMatch !== null) {
        matched.push({
          od: odRecords[bestMatch],
          portal: pin,
          _source: 'matched',
          _timeDiff: bestTimeDiff
        });
        odMatched.add(bestMatch);
        portalMatched.add(pi);
      }
    }

    // Fallback duplicate suppression: the primary matcher is intentionally strict,
    // but OD and Portal can represent the same request with slightly shifted
    // timestamps, coordinates, or address text. Merge those clear near-duplicates
    // before calling anything "Portal only."
    for (let pi = 0; pi < portalPins.length; pi++) {
      if (portalMatched.has(pi)) continue;
      const pin = portalPins[pi];
      const portalDate = parsePortalDate(pin.submitteddate);
      if (!portalDate) continue;

      let bestMatch = null;
      let bestScore = Infinity;

      for (let oi = 0; oi < odRecords.length; oi++) {
        if (odMatched.has(oi)) continue;
        const od = odRecords[oi];
        if (!sameType(od.complaint_type, pin.problem)) continue;
        if (!coordsClose(od, pin)) continue;
        if (!addressCompatible(od.incident_address, pin.address)) continue;

        const odDate = parseODDate(od.created_date);
        if (!odDate) continue;
        const timeDiff = Math.abs(portalDate.getTime() - odDate.getTime());
        if (timeDiff > LOOSE_TIME_WINDOW_MS) continue;

        const coordScore =
          Math.abs(parseFloat(od.latitude) - parseFloat(pin.latitude)) +
          Math.abs(parseFloat(od.longitude) - parseFloat(pin.longitude));
        const score = timeDiff + coordScore * 100000000;
        if (score < bestScore) {
          bestScore = score;
          bestMatch = oi;
        }
      }

      if (bestMatch !== null) {
        matched.push({
          od: odRecords[bestMatch],
          portal: pin,
          _source: 'matched',
          _fallbackMatch: true
        });
        odMatched.add(bestMatch);
        portalMatched.add(pi);
      }
    }

    // Collect unmatched
    const odOnly = odRecords.filter((_, i) => !odMatched.has(i)).map(r => ({ ...r, _source: 'opendata' }));
    const portalOnly = portalPins.filter((_, i) => !portalMatched.has(i)).map(r => ({ ...r, _source: 'portal' }));

    return { matched, odOnly, portalOnly };
  }

  /**
   * Merge a matched pair into a single display record
   */
  function mergeRecord(pair) {
    const { od, portal } = pair;
    return {
      // Use Open Data as primary (better coordinates, richer fields)
      unique_key: od.unique_key,
      complaint_type: od.complaint_type,
      descriptor: od.descriptor,
      status: od.status,
      agency: od.agency,
      agency_name: od.agency_name,
      created_date: od.created_date,
      closed_date: od.closed_date,
      resolution_description: od.resolution_description,
      incident_address: od.incident_address,
      city: od.city,
      borough: od.borough,
      incident_zip: od.incident_zip,
      latitude: parseFloat(od.latitude),
      longitude: parseFloat(od.longitude),
      community_board: od.community_board,
      open_data_channel_type: od.open_data_channel_type,
      location_type: od.location_type,
      bbl: od.bbl,
      // Portal-exclusive fields
      srnumber: portal.srnumber,
      portalUrl: portal.portalUrl,
      portalId: portal.id,
      // Source
      _source: 'matched'
    };
  }

  /**
   * Create a display record from an OD-only record
   */
  function odRecord(od) {
    return {
      unique_key: od.unique_key,
      complaint_type: od.complaint_type,
      descriptor: od.descriptor,
      status: od.status,
      agency: od.agency,
      agency_name: od.agency_name,
      created_date: od.created_date,
      closed_date: od.closed_date,
      resolution_description: od.resolution_description,
      incident_address: od.incident_address,
      city: od.city,
      borough: od.borough,
      incident_zip: od.incident_zip,
      latitude: parseFloat(od.latitude),
      longitude: parseFloat(od.longitude),
      community_board: od.community_board,
      open_data_channel_type: od.open_data_channel_type,
      location_type: od.location_type,
      bbl: od.bbl,
      srnumber: null,
      portalUrl: null,
      _source: 'opendata'
    };
  }

  /**
   * Create a display record from a portal-only record
   */
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

  return { matchRecords, mergeRecord, odRecord, portalRecord, parsePortalDate, parseODDate };
})();
