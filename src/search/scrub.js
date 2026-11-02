'use strict';

/**
 * scrub.js — redact secrets from transcript text before it leaves the machine.
 *
 * Two layers:
 *   1. Known values: secret-looking tokens harvested locally from
 *      credentials.md, ~/.api_keys, ~/.config/smtp/* and ~/supa. The values
 *      are only held in memory and are never logged.
 *   2. Generic patterns: API key/token formats, private-key blocks, JWTs,
 *      Bearer/Basic auth, password=… style assignments, URL userinfo.
 *
 * Usage:
 *   const { createScrubber } = require('./scrub');
 *   const scrub = createScrubber();          // loads known values once
 *   const clean = scrub(text);
 *   scrub.knownCount                          // number of known values loaded
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const REDACTED = '[REDACTED]';
const HOME = os.homedir();

const SOURCES = [
  path.join(HOME, '.claude', 'context', 'hosts', 'credentials.md'),
  path.join(HOME, '.api_keys'),
  path.join(HOME, 'supa'),
];
const SMTP_DIR = path.join(HOME, '.config', 'smtp');

const MIN_KNOWN_LEN = 8;

const GENERIC_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(sk-(?:ant-)?[A-Za-z0-9_-]{16,})/g,
  /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\b(AKIA[0-9A-Z]{16})\b/g,
  /\b(xox[abposr]-[A-Za-z0-9-]{10,})/g,
  /\b(AIza[0-9A-Za-z_-]{30,})/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

// key = value / key: value where the key names a secret
const ASSIGNMENT = /\b([A-Za-z0-9_]*?(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|apikey|auth|credential|master[_-]?key|private[_-]?key)[A-Za-z0-9_-]*["']?\s*[:=]\s*["']?)([^\s"'`,;|]{4,})/gi;
const AUTH_HEADER = /\b(Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{8,})/g;
const AUTH_SCHEMES = new Set(['Bearer', 'Basic', 'Token']);
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi;
const SUDO_ECHO = /(echo\s+["']?)([^\s"'|]+)(["']?\s*\|\s*sudo\s+-S)/g;

function readIfExists(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function looksLikeNonSecret(tok) {
  if (/^[~/.]/.test(tok)) return true;                         // paths
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(tok)) return true;       // URLs
  if (tok.includes('/')) return true;                          // path fragments
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(tok)) return true; // IPv4
  if (/^\d{4}-\d{2}-\d{2}/.test(tok)) return true;             // dates
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,6}(:\d+)?$/i.test(tok)) return true; // FQDNs
  if (/^[a-z]+(-[a-z]+)*$/i.test(tok)) return true;            // plain words / kebab words
  if (/^[a-z_]+\.(md|js|json|sh|py|yml|yaml|conf|service|timer|env)$/i.test(tok)) return true;
  return false;
}

function looksSecret(tok) {
  if (tok.length < MIN_KNOWN_LEN || tok.length > 200) return false;
  if (looksLikeNonSecret(tok)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(r => r.test(tok)).length;
  const hasLetter = /[A-Za-z]/.test(tok);
  const hasDigit = /\d/.test(tok);
  return classes >= 3 || (hasLetter && hasDigit && tok.length >= 10) || tok.length >= 24;
}

function harvestTokens(text) {
  const out = new Set();
  text = text.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
  // backtick-quoted values, table cells, KEY="value", and bare tokens
  const candidates = [
    ...[...text.matchAll(/`([^`\s]+)`/g)].map(m => m[1]),
    ...[...text.matchAll(/=\s*["']?([^\s"']+)["']?/g)].map(m => m[1]),
    ...text.split(/[\s|`"'(),;<>]+/),
  ];
  for (const raw of candidates) {
    const tok = raw.replace(/^[*_:]+|[*_:.]+$/g, '');
    if (looksSecret(tok)) out.add(tok);
  }
  return out;
}

// Identifiers that look secret-ish (letters + digits) but are names: hosts,
// SSH aliases, first-column table labels, project directories.
function loadAllowlist() {
  const allow = new Set();
  const add = (v) => { if (v) { allow.add(v); allow.add(v.toLowerCase()); allow.add(v.toUpperCase()); } };
  for (const line of readIfExists(path.join(HOME, '.ssh', 'config')).split('\n')) {
    const m = line.match(/^\s*Host\s+(.+)$/i);
    if (m) m[1].split(/\s+/).filter(h => !/[*?]/.test(h)).forEach(add);
  }
  for (const dir of [path.join(HOME, 'projects', 'TonyNET_Lab', 'hosts')]) {
    try { fs.readdirSync(dir).filter(f => f.endsWith('.md')).forEach(f => add(f.replace(/\.md$/, ''))); } catch { /* none */ }
  }
  for (const line of readIfExists(SOURCES[0]).split('\n')) {
    const m = line.match(/^\|\s*([^|`]+?)\s*\|/);
    if (m) m[1].split(/\s*\/\s*/).forEach(add);
  }
  try {
    const root = path.join(HOME, 'projects');
    for (const d of fs.readdirSync(root)) {
      add(d);
      try { fs.readdirSync(path.join(root, d)).forEach(add); } catch { /* not a dir */ }
    }
  } catch { /* no projects */ }
  return allow;
}

function loadKnownSecrets() {
  const known = new Set();
  for (const file of SOURCES) {
    const text = readIfExists(file);
    if (!text) continue;
    if (path.basename(file) === 'supa') {
      const v = text.trim();
      if (v.length >= 6) known.add(v);
      continue;
    }
    for (const t of harvestTokens(text)) known.add(t);
  }
  try {
    for (const f of fs.readdirSync(SMTP_DIR)) {
      const v = readIfExists(path.join(SMTP_DIR, f)).trim();
      if (v.length >= 6 && !/\s/.test(v)) known.add(v);
      for (const t of harvestTokens(v)) known.add(t);
    }
  } catch { /* no smtp dir */ }
  const allow = loadAllowlist();
  for (const v of [...known]) if (allow.has(v)) known.delete(v);
  // longest first so a secret containing another secret is replaced whole
  return [...known].sort((a, b) => b.length - a.length);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildKnownMatcher(values) {
  if (values.length === 0) return null;
  const parts = values.map(escapeRegex);
  // chunk to keep individual regexes a sane size
  const chunks = [];
  for (let i = 0; i < parts.length; i += 200) {
    chunks.push(new RegExp(parts.slice(i, i + 200).join('|'), 'g'));
  }
  return chunks;
}

function createScrubber(options = {}) {
  const known = options.knownValues || loadKnownSecrets();
  const matchers = buildKnownMatcher(known);

  function scrub(text) {
    if (!text) return text || '';
    let s = String(text);
    if (matchers) for (const re of matchers) s = s.replace(re, REDACTED);
    for (const re of GENERIC_PATTERNS) s = s.replace(re, REDACTED);
    s = s.replace(AUTH_HEADER, (m, kind, val) => (val === REDACTED ? m : kind + ' ' + REDACTED));
    s = s.replace(ASSIGNMENT, (m, key, val) => (val === REDACTED || AUTH_SCHEMES.has(val) ? m : key + REDACTED));
    s = s.replace(URL_USERINFO, '$1' + REDACTED + '$3');
    s = s.replace(SUDO_ECHO, '$1' + REDACTED + '$3');
    return s;
  }

  scrub.knownCount = known.length;
  scrub.containsKnown = (text) => !!matchers && matchers.some(re => { re.lastIndex = 0; return re.test(text); });
  return scrub;
}

module.exports = { createScrubber, REDACTED, _internal: { looksSecret, harvestTokens } };
