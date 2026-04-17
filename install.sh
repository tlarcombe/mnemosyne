#!/usr/bin/env bash
# Mnemosyne Phase 1 installer — idempotent, safe to re-run after ECC updates.
# Usage: bash ~/projects/Mnemosyne/install.sh

set -euo pipefail

MNEMOSYNE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
HOOKS_DIR="$CLAUDE_DIR/scripts/hooks"
COMMANDS_DIR="$CLAUDE_DIR/commands"
MEMORY_DIR="$CLAUDE_DIR/memory"
SETTINGS="$CLAUDE_DIR/settings.json"

echo "=== Mnemosyne Phase 1 Installer ==="
echo "Source: $MNEMOSYNE_DIR"
echo "Target: $CLAUDE_DIR"
echo ""

# Step 1: Global tier directories
echo "[1/6] Creating global memory tier directories..."
mkdir -p "$MEMORY_DIR/permanent"
mkdir -p "$MEMORY_DIR/feedback"
echo "  ~/.claude/memory/permanent/ — OK"
echo "  ~/.claude/memory/feedback/  — OK"

# Step 2: Seed files (skip if already customised by the user)
echo "[2/6] Deploying Tier 0 seed files..."
for seed in "$MNEMOSYNE_DIR/seeds/permanent/"*.md; do
  target="$MEMORY_DIR/permanent/$(basename "$seed")"
  if [[ ! -f "$target" ]]; then
    cp "$seed" "$target"
    echo "  Deployed: $(basename "$seed")"
  else
    echo "  Skipped (exists): $(basename "$seed")"
  fi
done

# Step 3: Mnemosyne SessionStart hook
echo "[3/6] Deploying mnemosyne-session-start.js..."
cp "$MNEMOSYNE_DIR/src/hooks/mnemosyne-session-start.js" "$HOOKS_DIR/"
echo "  ~/.claude/scripts/hooks/mnemosyne-session-start.js — OK"

# Step 4: /memory-status command
echo "[4/6] Deploying memory-status command..."
cp "$MNEMOSYNE_DIR/src/commands/memory-status.md" "$COMMANDS_DIR/"
echo "  ~/.claude/commands/memory-status.md — OK"

# Step 5: Wire SessionStart hook in settings.json
echo "[5/6] Wiring Mnemosyne SessionStart hook..."
node -e "
const fs = require('fs');
const p = process.env.HOME + '/.claude/settings.json';
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
const hookCmd = 'node \"' + process.env.HOME + '/.claude/scripts/hooks/mnemosyne-session-start.js\"';
const hook = {
  matcher: '*',
  hooks: [{ type: 'command', command: hookCmd }],
  description: 'Mnemosyne: inject Tier 0 (permanent) and Tier 1 (feedback) global memories',
  id: 'mnemosyne:session:tiers'
};
const existing = s.hooks.SessionStart || [];
const idx = existing.findIndex(h => h.id === 'mnemosyne:session:tiers');
if (idx >= 0) {
  existing[idx] = hook;
  s.hooks.SessionStart = existing;
  console.log('  Updated existing mnemosyne:session:tiers hook');
} else {
  s.hooks.SessionStart = [hook, ...existing];
  console.log('  Wired: mnemosyne:session:tiers added as first SessionStart hook');
}
fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
"

# Step 6: Patch session-start.js to eliminate context bleed
echo "[6/6] Applying context bleed fix to session-start.js..."
SESSION_START="$HOOKS_DIR/session-start.js"
if grep -q 'Mnemosyne Tier-3 isolation' "$SESSION_START" 2>/dev/null; then
  echo "  Already patched — skipping"
else
  # Back up original
  cp "$SESSION_START" "${SESSION_START}.pre-mnemosyne" 2>/dev/null || true

  node << 'PATCH_EOF'
const fs = require('fs');
const p = process.env.HOME + '/.claude/scripts/hooks/session-start.js';
let content = fs.readFileSync(p, 'utf8');

// Target: the block inside `if (result) {` that loads session content
// We find it by matching the log line + content injection pattern
const OLD_MARKER = "log(`[SessionStart] Selected: ${result.session.path} (match: ${result.matchReason})`)";

if (!content.includes(OLD_MARKER)) {
  process.stderr.write('  WARNING: patch target not found — session-start.js may have been updated\n');
  process.stderr.write('  Manual patch required. See: docs/patches/session-start-bleed-fix.md\n');
  process.exit(0);
}

// Replace the block that starts after `if (result) {`
// We replace the log line + surrounding content-loading block
const OLD_BLOCK = `      log(\`[SessionStart] Selected: \${result.session.path} (match: \${result.matchReason})\`);

      // Use the already-read content from selectMatchingSession (no duplicate I/O)
      const content = stripAnsi(result.content);
      if (content && !content.includes('[Session context goes here]')) {
        additionalContextParts.push(\`Previous session summary:\\n\${content}\`);
      }`;

const NEW_BLOCK = `      // Mnemosyne Tier-3 isolation: skip recency-fallback to prevent cross-project bleed
      if (result.matchReason === 'recency-fallback') {
        log(\`[SessionStart] Skipping session (recency-fallback — Mnemosyne isolation): \${result.session.path}\`);
      } else {
        log(\`[SessionStart] Selected: \${result.session.path} (match: \${result.matchReason})\`);
        const content = stripAnsi(result.content);
        if (content && !content.includes('[Session context goes here]')) {
          additionalContextParts.push(\`Previous session summary:\\n\${content}\`);
        }
      }`;

if (content.includes(OLD_BLOCK)) {
  fs.writeFileSync(p, content.replace(OLD_BLOCK, NEW_BLOCK));
  console.log('  Patched: recency-fallback guard added to session-start.js');
} else {
  process.stderr.write('  WARNING: could not match exact block — falling back to marker-based patch\n');
  // Fallback: just add a check right before the log line
  const FALLBACK_OLD = `    if (result) {\n      log(\`[SessionStart] Selected:`;
  const FALLBACK_NEW = `    if (result) {\n      // Mnemosyne Tier-3 isolation\n      if (result.matchReason === 'recency-fallback') {\n        log(\`[SessionStart] Skipping session (recency-fallback — Mnemosyne isolation): \${result.session.path}\`);\n      } else {\n      log(\`[SessionStart] Selected:`;
  if (content.includes(FALLBACK_OLD)) {
    // This would be incomplete — warn and skip
    process.stderr.write('  WARNING: partial match found but fallback patch would be incomplete\n');
    process.stderr.write('  Manual patch required. See: docs/patches/session-start-bleed-fix.md\n');
  } else {
    process.stderr.write('  Manual patch required. See: docs/patches/session-start-bleed-fix.md\n');
  }
}
PATCH_EOF
fi

# Step 7: Deploy /mnemosyne dream skill
echo "[7/8] Deploying /mnemosyne dream skill..."
mkdir -p "$HOME/.claude/skills/mnemosyne"
cp "$MNEMOSYNE_DIR/src/dream/SKILL.md" "$HOME/.claude/skills/mnemosyne/"
cp "$MNEMOSYNE_DIR/src/dream/dream-gather.js" "$HOME/.claude/skills/mnemosyne/"
cp "$MNEMOSYNE_DIR/src/dream/dream-evict.js" "$HOME/.claude/skills/mnemosyne/"
echo "  ~/.claude/skills/mnemosyne/ — OK (SKILL.md, dream-gather.js, dream-evict.js)"

# Step 8: Deploy mnemosyne-stop.js and wire as async Stop hook
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

echo ""
echo "=== Installation complete ==="
echo ""
echo "Post-install steps:"
echo "  1. Run schema migration (first time only):"
echo "     node $MNEMOSYNE_DIR/scripts/migrate-memories.js"
echo ""
echo "  2. Restart Claude Code to activate the new SessionStart hook"
echo ""
echo "  3. Verify in any session:"
echo "     /memory-status"
echo "     /mnemosyne    (run dream consolidation)"
