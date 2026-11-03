const params = new URLSearchParams(location.search);
const serial = params.get('serial'), pid = params.get('pid');
const $ = id => document.getElementById(id);
const pct = value => `${Number(value || 0).toFixed(1)}%`;
const processRam = value => value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} GB` : value >= 1024 ? `${(value / 1024).toFixed(1)} MB` : `${value || 0} KB`;
function set(id, value) { $(id).textContent = value || 'Unavailable'; }
async function refresh() {
  if (!serial || !pid) { $('pageError').hidden = false; $('pageError').textContent = 'A device serial and process ID are required.'; return; }
  try {
    const response = await fetch(`/api/process?serial=${encodeURIComponent(serial)}&pid=${encodeURIComponent(pid)}`); if (!response.ok) throw new Error(await response.text());
    const data = await response.json(), p = data.process, status = data.status, memory = data.memory, d = data.diagnostics || {};
    set('pageName', p.name); set('pageSubtitle', `PID ${data.pid} · ${data.serial}`); set('pageCpu', pct(p.cpu)); set('pageRam', processRam(p.rss)); set('pageMemPct', pct(p.memory)); set('pageThreads', status.threads); set('pagePid', data.pid); set('pageUser', `${p.user} · ${status.uid}`); set('pageState', status.state); set('pagePackage', data.packageName); set('pageCommand', data.commandLine); set('pagePss', memory.pss ? `${memory.pss} KB` : 'Unavailable'); set('pagePrivate', memory.privateDirty ? `${memory.privateDirty} KB` : 'Unavailable'); set('pageSwap', memory.swapPss ? `${memory.swapPss} KB` : 'Unavailable'); set('pageVmSize', status.vmSize);
    $('pagePermissions').innerHTML = data.permissions?.length ? data.permissions.map(permission => `<li>${permission}</li>`).join('') : '<li>Unavailable or not an Android package process</li>';
    set('pageFds', d.fileDescriptors || 'Unavailable'); set('pageMeminfo', d.meminfo); set('pageStatusRaw', `${d.status || ''}${d.limits || 'Limits unavailable'}`); set('pageIo', d.io); set('pageSched', d.sched); set('pageMaps', d.maps); set('pageActivity', d.activityInfo); set('pagePackageInfo', d.packageInfo);
    $('pageError').hidden = true; $('pageContent').style.display = '';
  } catch (error) { $('pageContent').style.display = 'none'; $('pageError').hidden = false; $('pageError').textContent = `Unable to read this process: ${error.message}`; }
}
refresh(); setInterval(refresh, 2000);
