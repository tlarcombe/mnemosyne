---
name: memory-search
description: "Semantic search over Tier 4 JSONL archive. Finds past sessions matching a natural-language query. Requires /mnemosyne to have been run at least once to build the index."
tags: [memory, search, semantic, mnemosyne, tier4]
---

# /memory-search — Semantic Session History Search

Search your complete session history using natural language.

## Step 1 — Get the query

Extract the search query from the user's request. If not explicitly provided, ask:

> What are you looking for in your session history?

## Step 2 — Check the index exists

```bash
ls ~/.claude/lancedb/indexed.json 2>/dev/null && node -e "
const d = JSON.parse(require('fs').readFileSync(process.env.HOME + '/.claude/lancedb/indexed.json', 'utf8'));
const total = Object.values(d).reduce((s, v) => s + v.count, 0);
console.log('Index: ' + Object.keys(d).length + ' sessions, ' + total + ' messages');
" || echo "Index not found — run /mnemosyne first to build it"
```

If the index does not exist, stop and tell the user to run `/mnemosyne`.

## Step 3 — Run the search

Replace `QUERY` with the user's query (quote it):

```bash
node ~/.claude/skills/mnemosyne/search/memory-search.js "QUERY" --limit 5
```

To filter to a specific project:

```bash
node ~/.claude/skills/mnemosyne/search/memory-search.js "QUERY" --limit 5 --project ProjectName
```

## Step 4 — Present results

Report the results to the user. For each result, show:
- Project name and role (user/assistant)
- When the session was (relative time)
- The message excerpt

If results are weak, suggest a broader or different query. If fewer than 3 results, note that a larger index (run `/mnemosyne` to index more sessions) would improve recall.
