---
name: mnemosyne
description: "CIA-grounded memory consolidation. Runs the 5-phase dream cycle: gather signal from recent sessions, score it, promote high-value findings to the right tier, evict stale memories, and rebuild memory indexes. Triggered automatically every 24hrs via .dream-pending flag."
tags: [memory, consolidation, dream, autonomous, mnemosyne]
---

# /mnemosyne — Memory Consolidation Engine

Runs the 5-phase dream cycle. Execute phases in strict order. Do not skip.

```
GATHER → SCORE → PROMOTE → EVICT → INDEX
```

---

## Setup Check

Before first run, verify the Mnemosyne directory structure:

```bash
ls ~/.claude/memory/permanent/ 2>/dev/null && echo "Tier 0 OK" || echo "Tier 0 MISSING — run install.sh"
ls ~/.claude/memory/feedback/ 2>/dev/null && echo "Tier 1 OK" || echo "Tier 1 MISSING — run install.sh"
ls ~/.claude/skills/mnemosyne/dream-gather.js 2>/dev/null && echo "gather OK" || echo "dream-gather.js MISSING"
ls ~/.claude/skills/mnemosyne/dream-evict.js 2>/dev/null && echo "evict OK" || echo "dream-evict.js MISSING"
```

If anything is missing: `bash ~/projects/Mnemosyne/install.sh`

---

## Phase 1: GATHER

**Goal:** Extract signal candidates from recent sessions. Automated — run the utility.

```bash
node ~/.claude/skills/mnemosyne/dream-gather.js --days 7 2>/dev/null > /tmp/dream-candidates.json
```

Review the candidates:

```bash
python3 -c "
import json
d = json.load(open('/tmp/dream-candidates.json'))
print(f'Sessions scanned: {d[\"scannedFiles\"]}')
print(f'Candidates found: {d[\"totalCandidates\"]}')
for c in d['candidates'][:20]:
    print(f'  [{c[\"category\"]:12s}] {c[\"project\"][-30:]:30s}: {c[\"userMessage\"][:70]}')
"
```

The output contains:
- `project`: which project's session
- `category`: correction | preference | decision | recurring | validation
- `signalWeight`: 0.7–1.0 initial estimate
- `userMessage`: the user message containing the signal (up to 300 chars)
- `assistantResponse`: Claude's immediate response (up to 200 chars)

---

## Phase 2: SCORE

**Goal:** Apply the CIA scoring function to each candidate. This is Claude's judgment work.

For each candidate in `/tmp/dream-candidates.json`, apply the scoring rubric:

### Scoring Rubric

| Dimension | High (0.8–1.0) | Medium (0.4–0.7) | Low (0.0–0.3) |
|-----------|----------------|------------------|---------------|
| **Recency** | Session within 3 days | 4–14 days | 15+ days |
| **Relevance** | Fits an existing memory category directly | Fits with interpretation | Marginal fit |
| **Confidence** | Explicit instruction ("always", "never", correction) | Clear preference | Implied or ambiguous |
| **Currency** | Still matches current code/config/state | Partially applicable | Contradicts current state |

**Composite score = Recency × Relevance × Confidence × Currency**

### Tier Assignment

| Composite Score | Scope | Action |
|----------------|-------|--------|
| > 0.7 | Universal — applies to all projects, always | Promote to **Tier 0** (permanent) |
| > 0.6 | Cross-project — applies regardless of project | Promote to **Tier 1** (feedback) |
| > 0.4 | Project-specific | Promote/update **Tier 2** (project memory) |
| < 0.2 | Stale, contradicted, or too ambiguous | Skip |

### Special Rules

- **Corrections always score ≥ 0.9 for Confidence** — the highest-value signal
- **Validations score 0.75 for Confidence** — user confirming Claude's approach is valuable
- **Check existing memories first** — if the fact is already captured accurately, skip it
- **Recurring patterns**: only promote if the same pattern appears in ≥ 2 sessions
- **Do not promote to Tier 0 during automated runs** — Tier 0 requires explicit user intent

---

## Phase 3: PROMOTE

**Goal:** Write high-scoring candidates to the appropriate tier.

For each candidate above threshold:

1. Check whether the fact is already in memory (read existing files first)
2. If exists and accurate: skip
3. If exists but superseded by the new signal: set old entry's `valid_until: superseded-<today>`, then write the new entry
4. If new: write a new memory file

### Memory File Format

```markdown
---
name: <descriptive name>
type: feedback | user | project | reference
recorded_at: <today YYYY-MM-DD>
valid_until: indefinite
scope: global | project:<project-name>
---

<The memory content — concise, actionable, 50–150 words>

**How to apply:** <when and how this should affect behavior>
```

### Tier Placement

- **Tier 1** → `~/.claude/memory/feedback/<name>.md`
- **Tier 2** → `~/.claude/projects/<encoded-dir>/memory/<name>.md`

### Filename Convention

`feedback_<topic>.md`, `user_<aspect>.md`, `project_<feature>.md` — snake_case.

---

## Phase 4: EVICT

**Goal:** Remove stale, expired, and superseded memories.

### 4a: Automated eviction

```bash
node ~/.claude/skills/mnemosyne/dream-evict.js
```

Review the JSON output. It lists what was evicted (expired valid_until) and warns about
upcoming expirations. No files are deleted — `valid_until` is set to `superseded-<today>`.

### 4b: Currency check (Claude judgment)

For each project that had active sessions in the GATHER phase, scan its Tier 2 memories:

- Does this memory still reflect the current state of the project?
- Does anything from the GATHER candidates contradict it?

If a memory is no longer current, update it:
```
valid_until: superseded-<today>
```
Then write a replacement entry with the corrected fact if one exists.

**Do not touch Tier 0** during automated runs — permanent memories require explicit user instruction.

---

## Phase 5: INDEX

**Goal:** Rebuild MEMORY.md index files for touched tiers and projects.

### Tier 0 index

Write `~/.claude/memory/permanent/MEMORY.md`:

```markdown
# Tier 0 — Permanent Global Memory Index

Last consolidated: <today>

| File | Name | Updated |
|------|------|---------|
| global-workflow.md | Global workflow preferences | <date> |
| user-identity.md | User identity and background | <date> |
```

### Tier 1 index

Write `~/.claude/memory/feedback/MEMORY.md`:

```markdown
# Tier 1 — Global Feedback Memory Index

Last consolidated: <today>

| File | Name | Valid Until | Updated |
|------|------|-------------|---------|
<one row per valid (non-superseded) .md file>
```

### Tier 2 project indexes

For each project with modified memories, rebuild `~/.claude/projects/<encoded>/memory/MEMORY.md`:

```markdown
# <Project Name> — Memory Index

Last consolidated: <today>

- [<name>](<file>.md) — <one-line description>
```

Keep MEMORY.md under 200 lines. If over, move oldest entries to `archive.md`.

---

## Dream Run Report

Write the run report after completing all 5 phases:

File: `~/.claude/memory/dream-last-run.md`

```markdown
# Dream Run Report

**Run at:** <ISO timestamp>
**Sessions scanned:** N (last 7 days)
**Signal candidates:** N found, N scored above threshold

## Promoted

- [Tier N] `<filename>`: <one-line summary>

## Evicted

- [Tier N] `<name>`: <reason — expired/superseded/contradicted>

## Skipped

- N candidates below threshold (score < 0.4)
- N already captured accurately in existing memories

## Warnings

- <memories approaching expiry with dates>

## Next Run

Conditions: 24hrs elapsed or explicit /mnemosyne invocation.
```

Then write the timestamp and clean the flag:

```bash
date +%s > ~/.claude/memory/.last-dream
rm -f ~/.claude/.dream-pending
```

---

## Safety Rules

1. **Never delete memory files** — set `valid_until: superseded-<date>` instead
2. **Read before writing** — always check the current content before editing
3. **No duplicates** — check all existing entries before promoting a candidate
4. **Convert relative dates** — "yesterday", "last week" → absolute YYYY-MM-DD
5. **Tier 0 is read-only during automated runs** — only the user can promote to Tier 0
6. **If uncertain about scope** — default to Tier 2 (project) rather than Tier 1 (global)
