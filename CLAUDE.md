# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A more detailed project brief is available at ~/projects/Mnemosyne/mnemosyne-project-brief.txt

## What This Project Is

Mnemosyne is a CIA-grounded memory management layer for Claude Code. It is **not a standalone application** — it is a set of hooks, skills, and scripts that integrate with the `~/.claude/` infrastructure. It implements the 5-tier memory architecture described in Tony's dissertation at `/home/tlarcombe/projects/context_decay/docs/Conversation Intelligence Architecture.docx`.

The project lives at `~/projects/Mnemosyne/` and syncs to other lab machines via NAS. Installable components deploy into `~/.claude/` following the claude++ pattern at `~/projects/claude++`.

## Memory Tier Architecture

| Tier | Scope | Location | Injection | Eviction |
|------|-------|----------|-----------|----------|
| 0 — Permanent | Global, never evicts | `~/.claude/memory/permanent/` | Always | Manual only |
| 1 — Global Feedback | Cross-project, slow decay | `~/.claude/memory/feedback/` | Always, capped 50 entries | 90 days without reinforcement |
| 2 — Project Memory | Project-scoped | `~/.claude/projects/<encoded>/memory/` | When cwd matches | 30 days without reference |
| 3 — Session Memory | Recent sessions only | `~/.claude/projects/<encoded>/memory/sessions/` | Most recent 3 sessions | 7 days |
| 4 — Verbatim Archive | Full JSONL journey | `~/.claude/projects/<encoded>/` | Never injected — query only | Never |

Total injected memory capped at ~3000 tokens. Tier 3 evicted first when over budget.

## Memory File Schema

Every memory file uses this frontmatter:

```markdown
---
name: ...
type: feedback | user | project | reference
recorded_at: 2026-04-17
valid_until: indefinite | 2026-06-01 | superseded-2026-04-17
scope: global | project:<name>
---
```

Corrections mark the old entry's `valid_until` as `superseded-<date>` rather than deleting it (bitemporal pattern from dissertation Chapter 8).

## Key Integration Points

**Hooks** (all in `~/.claude/settings.json`):
- `SessionStart` — bootstrap loads tiers 0→3 in order with project isolation
- `Stop` — triggers `/dream` consolidation cycle and extracts implicit assumptions
- `PostToolUse` — edit accumulator (existing, from claude++)

**Skills** deployed to `~/.claude/skills/mnemosyne/`:
- `/dream` — the consolidation engine (gather → score → promote → evict → index)
- `/memory-status` — shows what's loaded, from which tier, token count
- `/memory-search` — Phase 4 only; semantic search over Tier 4 JSONL archive

**Assumption register**: `~/.claude/projects/<encoded>/memory/assumptions.md`
- Written at Stop time: implicit premises the session treated as accepted background
- Top 3 surfaced at SessionStart so they can be challenged

## Implementation Phases

- **Phase 1** — Foundations: schema migration, directory structure, rewritten SessionStart bootstrap with tier isolation and token cap, `/memory-status` command
- **Phase 2** — Dream rebuilt: 5-phase cycle with scoring (recency + relevance + currency + confidence), bitemporal eviction, run report at `~/.claude/memory/dream-last-run.md`
- **Phase 3** — Assumption register: Stop hook extraction, assumptions.md, surfacing at SessionStart
- **Phase 4** — Vector search (ChromaDB over Tier 4 JSONL, `/memory-search` command) — optional, addable without restructuring earlier tiers

## What to Read Before Changing the Bootstrap

The SessionStart bootstrap is the most sensitive component — it is what fixes context bleed. Before modifying it, read:
- `~/.claude/scripts/hooks/session-start-bootstrap.js` — current implementation
- `~/.claude/settings.json` — hook wiring
- `~/projects/claude++/CLAUDE.md` — overall claude++ architecture

## Hooks Are Node.js

All hook scripts follow the existing claude++ convention: Node.js (`.js`) for logic-heavy hooks, bash for simple wrappers. Do not introduce Python or other runtimes into the hook layer.
