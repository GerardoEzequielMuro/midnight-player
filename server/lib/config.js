import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

const DEFAULTS = {
  roots: [],
  subtitleRoots: [],
  port: 8730,
  cacheDir: './cache',
  seriesAliases: [],
  preferredAudioLang: 'jpn',
  // Which language the subtitle selector should offer, and whether to offer
  // only that one. A finished library has one correct track per episode; the
  // English source and the intermediate retimes are working material, not
  // choices worth presenting. Set singleSubtitle to false to see them all.
  subtitleLang: 'spa',
  singleSubtitle: true,
  assumeHevcSupport: false,
};

function readJson(file) {
  try {
    // Strip "//"-prefixed comment keys so config.example.json stays self-documenting.
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith('//')));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`${file} is not valid JSON: ${err.message}`);
  }
}

export function loadConfig(argv = []) {
  const file = path.join(ROOT_DIR, 'config.json');
  const cfg = { ...DEFAULTS, ...(readJson(file) || {}) };

  // Positional CLI args win over the config file, so a fresh clone can run
  // without writing any config at all: npm start -- "D:\Series"
  /*
   * Walk the arguments rather than filtering them.
   *
   * Filtering on "does not start with a dash" looks right and is wrong: in
   * `--port 8731 "D:\Series"` the port *value* has no dash either, so it was
   * being taken as a library folder and the server refused to start, naming a
   * directory the user never typed. A flag's value belongs to the flag.
   */
  const roots = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') {
      const value = Number(argv[i + 1]);
      if (value) cfg.port = value;
      i++; // consume the value
      continue;
    }
    if (arg.startsWith('--port=')) {
      const value = Number(arg.split('=')[1]);
      if (value) cfg.port = value;
      continue;
    }
    if (arg.startsWith('-')) continue;
    roots.push(arg);
  }
  if (roots.length) cfg.roots = roots;

  cfg.roots = cfg.roots.map((p) => path.resolve(p));
  cfg.subtitleRoots = cfg.subtitleRoots.map((p) => path.resolve(p));
  cfg.cacheDir = path.resolve(ROOT_DIR, cfg.cacheDir);
  cfg.configFile = file;
  cfg.hasConfigFile = fs.existsSync(file);

  // Alias lookup: any spelling of a series maps to one canonical key.
  cfg.aliasMap = new Map();
  for (const group of cfg.seriesAliases) {
    const canonical = normalizeTitle(group[0]);
    for (const name of group) cfg.aliasMap.set(normalizeTitle(name), canonical);
  }

  return cfg;
}

export function normalizeTitle(s) {
  return String(s)
    .toLowerCase()
    .replace(/[._]+/g, ' ')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function validateConfig(cfg) {
  const problems = [];
  if (!cfg.roots.length) {
    problems.push(
      cfg.hasConfigFile
        ? `No "roots" in ${cfg.configFile}. Add at least one folder.`
        : `No library folder configured.\n  Either: copy config.example.json to config.json and edit "roots"\n  Or run: npm start -- "D:\\path\\to\\series"`
    );
  }
  for (const r of [...cfg.roots, ...cfg.subtitleRoots]) {
    if (!fs.existsSync(r)) problems.push(`Folder does not exist: ${r}`);
  }
  return problems;
}
