const $ = id => document.getElementById(id);
let source;
let selectedSerial = '';
let processRows = [];
let sortKey = 'cpu';
let sortDirection = 'desc';
let filterText = '';
let detailTimer;
let detailTarget;
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
  setStatus(`Connected · ${serial}`);
  source = new EventSource(`/api/stream?serial=${encodeURIComponent(serial)}`);
  source.addEventListener('metrics', event => render(JSON.parse(event.data)));
  source.addEventListener('error', () => setStatus(`Connection lost · ${serial}`, 'error'));
}
function render(data) {
  const cpu = data.cpu.usage, mem = data.memory, memPct = mem.total ? mem.used / mem.total * 100 : 0;
  $('cpuValue').textContent = pct(cpu); $('cpuBar').style.width = `${Math.min(100, cpu)}%`; $('cpuMeta').textContent = `${data.cpu.cores} logical cores · system load`;
  $('memValue').textContent = `${bytes(mem.used)} / ${bytes(mem.total)}`; $('memBar').style.width = `${Math.min(100, memPct)}%`; $('memMeta').textContent = `${pct(memPct)} used`;
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
    $('detailPermissions').innerHTML = data.permissions?.length ? data.permissions.map(permission => `<li>${permission}</li>`).join('') : '<li>Unavailable or not an Android package process</li>';
    const diagnostics = data.diagnostics || {};
    $('detailFds').textContent = diagnostics.fileDescriptors || 'Unavailable or permission denied'; $('detailMeminfo').textContent = diagnostics.meminfo || 'Unavailable'; $('detailStatusRaw').textContent = `${diagnostics.status || ''}${diagnostics.limits || 'Limits unavailable'}`; $('detailIo').textContent = diagnostics.io || 'Unavailable or permission denied'; $('detailSched').textContent = diagnostics.sched || 'Unavailable or permission denied'; $('detailMaps').textContent = diagnostics.maps || 'Unavailable or permission denied'; $('detailActivity').textContent = diagnostics.activityInfo || 'Unavailable or no activity-manager record'; $('detailPackageInfo').textContent = diagnostics.packageInfo || 'Unavailable or not an Android package process';
    $('detailLoading').hidden = true; $('detailContent').hidden = false;
  } catch (error) { $('detailLoading').hidden = true; $('detailContent').hidden = true; $('detailError').hidden = false; $('detailError').textContent = `Unable to read this process: ${error.message}`; }
}
function closeProcess() { clearInterval(detailTimer); detailTimer = undefined; detailTarget = undefined; $('processDetail').hidden = true; }
$('deviceSelect').addEventListener('change', event => connect(event.target.value));
$('refreshBtn').addEventListener('click', loadDevices);
$('processFilter').addEventListener('input', event => { filterText = event.target.value.trim().toLowerCase(); renderProcessTable(); });
document.querySelectorAll('th.sortable').forEach(header => header.addEventListener('click', () => { if (sortKey === header.dataset.key) sortDirection = sortDirection === 'asc' ? 'desc' : 'asc'; else { sortKey = header.dataset.key; sortDirection = 'asc'; } renderProcessTable(); }));
$('closeDetail').addEventListener('click', closeProcess);
$('openFullDetail').addEventListener('click', () => { if (detailTarget) window.open(`/process.html?serial=${encodeURIComponent(detailTarget.serial)}&pid=${encodeURIComponent(detailTarget.pid)}`, '_blank', 'noopener'); });
$('processDetail').addEventListener('click', event => { if (event.target.id === 'processDetail') closeProcess(); });
loadDevices();
