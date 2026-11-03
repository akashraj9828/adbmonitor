import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(root, 'public');
const port = Number(process.env.PORT || 3000);
const intervalMs = Math.max(1000, Number(process.env.POLL_INTERVAL || 2000));

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

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
  return output.split('\n').slice(1).map(line => line.trim().split(/\s+/)).filter(parts => parts[0] && parts[1] === 'device').map(([serial]) => serial);
}

function number(value) { return Number(String(value).replace(/[^0-9.-]/g, '')) || 0; }

function parseMeminfo(text) {
  const values = Object.fromEntries(text.split('\n').map(line => { const m = line.match(/^(\w+):\s+(\d+)/); return m ? [m[1], Number(m[2]) * 1024] : null; }).filter(Boolean));
  const total = values.MemTotal || 0;
  const available = values.MemAvailable || Math.max(0, total - (values.MemFree || 0) - (values.Buffers || 0) - (values.Cached || 0));
  return { total, available, used: Math.max(0, total - available) };
}

function parseProcesses(text) {
  const lines = text.trim().split('\n').filter(Boolean);
  const header = lines.findIndex(line => /PID/i.test(line) && /NAME|CMD|COMMAND/i.test(line));
  const data = (header >= 0 ? lines.slice(header + 1) : lines).map(line => line.trim().split(/\s+/)).filter(parts => /^\d+$/.test(parts[0]));
  return data.map(parts => {
    const [pid, user, nameOrCpu, cpuOrMem, memOrRss, rssOrName, ...rest] = parts;
    const hasExtended = parts.length >= 6 && !Number.isNaN(Number(cpuOrMem));
    if (hasExtended) return { pid: number(pid), user, name: nameOrCpu, cpu: number(cpuOrMem), memory: number(memOrRss), rss: number(rssOrName) };
    return { pid: number(pid), user: user || '-', name: parts.slice(4).join(' ') || nameOrCpu, cpu: number(cpuOrMem), memory: number(memOrRss), rss: 0 };
  }).filter(p => p.pid).sort((a, b) => b.cpu - a.cpu).slice(0, 100);
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

const snapshots = new Map();
async function collect(serial) {
  const shell = command => adb(['-s', serial, 'shell', command]);
  const [stat, meminfo, cpuInfo, ps] = await Promise.all([
    shell('cat /proc/stat | head -n 1'),
    shell('cat /proc/meminfo'),
    shell('dumpsys cpuinfo'),
    shell('ps -A -o PID,USER,NAME,%CPU,%MEM,RSS').catch(() => shell('ps -A'))
  ]);
  const cpuParts = stat.trim().split(/\s+/).slice(1).map(Number);
  const currentCpu = { idle: (cpuParts[3] || 0) + (cpuParts[4] || 0), total: cpuParts.reduce((sum, value) => sum + value, 0) };
  const previous = snapshots.get(serial);
  snapshots.set(serial, currentCpu);
  return { serial, timestamp: new Date().toISOString(), cpu: { usage: diffCpu(previous, currentCpu), cores: Number((await shell('nproc').catch(() => '1')).trim()) || 1 }, memory: parseMeminfo(meminfo), processes: parseProcesses(ps), cpuProcesses: parseCpuInfo(cpuInfo) };
}

function send(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }

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
