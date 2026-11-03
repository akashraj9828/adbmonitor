const $ = id => document.getElementById(id);
let source;
let selectedSerial = '';
let processRows = [];
let sortKey = 'cpu';
let sortDirection = 'desc';
let filterText = '';
let detailTimer;
let detailTarget;
let detailHistory = [];
let overviewHistory = [];
let overviewCharts = [];
let overviewPaused = false;
let overviewRange = 150;
document.querySelector('#detailContent .detail-sections')?.insertAdjacentHTML('beforebegin', '<div class="history-card"><div class="history-head"><h3>Usage history</h3><span><i class="legend-cpu"></i> CPU <i class="legend-ram"></i> RAM %</span></div><canvas id="detailChart" height="150"></canvas></div>');
const bytes = value => value > 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : `${(value / 1024 ** 2).toFixed(0)} MB`;
const processRam = value => value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} GB` : value >= 1024 ? `${(value / 1024).toFixed(1)} MB` : `${value || 0} KB`;
const pct = value => `${Number(value || 0).toFixed(1)}%`;

async function loadDevices() {
  try {
    const response = await fetch('/api/devices');
    if (!response.ok) throw new Error(await response.text());
    const { devices } = await response.json();
    const select = $('deviceSelect');
    const nextSerial = devices.includes(selectedSerial) ? selectedSerial : devices[0];
    select.innerHTML = devices.length ? devices.map(device => `<option value="${device}">${device}</option>`).join('') : '<option value="">No ADB devices found</option>';
    select.value = nextSerial || '';
    $('deviceCount').textContent = `${devices.length} connected`;
    if (nextSerial && nextSerial !== selectedSerial) connect(nextSerial); else if (!devices.length) { selectedSerial = ''; if (source) source.close(); setStatus('No devices connected', 'idle'); }
  } catch (error) { setStatus('ADB unavailable', 'error'); $('deviceSelect').innerHTML = '<option>Could not run adb</option>'; }
}

function setStatus(text, state = '') { $('statusText').textContent = text; $('statusDot').className = `dot ${state}`; }
function connect(serial) {
  if (!serial) return;
  if (source) source.close();
  selectedSerial = serial;
  overviewHistory = [];
  overviewPaused = false;
  overviewCharts.forEach(chart => chart.destroy()); overviewCharts = [];
  setStatus(`Connected · ${serial}`);
  source = new EventSource(`/api/stream?serial=${encodeURIComponent(serial)}`);
  source.addEventListener('metrics', event => render(JSON.parse(event.data)));
  source.addEventListener('error', () => setStatus(`Connection lost · ${serial}`, 'error'));
}
function render(data) {
  const cpu = data.cpu.usage, mem = data.memory, memPct = mem.total ? mem.used / mem.total * 100 : 0;
  const coreAvg = data.cpu.perCore?.length ? data.cpu.perCore.reduce((sum, core) => sum + core.usage, 0) / data.cpu.perCore.length : 0;
  if (!overviewPaused) { overviewHistory.push({ time: new Date(data.timestamp), cpu, cores: (data.cpu.perCore || []).map(core => core.usage), memory: memPct, memoryGb: mem.used / 1024 ** 3, processes: data.processes.length }); if (overviewHistory.length > 900) overviewHistory.shift(); }
  if (overviewCharts.length) updateOverviewChartUX();
  $('cpuValue').textContent = pct(cpu); $('cpuBar').style.width = `${Math.min(100, cpu)}%`; $('cpuMeta').textContent = `${data.cpu.cores} logical cores · system load`;
  $('coreUsage').innerHTML = (data.cpu.perCore || []).map(core => `<div class="core-row"><span>${core.name.toUpperCase()}</span><i><b style="width:${Math.min(100, core.usage)}%"></b></i><em>${pct(core.usage)}</em></div>`).join('');
  $('memValue').textContent = `${bytes(mem.used)} / ${bytes(mem.total)}`; $('memBar').style.width = `${Math.min(100, memPct)}%`; $('memMeta').textContent = `${bytes(mem.used)} used · ${pct(memPct)}`;
  processRows = data.processes;
  $('processValue').textContent = data.processes.length; $('updated').textContent = `Updated ${new Date(data.timestamp).toLocaleTimeString()}`;
  renderProcessTable();
  const bars = data.processes.slice(0, 24).map(p => `<i style="height:${Math.max(8, Math.min(100, p.cpu * 4))}%"></i>`).join(''); $('spark').innerHTML = bars;
}
function renderProcessTable() {
  const filtered = processRows.filter(process => Object.values(process).some(value => String(value).toLowerCase().includes(filterText)));
  const rows = [...filtered].sort((a, b) => {
    const left = a[sortKey], right = b[sortKey];
    const result = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right));
    return result * (sortDirection === 'asc' ? 1 : -1);
  });
  $('processes').innerHTML = rows.length ? rows.map(p => `<tr class="process-row" data-pid="${p.pid}" tabindex="0" title="Open process details"><td>${p.pid}</td><td title="${p.name}">${p.name}</td><td>${p.user}</td><td>${pct(p.cpu)}</td><td>${pct(p.memory)}</td><td>${p.rss ? processRam(p.rss) : '—'}</td></tr>`).join('') : '<tr><td colspan="6" class="empty">No matching processes</td></tr>';
  document.querySelectorAll('.process-row').forEach(row => { row.addEventListener('click', () => openProcess(row.dataset.pid)); row.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') openProcess(row.dataset.pid); }); });
  document.querySelectorAll('th.sortable').forEach(header => { const marker = header.querySelector('span'); marker.textContent = header.dataset.key === sortKey ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : ''; });
}
async function openProcess(pid) {
  if (!selectedSerial) return;
  detailTarget = { pid, serial: selectedSerial };
  detailHistory = [];
  $('processDetail').hidden = false;
  $('detailLoading').hidden = false;
  $('detailError').hidden = true;
  $('detailContent').hidden = true;
  await refreshProcessDetail();
  clearInterval(detailTimer);
  detailTimer = setInterval(refreshProcessDetail, 2000);
}
async function refreshProcessDetail() {
  if (!detailTarget) return;
  try {
    const response = await fetch(`/api/process?serial=${encodeURIComponent(detailTarget.serial)}&pid=${encodeURIComponent(detailTarget.pid)}`);
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json(), p = data.process, status = data.status, memory = data.memory;
    $('detailName').textContent = p.name; $('detailSubtitle').textContent = `PID ${data.pid} · ${data.serial}`;
    $('detailCpu').textContent = pct(p.cpu); $('detailRam').textContent = processRam(p.rss); $('detailMemPct').textContent = pct(p.memory); $('detailThreads').textContent = status.threads || '—';
    $('detailPid').textContent = data.pid; $('detailUser').textContent = `${p.user} · ${status.uid}`; $('detailState').textContent = status.state; $('detailPackage').textContent = data.packageName || 'Unavailable'; $('detailCommand').textContent = data.commandLine;
    $('detailPss').textContent = memory.pss ? `${memory.pss} KB` : 'Unavailable'; $('detailPrivate').textContent = memory.privateDirty ? `${memory.privateDirty} KB` : 'Unavailable'; $('detailSwap').textContent = memory.swapPss ? `${memory.swapPss} KB` : 'Unavailable'; $('detailVmSize').textContent = status.vmSize;
    detailHistory.push({ cpu: Number(p.cpu) || 0, memory: Number(p.memory) || 0 }); if (detailHistory.length > 60) detailHistory.shift(); drawHistory('detailChart', detailHistory);
    $('detailPermissions').innerHTML = data.permissions?.length ? data.permissions.map(permission => `<li>${permission}</li>`).join('') : '<li>Unavailable or not an Android package process</li>';
    const diagnostics = data.diagnostics || {};
    $('detailFds').textContent = diagnostics.fileDescriptors || 'Unavailable or permission denied'; $('detailMeminfo').textContent = diagnostics.meminfo || 'Unavailable'; $('detailStatusRaw').textContent = `${diagnostics.status || ''}${diagnostics.limits || 'Limits unavailable'}`; $('detailIo').textContent = diagnostics.io || 'Unavailable or permission denied'; $('detailSched').textContent = diagnostics.sched || 'Unavailable or permission denied'; $('detailMaps').textContent = diagnostics.maps || 'Unavailable or permission denied'; $('detailActivity').textContent = diagnostics.activityInfo || 'Unavailable or no activity-manager record'; $('detailPackageInfo').textContent = diagnostics.packageInfo || 'Unavailable or not an Android package process';
    $('detailLoading').hidden = true; $('detailContent').hidden = false;
  } catch (error) { $('detailLoading').hidden = true; $('detailContent').hidden = true; $('detailError').hidden = false; $('detailError').textContent = `Unable to read this process: ${error.message}`; }
}
function closeProcess() { clearInterval(detailTimer); detailTimer = undefined; detailTarget = undefined; $('processDetail').hidden = true; }
function createOverviewChart() {
  if (!window.Chart || overviewCharts.length) return;
  const definitions = [['overviewCpuChart', 'CPU total %', 'cpu', '#9ce15b', 100, '%'], ['overviewCoreChart', 'Average core CPU %', 'coreAvg', '#ffb866', 100, '%'], ['overviewMemoryChart', 'RAM used %', 'memory', '#b399ff', 100, '%'], ['overviewProcessChart', 'Process count', 'processes', '#78c7ff', undefined, '']];
  $('overviewChart').parentElement.innerHTML = definitions.map(([id, label]) => `<div class="overview-tile"><h3>${label}</h3><canvas id="${id}"></canvas></div>`).join('');
  definitions.forEach(([id, label, key, color, max, suffix]) => { overviewCharts.push(new Chart($(id), { type: 'line', data: { labels: overviewHistory.map(sample => sample.time.toLocaleTimeString()), datasets: [{ label, data: overviewHistory.map(sample => sample[key]), borderColor: color, backgroundColor: color, tension: .25, pointRadius: 1, pointHoverRadius: 5, fill: false }] }, options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { display: false }, tooltip: { callbacks: { title: items => items[0]?.label || '' } } }, scales: { x: { ticks: { color: '#89919e', maxTicksLimit: 8 }, grid: { color: '#222630' } }, y: { beginAtZero: true, ...(max ? { max } : {}), ticks: { color, callback: value => `${value}${suffix}` }, grid: { color: '#292e38' } } } } })); });
}
function updateOverviewChart() { if (!overviewCharts.length) return; const keys = ['cpu', 'coreAvg', 'memory', 'processes'], labels = overviewHistory.map(sample => sample.time.toLocaleTimeString()); overviewCharts.forEach((chart, index) => { chart.data.labels = labels; chart.data.datasets[0].data = overviewHistory.map(sample => sample[keys[index]]); chart.update('none'); }); }
function createOverviewChartNew() {
  if (!window.Chart || overviewCharts.length) return;
  const colors = ['#9ce15b', '#ffb866', '#b399ff', '#78c7ff', '#ff8d8d', '#8de5d1', '#d7a5ff', '#f4d35e'];
  $('overviewChart').parentElement.innerHTML = '<div class="overview-tile"><h3>CPU total %</h3><canvas id="overviewCpuChart"></canvas></div><div class="overview-tile"><h3>CPU per core</h3><canvas id="overviewCoreChart"></canvas></div><div class="overview-tile"><h3>RAM usage</h3><canvas id="overviewMemoryChart"></canvas></div><div class="overview-tile"><h3>Process count</h3><canvas id="overviewProcessChart"></canvas></div>';
  const labels = overviewHistory.map(sample => sample.time.toLocaleTimeString());
  const options = (color, max, suffix = '%') => ({ responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#89919e', maxTicksLimit: 8 }, grid: { color: '#222630' } }, y: { beginAtZero: true, ...(max ? { max } : {}), ticks: { color, callback: value => `${value}${suffix}` }, grid: { color: '#292e38' } } } });
  overviewCharts.push(new Chart($('overviewCpuChart'), { type: 'line', data: { labels, datasets: [{ label: 'CPU total %', data: overviewHistory.map(sample => sample.cpu), borderColor: '#9ce15b', pointRadius: 1, pointHoverRadius: 5, tension: .25 }] }, options: options('#9ce15b', 100) }));
  const coreCount = Math.max(0, ...overviewHistory.map(sample => sample.cores.length)); overviewCharts.push(new Chart($('overviewCoreChart'), { type: 'line', data: { labels, datasets: Array.from({ length: coreCount }, (_, index) => ({ label: `CPU${index}`, data: overviewHistory.map(sample => sample.cores[index] ?? 0), borderColor: colors[index % colors.length], pointRadius: 1, pointHoverRadius: 5, tension: .25 })) }, options: { ...options('#aeb7c4', 100), plugins: { legend: { display: true, labels: { color: '#aeb7c4', boxWidth: 10 } } } } }));
  overviewCharts.push(new Chart($('overviewMemoryChart'), { type: 'line', data: { labels, datasets: [{ label: 'RAM used', data: overviewHistory.map(sample => sample.memoryGb), borderColor: '#b399ff', pointRadius: 1, pointHoverRadius: 5, tension: .25, yAxisID: 'ram' }, { label: 'RAM used %', data: overviewHistory.map(sample => sample.memory), borderColor: '#78c7ff', pointRadius: 1, pointHoverRadius: 5, tension: .25, yAxisID: 'percent' }] }, options: { ...options('#b399ff', undefined, ' GB'), scales: { ...options('#b399ff', undefined, ' GB').scales, ram: { beginAtZero: true, position: 'left', ticks: { color: '#b399ff', callback: value => `${value} GB` }, grid: { color: '#292e38' } }, percent: { min: 0, max: 100, position: 'right', ticks: { color: '#78c7ff', callback: value => `${value}%` }, grid: { drawOnChartArea: false } } } } }));
  overviewCharts.push(new Chart($('overviewProcessChart'), { type: 'line', data: { labels, datasets: [{ label: 'Process count', data: overviewHistory.map(sample => sample.processes), borderColor: '#78c7ff', pointRadius: 2, pointHoverRadius: 5, tension: .25 }] }, options: options('#78c7ff', undefined, '') }));
}
function updateOverviewChartNew() { if (!overviewCharts.length) return; const labels = overviewHistory.map(sample => sample.time.toLocaleTimeString()); overviewCharts[0].data.labels = labels; overviewCharts[0].data.datasets[0].data = overviewHistory.map(sample => sample.cpu); overviewCharts[1].data.labels = labels; overviewCharts[1].data.datasets.forEach((dataset, index) => { dataset.data = overviewHistory.map(sample => sample.cores[index] ?? 0); }); overviewCharts[2].data.labels = labels; overviewCharts[2].data.datasets[0].data = overviewHistory.map(sample => sample.memoryGb); overviewCharts[2].data.datasets[1].data = overviewHistory.map(sample => sample.memory); overviewCharts[3].data.labels = labels; overviewCharts[3].data.datasets[0].data = overviewHistory.map(sample => sample.processes); overviewCharts.forEach(chart => chart.update('none')); }
function openOverview() { if (!selectedSerial) return; $('overviewSubtitle').textContent = `${selectedSerial} · last ${overviewHistory.length} samples`; $('overviewModal').hidden = false; createOverviewChartNew(); if (overviewCharts[2]?.options?.scales?.y) overviewCharts[2].options.scales.y.display = false; setupOverviewControls(); syncOverviewCharts(overviewCharts); updateOverviewChartUX(); }
function closeOverview() { $('overviewModal').hidden = true; }
function drawHistory(id, samples) {
  const canvas = $(id), rect = canvas.getBoundingClientRect(), ratio = window.devicePixelRatio || 1, width = Math.max(280, rect.width), height = 150;
  canvas.width = width * ratio; canvas.height = height * ratio; const context = canvas.getContext('2d'); context.scale(ratio, ratio); context.clearRect(0, 0, width, height); context.strokeStyle = '#292e38'; context.lineWidth = 1;
  [0, .5, 1].forEach(step => { const y = height * step; context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke(); });
  [['cpu', '#9ce15b'], ['memory', '#b399ff']].forEach(([key, color]) => { if (!samples.length) return; context.strokeStyle = color; context.lineWidth = 2; context.beginPath(); samples.forEach((sample, index) => { const x = samples.length === 1 ? width / 2 : index / (samples.length - 1) * width; const y = height - Math.min(100, sample[key]) / 100 * height; index ? context.lineTo(x, y) : context.moveTo(x, y); }); context.stroke(); });
}
$('deviceSelect').addEventListener('change', event => connect(event.target.value));
$('refreshBtn').addEventListener('click', loadDevices);
$('processFilter').addEventListener('input', event => { filterText = event.target.value.trim().toLowerCase(); renderProcessTable(); });
document.querySelectorAll('th.sortable').forEach(header => header.addEventListener('click', () => { if (sortKey === header.dataset.key) sortDirection = sortDirection === 'asc' ? 'desc' : 'asc'; else { sortKey = header.dataset.key; sortDirection = 'asc'; } renderProcessTable(); }));
$('closeDetail').addEventListener('click', closeProcess);
$('openFullDetail').addEventListener('click', () => { if (detailTarget) window.open(`/process.html?serial=${encodeURIComponent(detailTarget.serial)}&pid=${encodeURIComponent(detailTarget.pid)}`, '_blank', 'noopener'); });
$('processDetail').addEventListener('click', event => { if (event.target.id === 'processDetail') closeProcess(); });
$('openOverview').addEventListener('click', openOverview); $('closeOverview').addEventListener('click', closeOverview); $('overviewModal').addEventListener('click', event => { if (event.target.id === 'overviewModal') closeOverview(); }); $('openOverviewPage').addEventListener('click', () => { if (selectedSerial) window.open(`/overview.html?serial=${encodeURIComponent(selectedSerial)}`, '_blank', 'noopener'); });
loadDevices();
function updateOverviewChartGrowing() { if (!overviewCharts.length) return; const max = 180, offset = max - overviewHistory.length, labels = Array.from({ length: max }, (_, index) => overviewHistory[index - offset]?.time.toLocaleTimeString() || ''), pad = values => [...Array(Math.max(0, max - values.length)).fill(null), ...values]; overviewCharts[0].data.labels = labels; overviewCharts[0].data.datasets[0].data = pad(overviewHistory.map(sample => sample.cpu)); overviewCharts[1].data.labels = labels; overviewCharts[1].data.datasets.forEach((dataset, index) => { dataset.data = pad(overviewHistory.map(sample => sample.cores[index] ?? 0)); }); overviewCharts[2].data.labels = labels; overviewCharts[2].data.datasets[0].data = pad(overviewHistory.map(sample => sample.memoryGb)); overviewCharts[2].data.datasets[1].data = pad(overviewHistory.map(sample => sample.memory)); overviewCharts[3].data.labels = labels; overviewCharts[3].data.datasets[0].data = pad(overviewHistory.map(sample => sample.processes)); overviewCharts.forEach(chart => chart.update('none')); }
function getOverviewWindow() { const samples = overviewHistory.slice(-overviewRange), adaptive = samples.length < 30, values = adaptive ? samples : [...Array(Math.max(0, overviewRange - samples.length)).fill(null), ...samples]; return { values, labels: values.map(sample => sample?.time.toLocaleTimeString() || '') }; }
function updateOverviewChartUX() { if (!overviewCharts.length) return; const { values, labels } = getOverviewWindow(), value = key => values.map(sample => sample ? sample[key] : null); if (overviewCharts[2]?.options?.scales?.y) delete overviewCharts[2].options.scales.y; overviewCharts[0].data.labels = labels; overviewCharts[0].data.datasets[0].data = value('cpu'); overviewCharts[1].data.labels = labels; overviewCharts[1].data.datasets.forEach((dataset, index) => { dataset.data = values.map(sample => sample ? sample.cores[index] ?? 0 : null); }); overviewCharts[2].data.labels = labels; overviewCharts[2].data.datasets[0].data = value('memoryGb'); overviewCharts[2].data.datasets[1].data = value('memory'); overviewCharts[3].data.labels = labels; overviewCharts[3].data.datasets[0].data = value('processes'); overviewCharts.forEach(chart => chart.update('none')); $('overviewSubtitle').textContent = `${selectedSerial} · ${overviewHistory.length} samples · ${overviewPaused ? 'paused' : 'live'}`; }
function setupOverviewControls() { if ($('overviewControls')) return; const host = document.querySelector('#overviewModal .chart-wrap'); host.insertAdjacentHTML('afterbegin', '<div id="overviewControls" class="chart-toolbar"><span>History</span><button data-range="30">1m</button><button data-range="150" class="active">5m</button><button data-range="450">15m</button><button id="overviewPause">Pause</button><button id="overviewClear">Clear</button></div>'); $('overviewControls').addEventListener('click', event => { const range = event.target.dataset.range; if (range) { overviewRange = Number(range); document.querySelectorAll('#overviewControls [data-range]').forEach(button => button.classList.toggle('active', button.dataset.range === range)); updateOverviewChartUX(); } if (event.target.id === 'overviewPause') { overviewPaused = !overviewPaused; event.target.textContent = overviewPaused ? 'Resume' : 'Pause'; updateOverviewChartUX(); } if (event.target.id === 'overviewClear') { overviewHistory = []; updateOverviewChartUX(); } }); }
function syncOverviewCharts(charts) { charts.forEach(chart => { if (chart.__synced) return; chart.__synced = true; chart.canvas.addEventListener('mousemove', event => { const rect = chart.canvas.getBoundingClientRect(), x = event.clientX - rect.left, area = chart.chartArea, ratio = Math.max(0, Math.min(1, (x - area.left) / (area.right - area.left))), index = Math.round(ratio * (chart.data.labels.length - 1)); charts.forEach(target => { const elements = target.data.datasets.map((_, datasetIndex) => ({ datasetIndex, index })); target.setActiveElements(elements); target.tooltip.setActiveElements(elements, { x: target.chartArea.left + ratio * (target.chartArea.right - target.chartArea.left), y: target.chartArea.top + 10 }); target.update('none'); }); }); chart.canvas.addEventListener('mouseleave', () => charts.forEach(target => { target.setActiveElements([]); target.tooltip.setActiveElements([], { x: 0, y: 0 }); target.update('none'); })); }); }
