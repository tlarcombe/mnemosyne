'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Build a fake projects root:
//   root/StackMarket/.git            → project with sub-folders
//   root/StackMarket/Website/
//   root/personal/                   → container (no marker)
//   root/personal/drcct.org/CLAUDE.md
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mnem-pg-'));
fs.mkdirSync(path.join(root, 'StackMarket', '.git'), { recursive: true });
fs.mkdirSync(path.join(root, 'StackMarket', 'Website', 'api'), { recursive: true });
fs.mkdirSync(path.join(root, 'personal', 'drcct.org'), { recursive: true });
fs.writeFileSync(path.join(root, 'personal', 'drcct.org', 'CLAUDE.md'), '');

process.env.MNEMOSYNE_PROJECTS_ROOT = root;
const { projectGroup } = require('../../src/search/project-group.js');

const cases = [
  ['StackMarket',                 { group: 'StackMarket', sub: '' }],
  ['StackMarket/Website',         { group: 'StackMarket', sub: 'Website' }],
  ['StackMarket/Website/api',     { group: 'StackMarket', sub: 'Website/api' }],
  ['personal/drcct.org',          { group: 'drcct.org',   sub: '' }],
  ['personal',                    { group: 'personal',    sub: '' }],
  // moved/deleted paths are never treated as containers
  ['Gone/Child',                  { group: 'Gone',        sub: 'Child' }],
];
for (const [rel, expected] of cases) {
  assert.deepStrictEqual(projectGroup(path.join(root, rel), 'x'), expected, rel);
}

// Outside the root: fall back to the stored name, then the basename
assert.deepStrictEqual(projectGroup('/home/someone', 'someone'), { group: 'someone', sub: '' });
assert.deepStrictEqual(projectGroup('/srv/app', ''), { group: 'app', sub: '' });
assert.deepStrictEqual(projectGroup('', ''), { group: 'unknown', sub: '' });

fs.rmSync(root, { recursive: true, force: true });
console.log('projectGroup: OK');
