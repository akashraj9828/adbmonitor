import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(root, 'public');
const port = Number(process.env.PORT || 3000);
const intervalMs = Math.max(1000, Number(process.env.POLL_INTERVAL || 2000));

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function adb(args, timeout = 5000) {
  return new Promise((resolve, reject) => {
    execFile('adb', args, { timeout, maxBuffer: 1024 * 1024 * 4 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
  });
}

async function devices() {
  const output = await adb(['devices']);
  const serials = output.split('\n').slice(1).map(line => line.trim().split(/\s+/)).filter(parts => parts[0] && parts[1] === 'device').map(([serial]) => serial);
  return Promise.all(serials.map(async serial => {
    const props = await adb(['-s', serial, 'shell', 'getprop']).catch(() => '');
    const values = Object.fromEntries(props.split('\n').map(line => { const match = line.match(/^\[([^\]]+)\]: \[([^\]]*)\]/); return match ? [match[1], match[2]] : null; }).filter(Boolean));
    return { serial, manufacturer: values['ro.product.manufacturer'] || 'Unknown manufacturer', model: values['ro.product.model'] || values['ro.product.name'] || 'Unknown model', android: values['ro.build.version.release'] || 'Unknown Android', product: values['ro.product.device'] || '' };
  }));
}

function number(value) { return Number(String(value).replace(/[^0-9.-]/g, '')) || 0; }

function parseMeminfo(text) {
  const values = Object.fromEntries(text.split('\n').map(line => { const m = line.match(/^(\w+):\s+(\d+)/); return m ? [m[1], Number(m[2]) * 1024] : null; }).filter(Boolean));
  const total = values.MemTotal || 0;
  const available = values.MemAvailable || Math.max(0, total - (values.MemFree || 0) - (values.Buffers || 0) - (values.Cached || 0));
  return { total, available, used: Math.max(0, total - available) };
}

function parseProcesses(text, limit = 100) {
  const lines = text.trim().split('\n').filter(Boolean);
  const header = lines.findIndex(line => /PID/i.test(line) && /NAME|CMD|COMMAND/i.test(line));
  const data = (header >= 0 ? lines.slice(header + 1) : lines).map(line => line.trim().split(/\s+/)).filter(parts => /^\d+$/.test(parts[0]));
  return data.map(parts => {
    const [pid, user, nameOrCpu, cpuOrMem, memOrRss, rssOrName, ...rest] = parts;
    const hasExtended = parts.length >= 6 && !Number.isNaN(Number(cpuOrMem));
    if (hasExtended) return { pid: number(pid), user, name: nameOrCpu, cpu: number(cpuOrMem), memory: number(memOrRss), rss: number(rssOrName) };
    return { pid: number(pid), user: user || '-', name: parts.slice(4).join(' ') || nameOrCpu, cpu: number(cpuOrMem), memory: number(memOrRss), rss: 0 };
  }).filter(p => p.pid).sort((a, b) => b.cpu - a.cpu).slice(0, limit);
}

function parseCpuInfo(text) {
  return text.split('\n').map(line => {
    const match = line.match(/^\s*([\d.]+)%\s+(\S+)\s*(?:\((\d+)\))?/);
    return match ? { cpu: Number(match[1]), name: match[2], pid: Number(match[3] || 0), user: 'android' } : null;
  }).filter(Boolean).slice(0, 30);
}

function diffCpu(previous, current) {
  if (!previous) return 0;
  const idle = current.idle - previous.idle;
  const total = current.total - previous.total;
  return total > 0 ? Math.round((1 - idle / total) * 1000) / 10 : 0;
}

function parseStatus(text) {
  const values = Object.fromEntries(text.split('\n').map(line => {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    return match ? [match[1], match[2].trim()] : null;
  }).filter(Boolean));
  return { state: values.State || 'Unavailable', uid: values.Uid || 'Unavailable', threads: Number(values.Threads) || 0, vmSize: values.VmSize || 'Unavailable', vmRss: values.VmRSS || 'Unavailable', vmPeak: values.VmPeak || 'Unavailable' };
}

function parseMeminfoDetail(text) {
  const readKb = label => {
    const match = text.match(new RegExp(`^${label}\\s*:\\s*([\\d,]+)\\s*kB`, 'mi'));
    return match ? Number(match[1].replace(/,/g, '')) : 0;
  };
  const total = text.match(/^TOTAL\s+(\d+)\s+(\d+)\s+(\d+)/mi);
  return { pss: total ? Number(total[1]) : 0, privateDirty: readKb('Private Dirty'), swapPss: readKb('Swap Pss'), heapSize: readKb('Heap Size'), heapAlloc: readKb('Heap Alloc'), heapFree: readKb('Heap Free') };
}

const coreCounts = new Map();
const procfsSnapshots = new Map();
const procfsTotalSnapshots = new Map();
const cpuSnapshots = new Map();

function parseCpuStats(text) {
  return text.split('\n').map(line => line.trim().split(/\s+/)).filter(parts => /^cpu\d*$/.test(parts[0])).map(parts => {
    const values = parts.slice(1).map(Number);
    return { name: parts[0], idle: (values[3] || 0) + (values[4] || 0), total: values.reduce((sum, value) => sum + value, 0) };
  });
}

function cpuPercentage(previous, current) {
  if (!previous || !current) return 0;
  const total = current.total - previous.total;
  const idle = current.idle - previous.idle;
  return total > 0 ? Math.round((1 - idle / total) * 1000) / 10 : 0;
}
async function collect(serial) {
  const shell = command => adb(['-s', serial, 'shell', command]);
  const [meminfo, procfs] = await Promise.all([shell('cat /proc/meminfo'), collectProcfs(serial)]);
  const memory = parseMeminfo(meminfo);
  const processes = procfs.processes.map(process => ({ ...process, memory: memory.total ? Math.round((process.rss * 1024 / memory.total) * 1000) / 10 : 0 }));
  return { serial, timestamp: new Date().toISOString(), cpu: { usage: procfs.usage, cores: coreCounts.get(serial) || 1, perCore: procfs.perCore }, memory, processes: processes.sort((a, b) => b.cpu - a.cpu) };
}

function parseProcfsSnapshot(text) {
  return text.trim().split('\n').filter(Boolean).map(line => {
    const separator = line.indexOf('|');
    if (separator < 1) return null;
    const pid = Number(line.slice(0, separator)), raw = line.slice(separator + 1), open = raw.indexOf('('), close = raw.lastIndexOf(') ');
    if (!pid || open < 0 || close < 0) return null;
    const name = raw.slice(open + 1, close), fields = raw.slice(close + 2).trim().split(/\s+/);
    return { pid, name, state: fields[0], ticks: Number(fields[11] || 0) + Number(fields[12] || 0), rss: Number(fields[21] || 0) * 4 };
  }).filter(Boolean);
}

function parseProcfsStatus(text) {
  const result = new Map();
  text.trim().split('\n').filter(Boolean).forEach(line => {
    const [pid, name, uid, rss] = line.split('|');
    if (pid) result.set(Number(pid), { name, uid, rss: Number(rss || 0) });
  });
  return result;
}

function parseProcfsCmdlines(text) {
  const result = new Map();
  text.trim().split('\n').filter(Boolean).forEach(line => {
    const separator = line.indexOf('|');
    if (separator < 1) return;
    const pid = Number(line.slice(0, separator));
    const command = line.slice(separator + 1).trim().split(/\s+/)[0];
    if (pid && command) result.set(pid, command);
  });
  return result;
}

function displayUser(uid) {
  if (uid === '0') return 'root';
  if (uid === '1000') return 'system';
  return uid ? `uid:${uid}` : 'unknown';
}

async function collectProcfs(serial) {
  const shell = command => adb(['-s', serial, 'shell', command], 10000);
  const [stat, output, statusOutput, cmdlineOutput] = await Promise.all([
    shell('cat /proc/stat'),
    shell("for d in /proc/[0-9]*; do pid=${d#/proc/}; if read -r line < \"$d/stat\"; then echo \"$pid|$line\"; fi; done"),
    shell("awk 'FNR==1 { if (pid != \"\") print pid \"|\" name \"|\" uid \"|\" rss; pid=FILENAME; sub(/^\\/proc\\//,\"\",pid); sub(/\\/status$/,\"\",pid); name=\"\"; uid=\"\"; rss=0 } /^Name:/ {name=$2} /^Uid:/ {uid=$2} /^VmRSS:/ {rss=$2} END {if (pid != \"\") print pid \"|\" name \"|\" uid \"|\" rss}' /proc/[0-9]*/status 2>/dev/null || true"),
    shell("for d in /proc/[0-9]*; do pid=${d#/proc/}; command=; read command < \"$d/cmdline\"; if [ -n \"$command\" ]; then echo \"$pid|$command\"; fi; done")
  ]);
  const current = parseProcfsSnapshot(output);
  const statusByPid = parseProcfsStatus(statusOutput);
  const cmdlineByPid = parseProcfsCmdlines(cmdlineOutput);
  const cpuStats = parseCpuStats(stat);
  const currentCpu = cpuStats.find(cpu => cpu.name === 'cpu');
  const previousCpu = cpuSnapshots.get(serial);
  const previousCores = previousCpu?.cores || [];
  cpuSnapshots.set(serial, { total: currentCpu, cores: cpuStats.filter(cpu => cpu.name !== 'cpu') });
  const previous = procfsSnapshots.get(serial);
  const currentTotal = currentCpu?.total || 0;
  const previousTotal = procfsTotalSnapshots.get(serial);
  procfsSnapshots.set(serial, current);
  procfsTotalSnapshots.set(serial, currentTotal);
  const previousByPid = new Map((previous || []).map(process => [process.pid, process]));
  const totalDelta = previousTotal === undefined ? 0 : currentTotal - previousTotal;
  const cores = coreCounts.get(serial) || 1;
  current.forEach(process => {
    const previousProcess = previousByPid.get(process.pid);
    const processDelta = previousProcess ? process.ticks - previousProcess.ticks : 0;
    process.cpu = totalDelta > 0 ? Math.round((processDelta / totalDelta) * cores * 1000) / 10 : 0;
    const status = statusByPid.get(process.pid);
    process.user = displayUser(status?.uid);
    process.uid = status?.uid || '';
    process.rss = status?.rss || process.rss;
    process.name = cmdlineByPid.get(process.pid) || process.name;
  });
  const usage = cpuPercentage(previousCpu?.total, currentCpu);
  const perCore = cpuStats.filter(cpu => cpu.name !== 'cpu').map((cpu, index) => ({ name: cpu.name, usage: cpuPercentage(previousCores[index], cpu) }));
  if (!coreCounts.has(serial)) coreCounts.set(serial, Number((await shell('nproc').catch(() => '1')).trim()) || 1);
  return { processes: current, totalDelta, usage, perCore };
}

async function compareCollectors(serial) {
  const [procfsData, psOutput] = await Promise.all([collectProcfs(serial), adb(['-s', serial, 'shell', 'ps -A -o PID,USER,NAME,%CPU,%MEM,RSS']).catch(() => '')]);
  const allPsProcesses = parseProcesses(psOutput, Number.MAX_SAFE_INTEGER);
  const procfsByPid = new Map(procfsData.processes.map(process => [process.pid, process]));
  const psByPid = new Map(allPsProcesses.map(process => [process.pid, process]));
  const matched = [...psByPid.keys()].filter(pid => procfsByPid.has(pid)).map(pid => {
    const psProcess = psByPid.get(pid), procProcess = procfsByPid.get(pid);
    return { pid, name: psProcess.name, psCpu: psProcess.cpu, procfsCpu: procProcess.cpu, cpuDiff: Math.round((procProcess.cpu - psProcess.cpu) * 10) / 10, psRssKb: psProcess.rss, procfsRssKb: procProcess.rss, rssDiffKb: procProcess.rss - psProcess.rss };
  });
  return { serial, timestamp: new Date().toISOString(), ps: { count: allPsProcesses.length, dashboardRows: 100 }, procfs: { count: procfsData.processes.length }, matchedCount: matched.length, onlyInPs: [...psByPid.keys()].filter(pid => !procfsByPid.has(pid)), onlyInProcfs: [...procfsByPid.keys()].filter(pid => !psByPid.has(pid)), matched };
}

async function collectProcess(serial, pid) {
  if (!/^\d+$/.test(pid)) throw new Error('Invalid process id');
  const shell = command => adb(['-s', serial, 'shell', command]);
  const [status, commandLine, meminfo, ps, threadCount, limits, io, sched, fileDescriptors, maps] = await Promise.all([
    shell(`cat /proc/${pid}/status`),
    shell(`tr '\\0' ' ' < /proc/${pid}/cmdline`).catch(() => ''),
    shell(`dumpsys meminfo ${pid}`).catch(() => ''),
    shell(`ps -p ${pid} -o PID,USER,NAME,%CPU,%MEM,RSS,STAT,ARGS`).catch(() => ''),
    shell(`ls -1 /proc/${pid}/task | wc -l`).catch(() => '0'),
    shell(`cat /proc/${pid}/limits`).catch(() => ''),
    shell(`cat /proc/${pid}/io`).catch(() => ''),
    shell(`cat /proc/${pid}/sched`).catch(() => ''),
    shell(`for f in /proc/${pid}/fd/*; do echo "$f -> $(readlink "$f")"; done`).catch(() => ''),
    shell(`cat /proc/${pid}/maps | head -n 250`).catch(() => '')
  ]);
  const process = parseProcesses(ps)[0] || { pid: Number(pid), user: 'Unavailable', name: `PID ${pid}`, cpu: 0, memory: 0, rss: 0 };
  const details = parseStatus(status);
  details.threads = Number(threadCount.trim()) || details.threads;
  const packageName = process.name.match(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+/)?.[0] || '';
  const packageInfo = packageName ? await shell(`dumpsys package ${packageName} | head -n 220`).catch(() => '') : '';
  const activityInfo = await shell(`dumpsys activity processes | grep -A 35 -B 5 "${pid}" | head -n 100`).catch(() => '');
  const permissionInfo = packageName ? await shell(`dumpsys package ${packageName} | grep -A 160 -E "requested permissions:|install permissions:|runtime permissions:" | head -n 220`).catch(() => '') : '';
  const permissions = [...new Set(`${packageInfo}\n${permissionInfo}`.match(/\b(?:android|com\.[A-Za-z0-9_.]+)\.permission\.[A-Z0-9_]+\b/g) || [])].sort();
  return { pid: Number(pid), serial, timestamp: new Date().toISOString(), process, packageName, permissions, commandLine: commandLine.trim() || process.name, status: details, memory: parseMeminfoDetail(meminfo), diagnostics: { status, meminfo, limits, io, sched, fileDescriptors, maps, activityInfo, packageInfo: `${packageInfo}\n${permissionInfo}` } };
}

function send(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }

const processActions = new Set(['logs', 'stack', 'settings', 'kill', 'force-stop', 'restart']);
function validPackage(value) { return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(value); }
async function runProcessAction(serial, pid, action, packageName = '') {
  if (!serial || !/^\d+$/.test(String(pid))) throw new Error('A valid device serial and process ID are required');
  if (!processActions.has(action)) throw new Error('Unsupported process action');
  const target = String(pid);
  if (action === 'logs') return { action, output: await adb(['-s', serial, 'shell', `logcat -d --pid=${target} -t 200 -v threadtime`]) };
  if (action === 'stack') return { action, output: await adb(['-s', serial, 'shell', `debuggerd -b ${target}`]) };
  if (!validPackage(packageName)) throw new Error('This process does not expose a valid Android package name');
  if (action === 'settings') return { action, output: await adb(['-s', serial, 'shell', 'am', 'start', '-a', 'android.settings.APPLICATION_DETAILS_SETTINGS', '-d', `package:${packageName}`]) };
  if (action === 'kill') return { action, output: await adb(['-s', serial, 'shell', 'kill', '-TERM', target]) };
  if (action === 'force-stop') return { action, output: await adb(['-s', serial, 'shell', 'am', 'force-stop', packageName]) };
  await adb(['-s', serial, 'shell', 'am', 'force-stop', packageName]);
  return { action, output: await adb(['-s', serial, 'shell', 'monkey', '-p', packageName, '1']) };
}
async function locatePackageProcess(serial, packageName) {
  if (!validPackage(packageName)) throw new Error('A valid Android package name is required');
  const snapshot = await collect(serial);
  const match = snapshot.processes.find(process => process.name === packageName || process.name.startsWith(`${packageName}:`));
  return { serial, packageName, process: match || null };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/api/devices') {
      const list = await devices();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ devices: list }));
    }
    if (url.pathname === '/api/stream') {
      const serial = url.searchParams.get('serial');
      if (!serial) { res.writeHead(400); return res.end('serial is required'); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
      let active = true;
      const push = async () => { if (!active) return; try { send(res, 'metrics', await collect(serial)); } catch (error) { send(res, 'error', { message: error.message }); } };
      await push();
      const timer = setInterval(push, intervalMs);
      req.on('close', () => { active = false; clearInterval(timer); });
      return;
    }
    if (url.pathname === '/api/process') {
      const serial = url.searchParams.get('serial');
      const pid = url.searchParams.get('pid');
      if (!serial || !pid) { res.writeHead(400); return res.end('serial and pid are required'); }
      const detail = await collectProcess(serial, pid);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(detail));
    }
    if (url.pathname === '/api/process-action' && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const result = await runProcessAction(body.serial, body.pid, body.action, body.packageName);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(result));
    }
    if (url.pathname === '/api/process-locate') {
      const serial = url.searchParams.get('serial');
      const packageName = url.searchParams.get('packageName');
      const result = await locatePackageProcess(serial, packageName);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(result));
    }
    if (url.pathname === '/api/compare') {
      const serial = url.searchParams.get('serial');
      if (!serial) { res.writeHead(400); return res.end('serial is required'); }
      const comparison = await compareCollectors(serial);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(comparison));
    }
    const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (requested.includes('..')) { res.writeHead(400); return res.end('Bad request'); }
    const body = await readFile(join(publicDir, requested));
    res.writeHead(200, { 'Content-Type': mime[extname(requested)] || 'application/octet-stream' });
    return res.end(body);
  } catch (error) {
    res.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(port, () => console.log(`ADB monitor running at http://localhost:${port}`));
