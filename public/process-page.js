const params = new URLSearchParams(location.search);
const serial = params.get('serial'), initialPid = params.get('pid');
let currentPid = initialPid;
let reattaching = false;
const $ = id => document.getElementById(id);
const pct = value => `${Number(value || 0).toFixed(1)}%`;
const processRam = value => value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} GB` : value >= 1024 ? `${(value / 1024).toFixed(1)} MB` : `${value || 0} KB`;
const history = [];
let pageRange = 60, pagePaused = false;
let latestDetail;
document.querySelector('#pageContent .detail-sections')?.insertAdjacentHTML('beforebegin', '<div class="history-card process-history"><div id="pageHistoryControls" class="chart-toolbar"><span>History</span><button data-range="30">1m</button><button data-range="60" class="active">2m</button><button data-range="450">15m</button><button id="pagePause">Pause</button><button id="pageClear">Clear</button></div><div class="history-head"><h3>Usage history</h3></div><div class="process-history-grid"><div><span class="chart-label"><i class="legend-cpu"></i> CPU %</span><canvas id="pageCpuChart" height="140"></canvas></div><div><span class="chart-label"><i class="legend-ram"></i> RAM %</span><canvas id="pageMemoryChart" height="140"></canvas></div><div><span class="chart-label"><i class="legend-threads"></i> Threads</span><canvas id="pageThreadsChart" height="140"></canvas></div></div><div id="pageProcessTooltip" class="process-tooltip" hidden></div></div>');
function set(id, value) { $(id).textContent = value || 'Unavailable'; }
async function refresh() {
  if (!serial || !currentPid) { $('pageError').hidden = false; $('pageError').textContent = 'A device serial and process ID are required.'; return; }
  try {
    const response = await fetch(`/api/process?serial=${encodeURIComponent(serial)}&pid=${encodeURIComponent(currentPid)}`); if (!response.ok) throw new Error(await response.text());
    const data = await response.json(), p = data.process, status = data.status, memory = data.memory, d = data.diagnostics || {};
    latestDetail = data;
    set('pageName', p.name); set('pageSubtitle', `PID ${data.pid} · ${data.serial}`); set('pageCpu', pct(p.cpu)); set('pageRam', processRam(p.rss)); set('pageMemPct', pct(p.memory)); set('pageThreads', status.threads); set('pagePid', data.pid); set('pageUser', `${p.user} · ${status.uid}`); set('pageState', status.state); set('pagePackage', data.packageName); set('pageCommand', data.commandLine); set('pagePss', memory.pss ? `${memory.pss} KB` : 'Unavailable'); set('pagePrivate', memory.privateDirty ? `${memory.privateDirty} KB` : 'Unavailable'); set('pageSwap', memory.swapPss ? `${memory.swapPss} KB` : 'Unavailable'); set('pageVmSize', status.vmSize);
    if (!pagePaused) { history.push({ time: new Date(data.timestamp), cpu: Number(p.cpu) || 0, memory: Number(p.memory) || 0, threads: Number(status.threads) || 0 }); if (history.length > 450) history.shift(); } drawHistory(history); setupPageHistoryControls();
    $('pagePermissions').innerHTML = data.permissions?.length ? data.permissions.map(permission => `<li>${permission}</li>`).join('') : '<li>Unavailable or not an Android package process</li>';
    set('pageFds', d.fileDescriptors || 'Unavailable'); set('pageMeminfo', d.meminfo); set('pageStatusRaw', `${d.status || ''}${d.limits || 'Limits unavailable'}`); set('pageIo', d.io); set('pageSched', d.sched); set('pageMaps', d.maps); set('pageActivity', d.activityInfo); set('pagePackageInfo', d.packageInfo);
    $('pageError').className = 'detail-error'; $('pageError').hidden = true; $('pageContent').style.display = '';
  } catch (error) {
    const processMissing = /No such file|not found|does not exist/i.test(error.message);
    if (processMissing && latestDetail?.packageName) {
      $('pageContent').style.display = '';
      $('pageError').className = 'detail-info'; $('pageError').hidden = false;
      $('pageError').textContent = `Process ${currentPid} exited. Waiting for ${latestDetail.packageName} to return with a new PID…`;
      if (!reattaching) {
        reattaching = true;
        await reattachToPackage(latestDetail.packageName);
        reattaching = false;
      }
      return;
    }
    $('pageContent').style.display = 'none'; $('pageError').className = 'detail-error'; $('pageError').hidden = false; $('pageError').textContent = `Unable to read this process: ${error.message}`;
  }
}
function drawHistory(samples) { const visible = samples.slice(-pageRange), maxThreads = Math.max(1, ...visible.map(sample => sample.threads || 0)); [["Cpu", "cpu", "#9ce15b", 100], ["Memory", "memory", "#b399ff", 100], ["Threads", "threads", "#78c7ff", maxThreads]].forEach(([suffix, key, color, max]) => { const canvas = document.getElementById("page" + suffix + "Chart"), rect = canvas.getBoundingClientRect(), ratio = window.devicePixelRatio || 1, width = Math.max(240, rect.width), height = 140, left = 38, bottom = 18, plotHeight = height - bottom, plotWidth = width - left; canvas.width = width * ratio; canvas.height = height * ratio; const context = canvas.getContext("2d"); context.scale(ratio, ratio); context.clearRect(0, 0, width, height); context.font = "10px ui-monospace, monospace"; context.textAlign = "left"; [0, .5, 1].forEach(step => { const y = plotHeight - step * plotHeight; context.strokeStyle = "#292e38"; context.lineWidth = 1; context.beginPath(); context.moveTo(left, y); context.lineTo(width, y); context.stroke(); context.fillStyle = "#89919e"; context.fillText(max === 100 ? Math.round(step * 100) + "%" : String(Math.round(max * step)), 0, Math.max(10, Math.min(plotHeight - 2, y + 3))); }); context.strokeStyle = color; context.lineWidth = 2; context.beginPath(); visible.forEach((sample, index) => { const x = left + (visible.length === 1 ? plotWidth / 2 : index / (visible.length - 1) * plotWidth), y = plotHeight - Math.min(max, sample[key]) / max * plotHeight; index ? context.lineTo(x, y) : context.moveTo(x, y); }); context.stroke(); if (visible.length) { const indices = [...new Set([0, Math.floor((visible.length - 1) / 2), visible.length - 1])]; context.fillStyle = "#89919e"; indices.forEach(index => { const x = left + (visible.length === 1 ? plotWidth / 2 : index / (visible.length - 1) * plotWidth); context.textAlign = index === 0 ? "left" : index === visible.length - 1 ? "right" : "center"; context.fillText(visible[index].time?.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }) || "", x, height - 2); }); } }); attachPageHover(visible); }
function setupPageHistoryControls() { const controls = $('pageHistoryControls'); if (!controls || controls.dataset.ready) return; controls.dataset.ready = '1'; controls.addEventListener('click', event => { if (event.target.dataset.range) { pageRange = Number(event.target.dataset.range); controls.querySelectorAll('[data-range]').forEach(button => button.classList.toggle('active', button.dataset.range === event.target.dataset.range)); drawHistory(history); } if (event.target.id === 'pagePause') { pagePaused = !pagePaused; event.target.textContent = pagePaused ? 'Resume' : 'Pause'; } if (event.target.id === 'pageClear') { history.length = 0; drawHistory(history); } }); }
function attachPageHover(samples) { ['Cpu', 'Memory', 'Threads'].forEach(suffix => { const canvas = $(`page${suffix}Chart`); if (!canvas || canvas.dataset.hoverReady) return; canvas.dataset.hoverReady = '1'; canvas.addEventListener('mousemove', event => { const rect = canvas.getBoundingClientRect(), ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), index = Math.min(samples.length - 1, Math.round(ratio * Math.max(0, samples.length - 1))), sample = samples[index], tooltip = $('pageProcessTooltip'); if (!sample || !tooltip) return; const box = canvas.closest('.process-history'), boxRect = box.getBoundingClientRect(); tooltip.hidden = false; tooltip.innerHTML = `${sample.time?.toLocaleTimeString() || ''}<br><span class="tooltip-cpu">CPU ${pct(sample.cpu)}</span> · <span class="tooltip-ram">RAM ${pct(sample.memory)}</span> · <span class="tooltip-threads">Threads ${sample.threads}`; tooltip.style.left = `${Math.min(rect.left - boxRect.left + event.clientX - rect.left + 10, box.clientWidth - 180)}px`; tooltip.style.top = `${rect.top - boxRect.top + 8}px`; }); canvas.addEventListener('mouseleave', () => { const tooltip = $('pageProcessTooltip'); if (tooltip) tooltip.hidden = true; }); }); }
refresh(); setInterval(refresh, 2000);

const actionLabels = { refresh: 'Refresh details', logs: 'View process logs', stack: 'Capture stack trace', settings: 'Open app settings', copy: 'Copy diagnostics', kill: 'Kill process', 'force-stop': 'Force-stop package', restart: 'Restart package' };
const dangerousActions = new Set(['kill', 'force-stop', 'restart']);
function showActionResult(message, output = '') {
  const status = $('actionStatus'), result = $('actionOutput');
  status.hidden = false; status.textContent = message;
  result.hidden = !output; result.textContent = output;
}
async function copyDiagnostics() {
  const text = JSON.stringify(latestDetail, null, 2);
  await navigator.clipboard.writeText(text);
  showActionResult('Diagnostics copied to the clipboard.');
}
let confirmationResolver;
function askForConfirmation(action, label) {
  return new Promise(resolve => {
    confirmationResolver = resolve;
    const modal = $('actionConfirm'), title = $('actionConfirmTitle'), message = $('actionConfirmMessage'), proceed = $('actionConfirmProceed');
    const dangerous = dangerousActions.has(action);
    title.textContent = label;
    message.textContent = dangerous ? `This can interrupt or restart ${latestDetail.packageName || `PID ${latestDetail.pid}`} and may cause data loss. Are you sure you want to continue?` : `Run “${label}” for ${latestDetail.packageName || `PID ${latestDetail.pid}`}?`;
    proceed.textContent = dangerous ? 'Yes, continue' : 'Confirm';
    proceed.classList.toggle('danger-confirm', dangerous);
    modal.hidden = false;
    proceed.focus();
  });
}
function finishConfirmation(confirmed) {
  const modal = $('actionConfirm');
  modal.hidden = true;
  if (confirmationResolver) { const resolve = confirmationResolver; confirmationResolver = undefined; resolve(confirmed); }
}
async function reattachToPackage(packageName) {
  showActionResult(`Waiting for ${packageName} to start…`);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 800));
    const response = await fetch(`/api/process-locate?serial=${encodeURIComponent(serial)}&packageName=${encodeURIComponent(packageName)}`);
    if (!response.ok) continue;
    const result = await response.json();
    if (result.process?.pid) {
      currentPid = String(result.process.pid);
      const nextUrl = new URL(location.href); nextUrl.searchParams.set('pid', currentPid); window.history.replaceState(null, '', nextUrl);
      showActionResult(`Re-attached to ${packageName} with new PID ${currentPid}.`);
      await refresh();
      return true;
    }
  }
  showActionResult(`The package did not expose a new process within the timeout. Refresh details to retry.`);
  return false;
}
async function runAction(action) {
  if (!latestDetail) return;
  const label = actionLabels[action] || action;
  if (dangerousActions.has(action) && !await askForConfirmation(action, label)) return;
  document.querySelectorAll('[data-action]').forEach(button => { button.disabled = true; });
  showActionResult(`${label}…`);
  try {
    if (action === 'refresh') { await refresh(); showActionResult('Process details refreshed.'); return; }
    if (action === 'copy') { await copyDiagnostics(); return; }
    const response = await fetch('/api/process-action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serial, pid: currentPid, packageName: latestDetail.packageName, action }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || result.message || 'Action failed');
    showActionResult(`${label} completed.`, result.output || 'ADB returned no output.');
    if (action === 'restart') await reattachToPackage(latestDetail.packageName);
    else if (dangerousActions.has(action)) setTimeout(refresh, 1000);
  } catch (error) { showActionResult(`${label} failed: ${error.message}`); }
  finally { document.querySelectorAll('[data-action]').forEach(button => { button.disabled = false; }); }
}
document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => runAction(button.dataset.action)));
$('actionConfirmCancel').addEventListener('click', () => finishConfirmation(false));
$('actionConfirmProceed').addEventListener('click', () => finishConfirmation(true));
$('actionConfirm').addEventListener('click', event => { if (event.target.id === 'actionConfirm') finishConfirmation(false); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('actionConfirm').hidden) finishConfirmation(false); });
