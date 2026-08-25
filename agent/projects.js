import fs from 'node:fs';
import path from 'node:path';

/**
 * Lists the direct child directories of baseDir - flat, no recursion, no
 * container-folder expansion. Never throws: any failure is logged to
 * stderr and results in an empty list (or that one entry being skipped).
 */
export function listProjects(baseDir) {
  let entries;
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch (err) {
    console.warn(`claude-remote agent: could not list '${baseDir}': ${err.code || err.message}`);
    return [];
  }

  const projects = [];
  for (const dirent of entries) {
    // ponytail: dirent.isDirectory() is false for symlinks/junctions, so
    // links are excluded for free - upgrade path if the owner ever
    // junctions a project in is to follow links deliberately here.
    if (!dirent.isDirectory() || dirent.name.startsWith('.')) {
      continue;
    }
    projects.push({ name: dirent.name, path: path.join(baseDir, dirent.name) });
  }

  projects.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  return projects;
}
