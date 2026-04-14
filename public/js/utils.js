/**
 * utils.js — Shared helpers (loaded first, before app modules)
 */
const Utils = (() => {
  /**
   * HTML-escape a string via DOM text node.
   */
  function esc(str) {
    if (str === null || str === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  /**
   * Normalize a created/closed date string to YYYY-MM-DD.
   * Handles:
   *   - ISO: "2026-04-12T00:00:00", "2026-04-12T00:00:00.000Z"
   *   - Space: "2026-04-12 03:45:00"
   *   - US: "4/12/2026 3:45:00 PM", "04/12/2026"
   * Returns null if unparseable.
   */
  function parseCreatedDate(str) {
    if (!str) return null;
    const s = String(str).trim();

    // ISO 8601 — take first 10 chars
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
      return s.slice(0, 10);
    }

    // US format M/D/YYYY or MM/DD/YYYY
    const usMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (usMatch) {
      const [, m, d, y] = usMatch;
      return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }

    // Fallback: let Date parse; accept only if valid
    const dt = new Date(s);
    if (!isNaN(dt.getTime())) {
      const y = dt.getFullYear();
      const m = String(dt.getMonth() + 1).padStart(2, '0');
      const d = String(dt.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }

    return null;
  }

  return { esc, parseCreatedDate };
})();
