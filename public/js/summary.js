/**
 * summary.js — Summary panel stats and Chart.js visualizations
 * Now leads with status-focused stats; data source info collapsed at bottom
 */
const Summary = (() => {
  let statusChart = null;
  let complaintsChart = null;
  let channelChart = null;
  let timelineChart = null;

  const chartDefaults = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { labels: { color: '#9aa0a6', font: { size: 11 } } }
    }
  };

  /**
   * Update all summary stats and charts
   */
  function update(matchResult, allRecords, activeFilters) {
    const section = document.getElementById('summary-section');
    section.classList.remove('hidden');

    const filters = activeFilters || ((typeof App !== 'undefined' && App.getActiveFilters) ? App.getActiveFilters() : { status: 'all' });
    const filter = filters.status || 'all';

    renderActiveFilterPills(filters);
    renderStatCards(allRecords, filter);

    // Status donut only makes sense when showing all requests (otherwise it's 100% one color)
    const statusContainer = document.getElementById('status-chart-container');
    const statusHeader = document.getElementById('status-section-header');
    const showStatus = filter === 'all';
    if (statusContainer) statusContainer.classList.toggle('hidden', !showStatus);
    if (statusHeader) statusHeader.classList.toggle('hidden', !showStatus);

    // Data source breakdown — respect the current status filter, so users see what
    // share of the CURRENTLY VISIBLE requests came from each source.
    let matchedCount = 0, odOnlyCount = 0, portalOnlyCount = 0;
    for (const r of allRecords) {
      if (r._source === 'matched') matchedCount++;
      else if (r._source === 'portal') portalOnlyCount++;
      else odOnlyCount++; // opendata / undefined
    }
    const portalTotal = matchedCount + portalOnlyCount;
    const matchRate = portalTotal > 0 ? ((matchedCount / portalTotal) * 100).toFixed(1) : '\u2014';

    document.getElementById('stat-matched').textContent = matchedCount.toLocaleString();
    document.getElementById('stat-od-only').textContent = odOnlyCount.toLocaleString();
    document.getElementById('stat-portal-only').textContent = portalOnlyCount.toLocaleString();
    document.getElementById('stat-match-rate').textContent = typeof matchRate === 'string' ? matchRate : `${matchRate}%`;

    // Stacked bar widths
    const totalSources = matchedCount + odOnlyCount + portalOnlyCount;
    const pct = (n) => totalSources > 0 ? `${(n / totalSources * 100).toFixed(1)}%` : '0%';
    const m = document.getElementById('source-bar-matched');
    const od = document.getElementById('source-bar-od');
    const p = document.getElementById('source-bar-portal');
    if (m) m.style.width = pct(matchedCount);
    if (od) od.style.width = pct(odOnlyCount);
    if (p) p.style.width = pct(portalOnlyCount);

    // Charts
    updateStatusChart(allRecords);
    updateComplaintsChart(allRecords);
    updateAgencyList(allRecords);
    updateChannelChart(allRecords);
    updateTimelineChart(allRecords);
  }

  /**
   * Active filter breadcrumbs — one pill per non-default filter dimension, with × to clear.
   */
  function renderActiveFilterPills(filters) {
    const wrap = document.getElementById('active-filters');
    if (!wrap) return;

    const pills = [];
    if (filters.complaintType) pills.push({ dim: 'complaintType', label: 'Type', value: filters.complaintType });
    if (filters.agency)        pills.push({ dim: 'agency',        label: 'Agency', value: filters.agency });
    if (filters.channel)       pills.push({ dim: 'channel',       label: 'Channel', value: filters.channel });

    if (pills.length === 0) {
      wrap.classList.add('hidden');
      wrap.innerHTML = '';
      return;
    }

    wrap.classList.remove('hidden');
    wrap.innerHTML = pills.map(p =>
      `<span class="filter-pill"><span class="pill-label">${Utils.esc(p.label)}:</span> <span class="pill-value">${Utils.esc(p.value)}</span><button class="pill-clear" data-dim="${p.dim}" aria-label="Clear ${Utils.esc(p.label)} filter">&times;</button></span>`
    ).join('') + `<button class="filter-pill pill-clear-all" id="clear-all-filters">Clear all</button>`;

    wrap.querySelectorAll('.pill-clear').forEach(btn =>
      btn.addEventListener('click', () => App.clearFilter(btn.dataset.dim))
    );
    const clearAll = document.getElementById('clear-all-filters');
    if (clearAll) clearAll.addEventListener('click', () => App.clearAllFilters());
  }

  /**
   * Context-aware stat cards. The same space means different things based on filter.
   */
  function renderStatCards(records, filter) {
    const grid = document.getElementById('stat-grid');
    if (!grid) return;

    let cards;
    if (filter === 'closed') cards = closedCards(records);
    else if (filter === 'open') cards = openCards(records);
    else cards = allCards(records);

    grid.innerHTML = cards.map(c =>
      `<div class="stat-card"><div class="stat-value" title="${Utils.esc(c.title || '')}">${c.value}</div><div class="stat-label">${Utils.esc(c.label)}</div></div>`
    ).join('');
  }

  function allCards(records) {
    const total = records.length;
    const closed = records.filter(isClosed);
    const open = total - closed.length;
    const avg = avgDaysToClose(closed);
    return [
      { label: 'Total', value: total.toLocaleString() },
      { label: 'Open', value: open.toLocaleString() },
      { label: 'Closed', value: closed.length.toLocaleString() },
      { label: 'Avg. Days to Close', value: avg == null ? '—' : avg.toFixed(1), title: 'Average time from creation to close across closed requests' }
    ];
  }

  function openCards(records) {
    const total = records.length;
    const inProgress = records.filter(r => (r.status || '').toLowerCase().includes('progress')).length;
    const ages = records.map(r => daysSince(r.created_date)).filter(n => n != null && n >= 0);
    const avgAge = ages.length ? ages.reduce((a, b) => a + b, 0) / ages.length : null;
    const oldest = ages.length ? Math.max(...ages) : null;
    return [
      { label: 'Open', value: total.toLocaleString() },
      { label: 'In Progress', value: inProgress.toLocaleString(), title: 'Subset of open requests explicitly marked "In Progress"' },
      { label: 'Avg. Age (days)', value: avgAge == null ? '—' : avgAge.toFixed(1), title: 'Average days since creation' },
      { label: 'Oldest (days)', value: oldest == null ? '—' : String(Math.round(oldest)), title: 'Days since creation of the oldest open request' }
    ];
  }

  function closedCards(records) {
    const total = records.length;
    const durations = records
      .map(r => {
        const created = Utils.parseCreatedDate(r.created_date);
        const closed = Utils.parseCreatedDate(r.closed_date);
        if (!created || !closed) return null;
        const d = (new Date(closed) - new Date(created)) / (1000 * 60 * 60 * 24);
        return d >= 0 && d < 365 ? d : null;
      })
      .filter(d => d != null);

    const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
    const median = durations.length ? medianOf(durations) : null;
    const sameDay = durations.filter(d => d < 1).length;
    const sameDayPct = durations.length ? (sameDay / durations.length * 100) : null;

    return [
      { label: 'Closed', value: total.toLocaleString() },
      { label: 'Avg. Days to Close', value: avg == null ? '—' : avg.toFixed(1), title: 'Mean days from creation to close' },
      { label: 'Median Days', value: median == null ? '—' : median.toFixed(1), title: 'Middle value — robust against outliers' },
      { label: 'Same-Day Close', value: sameDayPct == null ? '—' : `${sameDayPct.toFixed(0)}%`, title: 'Share of requests closed within 24h of creation' }
    ];
  }

  function isClosed(r) { return (r.status || '').toLowerCase() === 'closed'; }

  function daysSince(dateStr) {
    const iso = Utils.parseCreatedDate(dateStr);
    if (!iso) return null;
    return (Date.now() - new Date(iso + 'T00:00:00').getTime()) / (1000 * 60 * 60 * 24);
  }

  function avgDaysToClose(closed) {
    const durations = [];
    for (const r of closed) {
      const created = Utils.parseCreatedDate(r.created_date);
      const cls = Utils.parseCreatedDate(r.closed_date);
      if (!created || !cls) continue;
      const d = (new Date(cls) - new Date(created)) / (1000 * 60 * 60 * 24);
      if (d >= 0 && d < 365) durations.push(d);
    }
    if (!durations.length) return null;
    return durations.reduce((a, b) => a + b, 0) / durations.length;
  }

  function medianOf(arr) {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function updateStatusChart(records) {
    const counts = {};
    for (const r of records) {
      const s = r.status || 'Unknown';
      counts[s] = (counts[s] || 0) + 1;
    }

    const labels = Object.keys(counts);
    const data = Object.values(counts);
    const colors = labels.map(l => {
      const lower = l.toLowerCase();
      if (lower === 'closed') return '#34d399';
      if (lower.includes('progress')) return '#fb923c';
      if (lower === 'open') return '#60a5fa';
      return '#94a3b8';
    });

    if (statusChart) statusChart.destroy();
    statusChart = new Chart(document.getElementById('status-chart'), {
      type: 'doughnut',
      data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 0 }] },
      options: {
        ...chartDefaults,
        cutout: '60%',
        plugins: {
          ...chartDefaults.plugins,
          legend: { position: 'bottom', labels: { color: '#9aa0a6', font: { size: 10 }, padding: 8 } }
        }
      }
    });
  }

  function updateComplaintsChart(records) {
    const counts = {};
    for (const r of records) {
      const t = r.complaint_type || 'Unknown';
      counts[t] = (counts[t] || 0) + 1;
    }

    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const fullLabels = sorted.map(([t]) => t);
    const labels = sorted.map(([t]) => truncate(t, 25));
    const data = sorted.map(([, c]) => c);

    if (complaintsChart) complaintsChart.destroy();
    complaintsChart = new Chart(document.getElementById('complaints-chart'), {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          data,
          backgroundColor: MapView.TYPE_COLORS.slice(0, data.length),
          borderWidth: 0,
          borderRadius: 4
        }]
      },
      options: {
        ...chartDefaults,
        indexAxis: 'y',
        onClick: (evt, elements) => {
          if (!elements.length) return;
          const type = fullLabels[elements[0].index];
          if (type) App.setFilter('complaintType', type);
        },
        onHover: (evt, elements) => {
          evt.native.target.style.cursor = elements.length ? 'pointer' : '';
        },
        plugins: { ...chartDefaults.plugins, legend: { display: false } },
        scales: {
          x: { ticks: { color: '#6b7280', font: { size: 10 } }, grid: { color: '#383d47' } },
          y: { ticks: { color: '#9aa0a6', font: { size: 10 } }, grid: { display: false } }
        }
      }
    });
  }

  function updateAgencyList(records) {
    const counts = {};
    for (const r of records) {
      const a = r.agency_name || r.agency || 'Unknown';
      counts[a] = (counts[a] || 0) + 1;
    }

    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const container = document.getElementById('agency-list');
    container.innerHTML = sorted.map(([name, count]) =>
      `<button type="button" class="agency-row" data-agency="${Utils.esc(name)}" title="Filter to ${Utils.esc(name)}"><span class="agency-name">${Utils.esc(truncate(name, 35))}</span><span class="agency-count">${count.toLocaleString()}</span></button>`
    ).join('');
    container.querySelectorAll('.agency-row').forEach(btn =>
      btn.addEventListener('click', () => App.setFilter('agency', btn.dataset.agency))
    );
  }

  function updateChannelChart(records) {
    const counts = {};
    for (const r of records) {
      // Normalize channel: collapse any falsy / unknown / case variants into a single bucket
      const raw = (r.open_data_channel_type || '').trim();
      const key = raw ? raw.toUpperCase() : 'UNKNOWN';
      // Title-case for display (MOBILE -> Mobile, UNKNOWN -> Unknown)
      const display = key.charAt(0) + key.slice(1).toLowerCase();
      counts[display] = (counts[display] || 0) + 1;
    }

    const sortedEntries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const labels = sortedEntries.map(([l]) => l);
    const data = sortedEntries.map(([, c]) => c);
    const colors = ['#60a5fa', '#34d399', '#fb923c', '#a78bfa', '#f87171', '#94a3b8'];

    if (channelChart) channelChart.destroy();
    channelChart = new Chart(document.getElementById('channel-chart'), {
      type: 'doughnut',
      data: { labels, datasets: [{ data, backgroundColor: colors.slice(0, data.length), borderWidth: 0 }] },
      options: {
        ...chartDefaults,
        cutout: '60%',
        onClick: (evt, elements) => {
          if (!elements.length) return;
          const channel = labels[elements[0].index];
          if (channel) App.setFilter('channel', channel);
        },
        onHover: (evt, elements) => {
          evt.native.target.style.cursor = elements.length ? 'pointer' : '';
        },
        plugins: {
          ...chartDefaults.plugins,
          legend: { position: 'bottom', labels: { color: '#9aa0a6', font: { size: 10 }, padding: 8 } }
        }
      }
    });
  }

  function updateTimelineChart(records) {
    const dayCounts = {};
    for (const r of records) {
      const day = Utils.parseCreatedDate(r.created_date);
      if (!day) continue;
      dayCounts[day] = (dayCounts[day] || 0) + 1;
    }

    const sorted = Object.entries(dayCounts).sort((a, b) => a[0].localeCompare(b[0]));
    const labels = sorted.map(([d]) => {
      const dt = new Date(d + 'T00:00:00');
      return isNaN(dt.getTime())
        ? d
        : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    });
    const data = sorted.map(([, c]) => c);

    if (timelineChart) timelineChart.destroy();
    timelineChart = new Chart(document.getElementById('timeline-chart'), {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data,
          borderColor: '#4f9cf7',
          backgroundColor: 'rgba(79, 156, 247, 0.1)',
          fill: true,
          borderWidth: 2,
          pointRadius: sorted.length > 60 ? 0 : 3,
          pointBackgroundColor: '#4f9cf7',
          tension: 0.3
        }]
      },
      options: {
        ...chartDefaults,
        plugins: { ...chartDefaults.plugins, legend: { display: false } },
        scales: {
          x: {
            ticks: { color: '#6b7280', font: { size: 9 }, maxRotation: 45, autoSkip: true, maxTicksLimit: 15 },
            grid: { color: '#383d47' }
          },
          y: {
            ticks: { color: '#6b7280', font: { size: 10 } },
            grid: { color: '#383d47' },
            beginAtZero: true
          }
        }
      }
    });
  }

  // Helpers
  function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.substring(0, len) + '...' : str;
  }

  return { update };
})();
