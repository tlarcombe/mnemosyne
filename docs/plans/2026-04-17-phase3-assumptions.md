# Phase 3 — Assumption Register Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the CIA Level 4 Adversarial Frame mechanism — extract implicit assumptions from sessions at Stop time, write them to `assumptions.md`, and surface the top 3 at SessionStart so they can be challenged rather than silently inherited.

**Architecture:** A Stop hook (`mnemosyne-stop.js`) pattern-matches user messages in the session JSONL for implicit assumption signals, deduplicates against the existing `assumptions.md`, and appends new entries. The existing `mnemosyne-session-start.js` is extended to read the current project's `assumptions.md` and inject the 3 most recently added assumptions into session context.

**Tech Stack:** Node.js (matching existing hook convention), regex pattern matching (no LLM API required), Mnemosyne memory schema (frontmatter markdown)

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/hooks/mnemosyne-stop.js` | Stop hook: extract assumptions from JSONL, append to assumptions.md |
| Modify | `src/hooks/mnemosyne-session-start.js` | Add assumptions section to SessionStart additionalContext |
| Modify | `install.sh` | Wire mnemosyne-stop.js as Stop hook in settings.json |

---

## Task 1: Create `mnemosyne-stop.js`

**Files:**
- Create: `src/hooks/mnemosyne-stop.js`

### How the Stop hook receives data

Claude Code sends a JSON object on stdin containing `transcript_path` (absolute path to the session JSONL). The hook runs with `cwd` set to the project working directory (`process.cwd()`). The hook is wired as `async: true` — it fires in the background and Claude Code does not wait for it to finish.

### Assumption signal patterns

The hook scans **user messages only** (not assistant messages) for these 5 pattern categories:

| Category | Detects | Example |
|----------|---------|---------|
| `correction` | User reveals what they assumed Claude would know | "I thought you knew…", "I assumed…" |
| `explicit` | Stated as given background | "Given that…", "Assuming that…" |
| `tech-stack` | Tech/architecture treated as settled | "This project uses Node.js" |
| `state` | Assumed state of the world | "X should already be there" |
| `decision` | Agreed approach not formally recorded | "We're using…", "The plan is…" |

### Project dir encoding

`cwd.replace(/\//g, '-')` produces the encoded directory name. Since a session might run in a subdirectory (e.g., `src/hooks/`), the hook walks upward until it finds a matching `~/.claude/projects/<encoded>` directory.

### `assumptions.md` format

```markdown
---
name: Assumption Register
type: project
recorded_at: 2026-04-17
valid_until: indefinite
scope: project:Mnemosyne
---

## Active Assumptions

- [2026-04-17] (tech-stack) This project uses Node.js for all hook scripts (session:1deec317)
- [2026-04-17] (correction) I thought the install step was already done (session:2abc1234)
```

New entries are appended to the `## Active Assumptions` section. Deduplication is a case-insensitive substring match on the normalized assumption text.

- [ ] **Step 1: Create the file**

`src/hooks/mnemosyne-stop.js`:

```javascript
#!/usr/bin/env node
'use strict';

/**
 * mnemosyne-stop.js
 *
 * Mnemosyne Phase 3 — Stop hook (async).
 *
 * Extracts implicit assumption signals from the current session JSONL transcript.
 * Appends new, deduplicated assumptions to:
 *   ~/.claude/projects/<encoded-cwd>/memory/assumptions.md
 *
 * Wired as async: true — fires in the background, does not block Claude Code.
 *
 * Stdin JSON shape: { transcript_path: string, ... }
 * cwd: process.cwd() (Claude Code runs hooks in the project directory)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const TODAY = new Date().toISOString().split('T')[0];

const ASSUMPTION_PATTERNS = [
  {
    pattern: /\b(I (assumed|thought|was assuming|expected|figured)|I thought you (knew|understood|had))\b(.{0,120})/i,
    category: 'correction',
  },
  {
    pattern: /\b(let'?s assume|assuming that|given that|we'?re assuming|on the assumption that)\b(.{0,120})/i,
    category: 'explicit',
  },
  {
    pattern: /\b(this (project|repo|codebase|app) (uses?|is using|runs?|is built (with|in)|is written in))\b(.{0,120})/i,
    category: 'tech-stack',
  },
  {
    pattern: /\b((you|we|it) (should|must) already|should (already be|be there|exist|work|be done))\b(.{0,120})/i,
    category: 'state',
  },
  {
    pattern: /\b(we'?re using|we (agreed|decided|chose)|the (plan|approach|architecture) is)\b(.{0,120})/i,
    category: 'decision',
  },
];

function extractTextFromMessage(d) {
  const content = d.message?.content ?? d.content;
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(c => c && c.type === 'text').map(c => c.text || '').join(' ');
  }
  return '';
}

function scanTranscript(transcriptPath) {
  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }

  const candidates = [];

  for (const line of lines) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }

    const role = d.type || d.message?.role;
    if (role !== 'user') continue;

    const text = extractTextFromMessage(d).trim();
    if (!text) continue;

    for (const { pattern, category } of ASSUMPTION_PATTERNS) {
      const m = pattern.exec(text);
      if (!m) continue;

      // Normalize: take the full match, trim, collapse whitespace
      const raw = m[0].replace(/\s+/g, ' ').trim();
      const normalized = raw.length > 150 ? raw.slice(0, 147) + '...' : raw;
      candidates.push({ normalized, category });
      break; // one signal per user message
    }
  }

  return candidates;
}

function getSessionId(transcriptPath) {
  return path.basename(transcriptPath, '.jsonl').slice(0, 8);
}

function findProjectDir(cwd) {
  let current = cwd;
  while (current && current !== path.dirname(current)) {
    const encoded = current.replace(/\//g, '-');
    const projectDir = path.join(CLAUDE_DIR, 'projects', encoded);
    if (fs.existsSync(projectDir)) return projectDir;
    current = path.dirname(current);
  }
  return null;
}

function getProjectName(projectDir) {
  // Encoded dir is like -home-tlarcombe-projects-Mnemosyne
  // Project name is the last segment
  return path.basename(projectDir).replace(/^.*-/, '');
}

function readAssumptions(assumptionsPath) {
  try {
    return fs.readFileSync(assumptionsPath, 'utf8');
  } catch {
    return null;
  }
}

function buildInitialFile(projectName) {
  return `---
name: Assumption Register
type: project
recorded_at: ${TODAY}
valid_until: indefinite
scope: project:${projectName}
---

## Active Assumptions

`;
}

function isDuplicate(existingContent, normalized) {
  const lower = normalized.toLowerCase();
  return existingContent.toLowerCase().includes(lower.slice(0, 50));
}

function appendAssumptions(assumptionsPath, newCandidates, sessionId, projectName) {
  let content = readAssumptions(assumptionsPath);
  let created = false;

  if (!content) {
    content = buildInitialFile(projectName);
    created = true;
  }

  // Ensure ## Active Assumptions section exists
  if (!content.includes('## Active Assumptions')) {
    content += '\n## Active Assumptions\n\n';
  }

  let added = 0;
  for (const { normalized, category } of newCandidates) {
    if (isDuplicate(content, normalized)) continue;
    const entry = `- [${TODAY}] (${category}) ${normalized} (session:${sessionId})\n`;
    content += entry;
    added++;
  }

  if (created || added > 0) {
    const memDir = path.dirname(assumptionsPath);
    if (!fs.existsSync(memDir)) fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(assumptionsPath, content);
    process.stderr.write(`[Mnemosyne] assumptions: +${added} entries (${created ? 'created' : 'updated'}) → ${assumptionsPath}\n`);
  }
}

function main() {
  let transcriptPath = null;
  let stdinData = '';

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { stdinData += chunk; });
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(stdinData);
      transcriptPath = input.transcript_path;
    } catch {
      transcriptPath = process.env.CLAUDE_TRANSCRIPT_PATH || null;
    }

    if (!transcriptPath || !fs.existsSync(transcriptPath)) return;

    const cwd = process.cwd();
    const projectDir = findProjectDir(cwd);
    if (!projectDir) {
      process.stderr.write(`[Mnemosyne] assumptions: no project dir found for cwd: ${cwd}\n`);
      return;
    }

    const projectName = getProjectName(projectDir);
    const assumptionsPath = path.join(projectDir, 'memory', 'assumptions.md');
    const sessionId = getSessionId(transcriptPath);

    const candidates = scanTranscript(transcriptPath);
    if (candidates.length === 0) return;

    appendAssumptions(assumptionsPath, candidates, sessionId, projectName);
  });
}

main();
```

- [ ] **Step 2: Verify the file exists**

```bash
ls -la /home/tlarcombe/projects/Mnemosyne/src/hooks/mnemosyne-stop.js
```

Expected: file listed with non-zero size.

- [ ] **Step 3: Run a quick smoke test against a known JSONL file**

```bash
# Find a recent session JSONL
LATEST=$(ls -t ~/.claude/projects/-home-tlarcombe-projects-Mnemosyne/*.jsonl 2>/dev/null | head -1)
echo "Testing against: $LATEST"

# Pipe a fake Stop event to the hook
echo "{\"transcript_path\": \"$LATEST\"}" | node /home/tlarcombe/projects/Mnemosyne/src/hooks/mnemosyne-stop.js 2>&1
```

Expected stderr output (if assumptions found):
```
[Mnemosyne] assumptions: +N entries (created|updated) → /home/tlarcombe/.claude/projects/...
```

If `+0 entries`: transcript has no assumption signals — that's fine. The hook exits silently.

- [ ] **Step 4: Inspect the output file if created**

```bash
ENCODED=$(echo "/home/tlarcombe/projects/Mnemosyne" | sed 's|/|-|g')
cat ~/.claude/projects/${ENCODED}/memory/assumptions.md 2>/dev/null || echo "Not created (no signals found)"
```

Expected: either a well-formed assumptions.md with dated entries, or "Not created" message.

- [ ] **Step 5: Commit**

```bash
git -C /home/tlarcombe/projects/Mnemosyne add src/hooks/mnemosyne-stop.js
git -C /home/tlarcombe/projects/Mnemosyne commit -m "feat: mnemosyne-stop.js — assumption signal extractor"
```

---

## Task 2: Add Assumptions Surfacing to SessionStart

**Files:**
- Modify: `src/hooks/mnemosyne-session-start.js`

The existing hook loads Tier 0 and Tier 1 only. We extend it to also:
1. Detect the current project dir from `event.cwd` (walking up the tree)
2. Read `assumptions.md` from that project's memory dir
3. Extract the last 3 non-blank assumption lines (most recently added)
4. Inject them as a new `## Active Assumptions` section at the end of `additionalContext`

Token budget: assumptions section is capped at 300 tokens (~1200 chars). It is injected **after** Tier 1 and is counted against the shared char budget.

- [ ] **Step 1: Add the helper functions**

In `src/hooks/mnemosyne-session-start.js`, after the `buildSection` function (around line 107), add:

```javascript
function encodeCwd(cwd) {
  return cwd.replace(/\//g, '-');
}

function findProjectDir(cwd) {
  let current = cwd;
  while (current && current !== path.dirname(current)) {
    const encoded = encodeCwd(current);
    const projectDir = path.join(CLAUDE_DIR, 'projects', encoded);
    if (fs.existsSync(projectDir)) return projectDir;
    current = path.dirname(current);
  }
  return null;
}

function loadTopAssumptions(projectDir, maxCount) {
  const assumptionsPath = path.join(projectDir, 'memory', 'assumptions.md');
  let content;
  try {
    content = fs.readFileSync(assumptionsPath, 'utf8');
  } catch {
    return [];
  }

  // Find the ## Active Assumptions section
  const sectionMatch = content.match(/## Active Assumptions\n([\s\S]*?)(?=\n##|\s*$)/);
  if (!sectionMatch) return [];

  const lines = sectionMatch[1]
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('- ['));

  // Return last N (most recently added)
  return lines.slice(-maxCount);
}
```

- [ ] **Step 2: Extend `main()` to inject assumptions**

In `main()`, after the Tier 1 section is built (after the `if (tier1Files.length > 0 && remainingChars > 0)` block), add:

```javascript
  const cwd = (event && event.cwd) ? event.cwd : process.cwd();
  const projectDir = findProjectDir(cwd);

  let assumptionLines = [];
  if (projectDir && remainingChars > 0) {
    assumptionLines = loadTopAssumptions(projectDir, 3);
    if (assumptionLines.length > 0) {
      const assumptionText = `## Active Assumptions (Project)\n\n${assumptionLines.join('\n')}`;
      if (assumptionText.length <= remainingChars && assumptionText.length <= 1200) {
        sections.push(assumptionText);
        remainingChars -= assumptionText.length;
      }
    }
  }
```

- [ ] **Step 3: Update the stderr log line**

Replace the existing `process.stderr.write(...)` call with one that includes the assumptions count:

```javascript
  process.stderr.write(
    `[Mnemosyne] Tier 0: ${tier0Files.length} files | Tier 1: ${tier1Files.length} files | Assumptions: ${assumptionLines.length} | ~${totalTokens} tokens | cwd: ${cwd}\n`
  );
```

- [ ] **Step 4: Show the full updated `main()` function for reference**

The complete `main()` function after both changes:

```javascript
function main() {
  const raw = fs.readFileSync(0, 'utf8');

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    process.stdout.write(raw);
    return;
  }

  const tier0Files = readMemoryFiles(PERMANENT_DIR);

  const tier1Files = readMemoryFiles(FEEDBACK_DIR)
    .filter(({ content }) => isValid(content))
    .slice(0, 50);

  if (tier0Files.length === 0 && tier1Files.length === 0) {
    process.stdout.write(raw);
    return;
  }

  let remainingChars = CHAR_BUDGET;
  const sections = [];

  if (tier0Files.length > 0) {
    const { text, charsUsed } = buildSection(0, tier0Files, remainingChars);
    if (text) {
      sections.push(`## Tier 0 — Permanent Global Memory\n\n${text}`);
      remainingChars -= charsUsed;
    }
  }

  if (tier1Files.length > 0 && remainingChars > 0) {
    const { text, charsUsed } = buildSection(1, tier1Files, remainingChars);
    if (text) {
      sections.push(`## Tier 1 — Global Feedback Memory\n\n${text}`);
      remainingChars -= charsUsed;
    }
  }

  const cwd = (event && event.cwd) ? event.cwd : process.cwd();
  const projectDir = findProjectDir(cwd);

  let assumptionLines = [];
  if (projectDir && remainingChars > 0) {
    assumptionLines = loadTopAssumptions(projectDir, 3);
    if (assumptionLines.length > 0) {
      const assumptionText = `## Active Assumptions (Project)\n\n${assumptionLines.join('\n')}`;
      if (assumptionText.length <= remainingChars && assumptionText.length <= 1200) {
        sections.push(assumptionText);
        remainingChars -= assumptionText.length;
      }
    }
  }

  const totalTokens = estimateTokens(sections.join('\n\n'));

  process.stderr.write(
    `[Mnemosyne] Tier 0: ${tier0Files.length} files | Tier 1: ${tier1Files.length} files | Assumptions: ${assumptionLines.length} | ~${totalTokens} tokens | cwd: ${cwd}\n`
  );

  const additionalContext = sections.length > 0
    ? `# Mnemosyne Memory (Tiers 0–1)\n\n${sections.join('\n\n')}`
    : '';

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    }
  }));
}
```

- [ ] **Step 5: Test the updated hook**

```bash
# Test with a fake SessionStart event for the Mnemosyne project
echo '{"hookEventName":"SessionStart","cwd":"/home/tlarcombe/projects/Mnemosyne"}' \
  | node /home/tlarcombe/.claude/scripts/hooks/mnemosyne-session-start.js 2>&1 \
  | python3 -c "
import json, sys
data = sys.stdin.read()
# stderr goes directly, try to parse stdout portion
try:
    # Split on first { that looks like JSON
    lines = data.split('\n')
    for i, l in enumerate(lines):
        if l.startswith('{'):
            obj = json.loads('\n'.join(lines[i:]))
            ctx = obj.get('hookSpecificOutput', {}).get('additionalContext', '')
            print('=== additionalContext preview ===')
            print(ctx[:600])
            break
except Exception as e:
    print('Parse error:', e)
    print(data[:500])
"
```

Expected: additionalContext includes `## Tier 0`, `## Tier 1`, and (if assumptions.md exists for the project) an `## Active Assumptions (Project)` section.

- [ ] **Step 6: Commit**

```bash
git -C /home/tlarcombe/projects/Mnemosyne add src/hooks/mnemosyne-session-start.js
git -C /home/tlarcombe/projects/Mnemosyne commit -m "feat: surface top 3 project assumptions in SessionStart context"
```

---

## Task 3: Wire the Stop Hook in install.sh

**Files:**
- Modify: `install.sh`

The installer currently has 7 steps. We add step 8: deploy `mnemosyne-stop.js` and wire it in `settings.json` as an async Stop hook.

- [ ] **Step 1: Add the stop hook deploy + wire block to install.sh**

Append after step 7 (the dream skill deploy), before the final echo block:

```bash
# Step 8: Deploy mnemosyne-stop.js and wire as Stop hook
echo "[8/8] Wiring Mnemosyne Stop hook (assumption extractor)..."
cp "$MNEMOSYNE_DIR/src/hooks/mnemosyne-stop.js" "$HOOKS_DIR/"
echo "  ~/.claude/scripts/hooks/mnemosyne-stop.js — OK"

node -e "
const fs = require('fs');
const p = process.env.HOME + '/.claude/settings.json';
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
const hookCmd = 'node \"' + process.env.HOME + '/.claude/scripts/hooks/mnemosyne-stop.js\"';
const hook = {
  matcher: '*',
  hooks: [{ type: 'command', command: hookCmd }],
  description: 'Mnemosyne: extract implicit assumptions from session transcript',
  id: 'mnemosyne:stop:assumptions',
  async: true,
  timeout: 30
};
const existing = s.hooks.Stop || [];
const idx = existing.findIndex(h => h.id === 'mnemosyne:stop:assumptions');
if (idx >= 0) {
  existing[idx] = hook;
  s.hooks.Stop = existing;
  console.log('  Updated existing mnemosyne:stop:assumptions hook');
} else {
  s.hooks.Stop = [...existing, hook];
  console.log('  Wired: mnemosyne:stop:assumptions added as Stop hook');
}
fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
"
```

Also update the step count references: change `[7/7]` → `[7/8]` and the header echo to `=== Installation complete (8 steps) ===`.

- [ ] **Step 2: Update the step count in install.sh**

Find `echo "[7/7]` and change to `echo "[7/8]"`. Find `echo "=== Installation complete ==="` and leave as-is (or update if needed).

- [ ] **Step 3: Run the installer to apply the new step**

```bash
bash /home/tlarcombe/projects/Mnemosyne/install.sh 2>&1 | tail -20
```

Expected output ending:
```
[7/8] Deploying /mnemosyne dream skill...
  ~/.claude/skills/mnemosyne/ — OK (SKILL.md, dream-gather.js, dream-evict.js)
[8/8] Wiring Mnemosyne Stop hook (assumption extractor)...
  ~/.claude/scripts/hooks/mnemosyne-stop.js — OK
  Wired: mnemosyne:stop:assumptions added as Stop hook
  (or: Updated existing mnemosyne:stop:assumptions hook)

=== Installation complete ===
```

- [ ] **Step 4: Verify the hook is wired in settings.json**

```bash
node -e "
const s = require(process.env.HOME + '/.claude/settings.json');
const h = (s.hooks.Stop || []).find(h => h.id === 'mnemosyne:stop:assumptions');
console.log(h ? 'WIRED: ' + h.description : 'NOT FOUND');
"
```

Expected: `WIRED: Mnemosyne: extract implicit assumptions from session transcript`

- [ ] **Step 5: Verify deployed file**

```bash
ls -la ~/.claude/scripts/hooks/mnemosyne-stop.js
```

Expected: file listed.

- [ ] **Step 6: Final commit**

```bash
cd /home/tlarcombe/projects/Mnemosyne
git add install.sh
git commit -m "feat: Phase 3 complete — assumption register (Stop hook + SessionStart surfacing)"
```

---

## Self-Review

**Spec coverage:**
- ✅ Stop hook extracts implicit assumptions from session content
- ✅ Writes to `~/.claude/projects/<encoded>/memory/assumptions.md` with dates
- ✅ Top 3 assumptions surfaced at SessionStart injection
- ✅ Bitemporal format (frontmatter with `recorded_at`, `valid_until`, `scope`)
- ✅ install.sh deploys and wires everything

**Placeholder scan:** No TBDs, no "add error handling" stubs. All code is complete.

**Type/name consistency:**
- `findProjectDir(cwd)` — same name in both files
- `loadTopAssumptions(projectDir, 3)` — called in main(), defined as helper
- `assumptionLines` — array of strings, used consistently
- `ASSUMPTION_PATTERNS` — array of `{ pattern, category }` objects
- `appendAssumptions(path, candidates, sessionId, projectName)` — called after scan

---

## Post-Install Verification

After running `bash install.sh` and starting a new session:

```bash
# Check the session-start hook logs at next session
# Look for the updated log line format:
# [Mnemosyne] Tier 0: 2 files | Tier 1: 0 files | Assumptions: 3 | ~280 tokens | cwd: ...

# To manually trigger assumption extraction on the current session:
LATEST=$(ls -t ~/.claude/projects/-home-tlarcombe-projects-Mnemosyne/*.jsonl 2>/dev/null | head -1)
echo "{\"transcript_path\": \"$LATEST\"}" | node ~/.claude/scripts/hooks/mnemosyne-stop.js

# Check the result:
cat ~/.claude/projects/-home-tlarcombe-projects-Mnemosyne/memory/assumptions.md
```
