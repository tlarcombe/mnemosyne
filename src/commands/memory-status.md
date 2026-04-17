---
name: memory-status
description: Show Mnemosyne memory tiers loaded in this session — files, token counts, and validity.
---

# /memory-status

Run these steps in order to report the current Mnemosyne memory state.

## Step 1 — Tier 0 (Permanent Global)

```bash
echo "=== Tier 0: Permanent Global ==="
echo "Dir: $HOME/.claude/memory/permanent/"
for f in "$HOME/.claude/memory/permanent/"*.md 2>/dev/null; do
  [ -f "$f" ] || { echo "  (empty)"; break; }
  chars=$(wc -c < "$f")
  tokens=$(( chars / 4 ))
  name=$(grep '^name:' "$f" | head -1 | sed 's/^name: //')
  echo "  $name (~${tokens} tokens) — $(basename "$f")"
done
```

## Step 2 — Tier 1 (Global Feedback)

```bash
echo ""
echo "=== Tier 1: Global Feedback (cap: 50) ==="
echo "Dir: $HOME/.claude/memory/feedback/"
found=0
for f in "$HOME/.claude/memory/feedback/"*.md 2>/dev/null; do
  [ -f "$f" ] || break
  valid=$(grep '^valid_until:' "$f" | head -1 | sed 's/^valid_until: //')
  name=$(grep '^name:' "$f" | head -1 | sed 's/^name: //')
  echo "  $name [valid_until: $valid] — $(basename "$f")"
  found=$((found+1))
done
[ $found -eq 0 ] && echo "  (empty)"
```

## Step 3 — Tier 2 (Project Memory)

```bash
echo ""
echo "=== Tier 2: Project Memory ==="
echo "Working directory: $(pwd)"
ENCODED=$(pwd | sed "s|$HOME|-home-$(whoami)|" | sed 's|[^a-zA-Z0-9]|-|g')
MEM_DIR="$HOME/.claude/projects/${ENCODED}/memory"
echo "Memory dir: $MEM_DIR"
found=0
for f in "$MEM_DIR/"*.md 2>/dev/null; do
  [ -f "$f" ] || break
  fname=$(basename "$f")
  [ "$fname" = "MEMORY.md" ] && continue
  name=$(grep '^name:' "$f" | head -1 | sed 's/^name: //')
  echo "  $name — $fname"
  found=$((found+1))
done
[ $found -eq 0 ] && echo "  (not found or empty)"
echo "Note: Tier 2 injected by Claude Code native auto-memory (not by Mnemosyne hook)"
```

## Step 4 — Tier 3 (Session Summaries)

```bash
echo ""
echo "=== Tier 3: Session Summaries ==="
SESSION_DIR="$HOME/.claude/session-data"
PROJ=$(basename "$(pwd)")
echo "Project: $PROJ | Worktree: $(pwd)"
found=0
for f in "$SESSION_DIR/"*-session.tmp; do
  [ -f "$f" ] || continue
  if grep -q "Worktree:.*$(pwd)\|Project:.*$PROJ" "$f" 2>/dev/null; then
    mtime=$(stat -c '%y' "$f" | cut -d' ' -f1)
    echo "  MATCH [$mtime]: $(basename "$f")"
    found=$((found+1))
    [ $found -ge 3 ] && break
  fi
done
[ $found -eq 0 ] && echo "  (no matching sessions — bleed guard active for unmatched sessions)"
echo "Note: recency-fallback disabled by Mnemosyne to prevent cross-project context bleed"
```

## Step 5 — Token Budget Summary

```bash
echo ""
echo "=== Token Budget ==="
T0=0; for f in "$HOME/.claude/memory/permanent/"*.md 2>/dev/null; do [ -f "$f" ] && T0=$((T0 + $(wc -c < "$f"))); done
T1=0; for f in "$HOME/.claude/memory/feedback/"*.md 2>/dev/null; do [ -f "$f" ] && T1=$((T1 + $(wc -c < "$f"))); done
T0_TOKENS=$(( T0 / 4 ))
T1_TOKENS=$(( T1 / 4 ))
TOTAL=$(( T0_TOKENS + T1_TOKENS ))
echo "  Tier 0 (permanent):  ~${T0_TOKENS} tokens"
echo "  Tier 1 (feedback):   ~${T1_TOKENS} tokens"
echo "  Mnemosyne hook total: ~${TOTAL} / 3000 tokens"
echo "  Remaining for Tier 2+3: ~$(( 3000 - TOTAL )) tokens"
```

Summarise findings as: `Mnemosyne active: Tier 0 (N files), Tier 1 (N files), ~X/3000 tokens. Context bleed: disabled. Project tier: [project-name].`
