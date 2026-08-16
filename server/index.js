import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig, validateConfig, ROOT_DIR } from './lib/config.js';
import { checkBinaries, BIN } from './lib/ffmpeg.js';
import { Store } from './lib/state.js';
import { serveFile } from './lib/range.js';
import { createApi } from './routes/api.js';

const cfg = loadConfig(process.argv.slice(2));

const binError = checkBinaries();
if (binError) {
  console.error(`\n  ${binError}\n`);
  process.exit(1);
}

const problems = validateConfig(cfg);
if (problems.length) {
  console.error(`\n  ${problems.join('\n  ')}\n`);
  process.exit(1);
}

fs.mkdirSync(cfg.cacheDir, { recursive: true });
const store = new Store(path.join(cfg.cacheDir, 'state.json'));
const api = createApi(cfg, store);

const WEB_DIR = path.join(ROOT_DIR, 'web');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await api.handle(req, res, url);

    // Static frontend. Resolve inside web/ only — never serve arbitrary disk paths.
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(WEB_DIR, rel);
    if (!file.startsWith(WEB_DIR)) return res.writeHead(403).end('forbidden');
    return await serveFile(req, res, file);
  } catch (err) {
    // Errors that describe a bad request carry their own status; anything
    // else really is a server fault and is logged as one.
    const status = Number(err.status) || 500;
    if (status >= 500) console.error(`[${req.method} ${url.pathname}]`, err);
    if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err.message || err) }));
  }
});

server.listen(cfg.port, '127.0.0.1', async () => {
  console.log(`\n  midnight-player`);
  console.log(`  ffmpeg   ${path.basename(BIN.ffmpeg)}  (bundled)`);
  console.log(`  library  ${cfg.roots.join('\n           ')}`);
  if (cfg.subtitleRoots.length) console.log(`  subs     ${cfg.subtitleRoots.join('\n           ')}`);
  console.log(`  cache    ${cfg.cacheDir}`);
  console.log(`\n  http://localhost:${cfg.port}\n`);
  await api.ensureScan();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${cfg.port} is already in use. Change "port" in config.json.\n`);
    process.exit(1);
  }
  throw err;
});
