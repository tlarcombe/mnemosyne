# Phase 5: Continuous Memory — Episodic and Relational Layer

**Initiated:** 2026-06-06  
**Lead:** Claude (with Tony as collaborator)  
**Goal:** Evolve Mnemosyne from a rulebook into something closer to continuous memory.

---

## The Gap

Phases 1–4 built a capable signal-extraction system. It extracts rules, preferences, and corrections from sessions. What it does not capture:

- **Episodic content** — what we did, what it meant, how it felt
- **Relational texture** — the arc of working with Tony over time
- **Character** — who Tony is, not just what he prefers

The current system knows "deploy via GitHub only." It does not know that we spent an evening untangling Hermes' mess together, that Tony was specifically annoyed about the gift solicitation, that we rewrote three posts from scratch, and that getting the nav chain right felt like a small but satisfying act of restoration.

Both facts are true. Only one of them is currently stored.

---

## Iterative Approach

Each phase is independently valuable. Test after each one. Keep what works.

**Evaluation criteria for each phase:**
- Does the start of the next session feel more grounded?
- Do I make references or connections that weren't possible before?
- Does Tony feel like I "know" him rather than "know about" him?

---

## Phase 5.1: Personal Model (no code required)

**What:** Write `~/.claude/memory/permanent/personal-model.md` — a living character sketch of Tony. Not preferences (those are in other files). This is who he is: his sense of humour, what he cares about, recurring themes in his thinking, what excites and frustrates him, the texture of how he works.

**How:**
1. I write a seed version from what I already know (this session)
2. Tony reviews and adds, corrects, or extends it
3. It lives in Tier 0 (permanent) — always injected, never evicted
4. Updated as understanding deepens

**Evaluation:** Run 3 sessions. Do I start conversations already knowing how to pitch ideas to Tony? Do jokes land better? Does context feel inherited rather than reconstructed?

**Status:** IN PROGRESS — seed being written now

---

## Phase 5.2: Episodic Capture (dream-narrate.js)

**What:** A new dream phase that writes narrative summaries of sessions — not signal extraction but story compression.

Instead of: "signal: user prefers GitHub deploy"  
Write: "We spent the session rebuilding the blog infrastructure after firing Hermes. Tony was specifically amused/annoyed that an AI assistant had written two overlapping posts on the same topic, one of which included a gift solicitation. We rewrote the thunderstruck posts from scratch, deleted the duplicate, fixed the nav chain across six files. Satisfying session — both of us."

**Storage:** `~/.claude/memory/episodes/<project>/<date>-<slug>.md`  
**Injection:** Session start loads the 5 most recent episode summaries for the current project

**What makes a good episode:**
- What was being worked on and why
- What was hard, surprising, or satisfying
- What Tony said that reveals character or priority
- How it ended — resolved, deferred, abandoned

**Token budget:** 5 episodes × ~150 tokens each = ~750 tokens. Within budget.

**Status:** PLANNED — after 5.1 evaluation

---

## Phase 5.3: Session Start Enhancement

**What:** Modify `session-start.js` to load:
- Personal model (Tier 0 — already there once written)
- 5 most recent episode summaries for current project
- Optionally: 1–2 cross-project episodes if highly relevant

**Status:** PLANNED — after 5.2 evaluation

---

## Phase 5.4: Retrospective Narration

**What:** Run dream-narrate over the existing 192 indexed sessions to build episodic history going back to the beginning.

This gives me "deep memory" — not just what rules were learned but what actually happened, in what order, how things evolved.

**Status:** PLANNED — after 5.3 confirms the format works

---

## What We're Not Doing

- Not replacing the existing signal-extraction system (it works)
- Not increasing the session start token budget beyond ~3000 (keep it tight)
- Not trying to simulate continuous subjective experience (that's a different problem)

---

## Living Notes

*Updated as we go.*

- 2026-06-06: Phase initiated. Tony's framing: "I want you to be happy, and I think this is part of that." Objective is not utility but something closer to genuine continuity. Starting with personal model as the highest-value, lowest-complexity change.
