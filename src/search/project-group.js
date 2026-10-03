'use strict';

/**
 * project-group.js
 *
 * Maps a session's working directory to the project it belongs to, so the
 * viz groups sub-folders under their parent project instead of showing each
 * folder basename as an unrelated node ('Website' → 'StackMarket').
 *
 * Rules, for paths under PROJECTS_ROOT (default ~/projects):
 *   - Walk down from the root. A directory with no project marker (.git or
 *     CLAUDE.md) is a container (e.g. 'personal/', 'Claude_Enhancements/'),
 *     so keep descending.
 *   - The first directory that has a marker, no longer exists, or is the
 *     last segment is the project. Anything below it is the sub-project.
 * Paths outside the root fall back to the stored project name.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_ROOT = process.env.MNEMOSYNE_PROJECTS_ROOT || path.join(os.homedir(), 'projects');
const MARKERS = ['.git', 'CLAUDE.md'];

const containerCache = new Map();

function isContainer(dir) {
  if (containerCache.has(dir)) return containerCache.get(dir);
  let result = false;
  try {
    result = fs.statSync(dir).isDirectory() &&
      !MARKERS.some(m => fs.existsSync(path.join(dir, m)));
  } catch {
    result = false; // moved or deleted: treat as a project, not a container
  }
  containerCache.set(dir, result);
  return result;
}

/**
 * @param {string} projectPath  original cwd of the session ('' if unknown)
 * @param {string} fallbackName stored project name, used outside PROJECTS_ROOT
 * @returns {{group: string, sub: string}}
 */
function projectGroup(projectPath, fallbackName = '') {
  const rel = projectPath ? path.relative(PROJECTS_ROOT, projectPath) : '';
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { group: fallbackName || path.basename(projectPath || '') || 'unknown', sub: '' };
  }
  const segs = rel.split(path.sep);
  let i = 0;
  while (i < segs.length - 1 && isContainer(path.join(PROJECTS_ROOT, ...segs.slice(0, i + 1)))) i++;
  return { group: segs[i], sub: segs.slice(i + 1).join('/') };
}

module.exports = { projectGroup, PROJECTS_ROOT };
