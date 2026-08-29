import { rootSlug } from '../sessions.js';

/**
 * The EXPECTED session name for `segments` under `root`.
 * The root's slug is DERIVED (a mkdtemp root is random per run, so it can
 * never be a literal). Every child segment is a LITERAL the test author
 * writes. So the join rule, the child slug rule and the segment count all
 * still go RED when the production rule changes - only the unavoidable
 * random prefix is computed. See the rootSlug anchor test in
 * sessions.test.js for the part this helper cannot pin.
 */
export function nameUnder(root, ...segments) {
  return [rootSlug(root), ...segments].join('/');
}
