'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { scanFile, signalText } = require('../../src/dream/dream-gather.js');

function writeSession(userTexts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gather-test-'));
  const file = path.join(dir, 'session.jsonl');
  const lines = [];
  for (const t of userTexts) {
    lines.push(JSON.stringify({ type: 'user', message: { content: t } }));
    lines.push(JSON.stringify({ type: 'assistant', message: { content: 'ok' } }));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

// signalText strips pasted blocks
{
  const t = signalText('Fix this <pasted_content id="x">actually the wrong thing</pasted_content> please');
  assert.ok(!/actually|wrong/.test(t), `pasted body should be stripped, got: ${t}`);
}

// Real harness format: the closing tag carries the id too
{
  const t = signalText('Look <pasted_content id="a1">actually wrong log</pasted_content id="a1"> no, retry it');
  assert.ok(!/actually|wrong log/.test(t), `closing tag with id should be stripped, got: ${t}`);
  assert.ok(/no, retry it/.test(t));
}

// Own words around a long paste are still scanned
{
  const c = scanFile(writeSession([
    'No, that is wrong. <pasted_content id="b2">' + 'log line\n'.repeat(500) + '</pasted_content id="b2">',
  ]), 'p');
  assert.strictEqual(c.length, 1, `expected own-words correction kept, got ${c.length}`);
}

// A genuine short correction is still detected
{
  const c = scanFile(writeSession(["No, that's not right, use port 8080"]), 'p');
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].category, 'correction');
}

// Correction words only inside a pasted block are ignored
{
  const c = scanFile(writeSession([
    'Summarise this:\n<pasted_content id="abc">Actually, I said the wrong date in my application.</pasted_content>',
  ]), 'p');
  assert.strictEqual(c.length, 0, `expected 0 candidates, got ${c.length}`);
}

// Long untagged pastes (speeches, emails) are ignored
{
  const long = 'Dear all, actually I wanted to say ' + 'lorem ipsum '.repeat(200);
  const c = scanFile(writeSession([long]), 'p');
  assert.strictEqual(c.length, 0, `expected long paste to be skipped, got ${c.length}`);
}

console.log('test-gather.js: all assertions passed');
