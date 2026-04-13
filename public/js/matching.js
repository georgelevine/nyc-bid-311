/**
 * matching.js — Record matching between Open Data and Portal sources
 *
 * Strategy: Match on timestamp (±3 min, with ET→UTC offset) +
 *           complaint_type (case-insensitive) + address (street name)
 */
const Matching = (() => {
  const TIME_WINDOW_MS = 3 * 60 * 1000; // 3 minutes

  /**
   * Parse portal date "M/D/YYYY H:MM:SS AM/PM" (Eastern Time) to UTC Date
   */
  function parsePortalDate(str) {
    if (!str) return null;
    try {
      // Portal dates are in Eastern Time
      // Parse manually: "3/16/2025 3:59:49 AM"
      const parts = str.match(/(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+):(\d+)\s*(AM|PM)/i);
      if (!parts) return null;

      let [, month, day, year, hours, minutes, seconds, ampm] = parts;
      hours = parseInt(hours);
      if (ampm.toUpperCase() === 'PM' && hours !== 12) hours += 12;
      if (ampm.toUpperCase() === 'AM' && hours === 12) hours = 0;

      // Empirically verified: Portal numeric values minus the ET→UTC offset
      // equal Open Data numeric values. This means to align timestamps we
      // SUBTRACT the offset from portal hours.
      // Eastern is UTC-5 (EST) or UTC-4 (EDT)
      const m = parseInt(month);
      const isDST = m >= 3 && m <= 11; // Simplified DST check
      const offsetHours = isDST ? 4 : 5;

      const utcDate = new Date(Date.UTC(
        parseInt(year), parseInt(month) - 1, parseInt(day),
        hours - offsetHours, parseInt(minutes), parseInt(seconds)
      ));

      return utcDate;
    } catch (e) {
      return null;
    }
  }

  /**
   * Parse Open Data date "2025-03-15T23:59:49.000" to Date
   * Empirically: OD timestamps align with portal timestamps after subtracting
   * the ET offset from portal. We parse OD as-is (no timezone suffix) so both
   * produce the same numeric values for the same record.
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
      const type = (odRecords[i].complaint_type || '').toUpperCase();
      if (!odByType[type]) odByType[type] = [];
      odByType[type].push(i);
    }

    // For each portal pin, find best OD match
    for (let pi = 0; pi < portalPins.length; pi++) {
      const pin = portalPins[pi];
      const portalDate = parsePortalDate(pin.submitteddate);
      if (!portalDate) continue;

      const portalType = (pin.problem || '').toUpperCase();
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
