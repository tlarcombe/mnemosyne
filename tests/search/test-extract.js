'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { extractMessages, getProjectName } = require('../../src/search/dream-index.js');

// ── getProjectName ────────────────────────────────────────────────────────────

{
  const result = getProjectName('/home/tlarcombe/projects/Mnemosyne');
  assert.strictEqual(result, 'Mnemosyne', `Expected 'Mnemosyne', got '${result}'`);
}

{
  const result = getProjectName('/home/tlarcombe/projects/my-cool-app');
  assert.strictEqual(result, 'my-cool-app', `Expected 'my-cool-app', got '${result}'`);
}

{
  const result = getProjectName('/home/tlarcombe');
  assert.strictEqual(result, 'tlarcombe', `Expected 'tlarcombe', got '${result}'`);
}

// ── extractMessages ───────────────────────────────────────────────────────────

{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnem-test-'));
  const filePath = path.join(tmpDir, 'abc123.jsonl');

  const lines = [
    JSON.stringify({ type: 'custom-title', customTitle: 'Test', sessionId: 'abc123' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'How do I set up a git hook?' }, sessionId: 'abc123' }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'You can add a pre-commit hook by creating .git/hooks/pre-commit' }, sessionId: 'abc123' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'What about post-commit?' }] }, sessionId: 'abc123' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'ok' }, sessionId: 'abc123' }),
  ].join('\n');

  fs.writeFileSync(filePath, lines);

  const msgs = extractMessages(filePath, 'abc123', 'TestProject', '/home/user/projects/TestProject');

  assert.strictEqual(msgs.length, 3, `Expected 3 messages (skipping 'ok' which is too short), got ${msgs.length}`);
  assert.strictEqual(msgs[0].role, 'user');
  assert.ok(msgs[0].text.includes('git hook'), `First msg should mention git hook: ${msgs[0].text}`);
  assert.strictEqual(msgs[0].project, 'TestProject');
  assert.strictEqual(msgs[0].session_id, 'abc123');
  assert.strictEqual(msgs[1].role, 'assistant');
  assert.ok(msgs[1].text.includes('pre-commit'), `Second msg should mention pre-commit: ${msgs[1].text}`);
  assert.strictEqual(msgs[2].role, 'user');
  assert.ok(msgs[2].text.includes('post-commit'), `Third msg should mention post-commit: ${msgs[2].text}`);
  assert.deepStrictEqual(msgs.map(m => m.msg_index), [0, 1, 2]);

  fs.rmSync(tmpDir, { recursive: true });
}

console.log('test-extract.js: all assertions passed');
