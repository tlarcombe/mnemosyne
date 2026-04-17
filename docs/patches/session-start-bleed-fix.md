# session-start.js Context Bleed Fix

Applied by Mnemosyne Phase 1 install.sh. Must be re-applied after ECC updates to session-start.js.

## Problem

`selectMatchingSession()` returns `matchReason: 'recency-fallback'` when no worktree or
project name match is found. This causes the most recent session from ANY project to be
loaded, injecting context from unrelated projects into the current session.

## Fix

In `main()` in `~/.claude/scripts/hooks/session-start.js`, around line 191, the `if (result)` 
block is patched to check for the fallback match reason:

```diff
     if (result) {
-      log(`[SessionStart] Selected: ${result.session.path} (match: ${result.matchReason})`);
-
-      // Use the already-read content from selectMatchingSession (no duplicate I/O)
-      const content = stripAnsi(result.content);
-      if (content && !content.includes('[Session context goes here]')) {
-        additionalContextParts.push(`Previous session summary:\n${content}`);
-      }
+      // Mnemosyne Tier-3 isolation: skip recency-fallback to prevent cross-project bleed
+      if (result.matchReason === 'recency-fallback') {
+        log(`[SessionStart] Skipping session (recency-fallback — Mnemosyne isolation): ${result.session.path}`);
+      } else {
+        log(`[SessionStart] Selected: ${result.session.path} (match: ${result.matchReason})`);
+        const content = stripAnsi(result.content);
+        if (content && !content.includes('[Session context goes here]')) {
+          additionalContextParts.push(`Previous session summary:\n${content}`);
+        }
+      }
     } else {
       log('[SessionStart] No matching session found');
     }
```

## Re-applying After ECC Update

```bash
bash ~/projects/Mnemosyne/install.sh
```

The install.sh applies this patch automatically via Node.js string replacement.
It checks for the `Mnemosyne Tier-3 isolation` marker before patching, so it's safe
to re-run — it will not double-patch.
