'use strict';
const assert = require('assert');
const { createScrubber, REDACTED, _internal } = require('../../src/search/scrub.js');

// All values below are fake.
const KNOWN = ['Fake-Sudo-Pw-91x', 'labkey-meili-2099', 'Zq7#plainpw'];
const scrub = createScrubber({ knownValues: KNOWN });

let failures = 0;
function check(name, input, mustNotContain, mustContain) {
  const out = scrub(input);
  try {
    for (const s of [].concat(mustNotContain)) assert.ok(!out.includes(s), `${name}: still contains ${s}`);
    for (const s of [].concat(mustContain || [])) assert.ok(out.includes(s), `${name}: lost ${s}`);
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}: ${e.message}\n       → ${out}`);
  }
}

console.log('scrub: known values');
check('known in prose', 'the sudo password is Fake-Sudo-Pw-91x on baloo', 'Fake-Sudo-Pw-91x', ['baloo', REDACTED]);
check('known in curl header', 'curl -H "Authorization: Bearer labkey-meili-2099" http://baloo:7700', 'labkey-meili-2099', 'http://baloo:7700');
check('known with symbols', "echo 'Zq7#plainpw' done", 'Zq7#plainpw');
check('multiple occurrences', 'Fake-Sudo-Pw-91x and Fake-Sudo-Pw-91x', 'Fake-Sudo-Pw-91x');

console.log('scrub: generic patterns');
check('anthropic key', 'key sk-ant-api03-AAAAbbbbCCCCdddd1234 here', 'sk-ant-api03-AAAAbbbbCCCCdddd1234');
check('github token', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'ghp_abcdefghijklmnopqrstuvwxyz0123');
check('aws key', 'AKIAABCDEFGHIJKLMNOP', 'AKIAABCDEFGHIJKLMNOP');
check('jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0');
check('password assignment', 'DB_PASSWORD=hunter2hunter2 next', 'hunter2hunter2', 'DB_PASSWORD=');
check('password colon', 'password: s3cr3tValue', 's3cr3tValue', 'password:');
check('bearer unknown', 'Authorization: Bearer abc123def456ghi789', 'abc123def456ghi789');
check('url userinfo', 'https://admin:pa55word@example.com/x', 'pa55word', 'example.com');
check('echo | sudo -S', "echo 'unknownpw' | sudo -S systemctl restart x", 'unknownpw', 'sudo -S');
check('private key', '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3Nza\n-----END OPENSSH PRIVATE KEY-----', 'AAAAB3Nza');

console.log('scrub: leaves normal text alone');
check('plain prose', 'Restart nginx on deberprod02 and check /var/log/nginx/error.log', [], ['nginx', 'deberprod02', '/var/log/nginx/error.log']);
check('empty', '', []);
assert.strictEqual(scrub(null), '');

console.log('harvest heuristics');
const harvested = _internal.harvestTokens('| baloo | `tonylab-fake-2026` | /home/x/file.md | baloo.int.larcombe.tech | 192.168.1.5 | `Abc!2345xyz` |');
try {
  assert.ok(harvested.has('tonylab-fake-2026'), 'should harvest dashed key');
  assert.ok(harvested.has('Abc!2345xyz'), 'should harvest mixed password');
  assert.ok(!harvested.has('baloo.int.larcombe.tech'), 'should skip hostname');
  assert.ok(!harvested.has('192.168.1.5'), 'should skip IP');
  assert.ok(![...harvested].some(t => t.startsWith('/')), 'should skip paths');
  console.log('  ok  harvest');
} catch (e) { failures++; console.log(`  FAIL harvest: ${e.message}`); }

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll scrub tests passed');
