/**
 * summary.js — Summary panel stats and Chart.js visualizations
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
      legend: {
        labels: { color: '#9aa0a6', font: { size: 11 } }
      }
    }
  };

  /**
   * Update all summary stats and charts
   * matchResult: { matched, odOnly, portalOnly }
   * allRecords: merged display records array
   */
  function update(matchResult, allRecords) {
    const section = document.getElementById('summary-section');
    section.classList.remove('hidden');

    // Counts
    const total = allRecords.length;
    const matchedCount = matchResult.matched.length;
    const odOnlyCount = matchResult.odOnly.length;
    const portalOnlyCount = matchResult.portalOnly.length;
    // Match rate: of portal records that were returned, how many found an OD match?
    const portalTotal = matchedCount + portalOnlyCount;
    const matchRate = portalTotal > 0 ? ((matchedCount / portalTotal) * 100).toFixed(1) : '—';

    document.getElementById('stat-total').textContent = total.toLocaleString();
    document.getElementById('stat-matched').textContent = matchedCount.toLocaleString();
    document.getElementById('stat-od-only').textContent = odOnlyCount.toLocaleString();
    document.getElementById('stat-portal-only').textContent = portalOnlyCount.toLocaleString();
    document.getElementById('stat-match-rate').textContent = `${matchRate}%`;

    // Status breakdown
    updateStatusChart(allRecords);

    // Top complaint types
    updateComplaintsChart(allRecords);

    // Agency breakdown
    updateAgencyList(allRecords);

    // Avg time to close
    updateAvgClose(allRecords);

    // Channel breakdown
    updateChannelChart(allRecords);

    // Timeline
    updateTimelineChart(allRecords);
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
      `<div class="agency-row"><span class="agency-name">${esc(truncate(name, 35))}</span><span class="agency-count">${count.toLocaleString()}</span></div>`
    ).join('');
  }

  function updateAvgClose(records) {
    const closedRecords = records.filter(r => r.created_date && r.closed_date);
    let totalDays = 0;
    let count = 0;

    for (const r of closedRecords) {
      try {
        const created = new Date(r.created_date);
        const closed = new Date(r.closed_date);
        const days = (closed - created) / (1000 * 60 * 60 * 24);
        if (days >= 0 && days < 365) { // Filter outliers
          totalDays += days;
          count++;
        }
      } catch (e) { /* skip */ }
    }

    const avg = count > 0 ? (totalDays / count).toFixed(1) : '—';
    document.getElementById('stat-avg-close').textContent = avg === '—' ? avg : `${avg} days`;
  }

  function updateChannelChart(records) {
    const counts = {};
    for (const r of records) {
      const c = r.open_data_channel_type || 'Unknown';
      counts[c] = (counts[c] || 0) + 1;
    }

    const labels = Object.keys(counts);
    const data = Object.values(counts);
    const colors = ['#60a5fa', '#34d399', '#fb923c', '#a78bfa', '#f87171', '#94a3b8'];

    if (channelChart) channelChart.destroy();
    channelChart = new Chart(document.getElementById('channel-chart'), {
      type: 'doughnut',
      data: { labels, datasets: [{ data, backgroundColor: colors.slice(0, data.length), borderWidth: 0 }] },
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

  function updateTimelineChart(records) {
    // Group by day
    const dayCounts = {};
    for (const r of records) {
      if (!r.created_date) continue;
      try {
        const day = r.created_date.includes('T')
          ? r.created_date.split('T')[0]
          : r.created_date.split(' ')[0];
        dayCounts[day] = (dayCounts[day] || 0) + 1;
      } catch (e) { /* skip */ }
    }

    const sorted = Object.entries(dayCounts).sort((a, b) => a[0].localeCompare(b[0]));
    const labels = sorted.map(([d]) => {
      const dt = new Date(d + 'T00:00:00');
      return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
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

  function esc(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  return { update };
})();
