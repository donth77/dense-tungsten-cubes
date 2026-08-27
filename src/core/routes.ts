import type { LabId } from '../types.ts';

/**
 * Tab routing (`/`, `/weigh`, `/drop`, `/tank`) — pure path <-> lab mapping.
 *
 * Pure so it can be tested without a document: `app.ts` owns the History calls, this
 * file owns what a path MEANS. Sandbox is both `/sandbox` and the root, because the
 * root has to land somewhere and the Sandbox is where boot has always gone (08 §11).
 *
 * Paths are resolved against `import.meta.env.BASE_URL` so the app still routes when it
 * is served from a subdirectory, which is how a static host usually deploys it.
 */

const SLUGS: Readonly<Record<LabId, string>> = {
  sandbox: 'sandbox',
  weigh: 'weigh',
  drop: 'drop',
  fluid: 'tank',
};

/** The lab a pathname selects, or null if it names nothing — callers keep their state. */
export function labFromPath(pathname: string, base = '/'): LabId | null {
  const b = base.endsWith('/') ? base : `${base}/`;
  const rest = pathname.startsWith(b) ? pathname.slice(b.length) : pathname.replace(/^\//, '');
  const slug = rest.replace(/\/+$/, '').toLowerCase();
  if (slug === '') return 'sandbox';
  for (const id of Object.keys(SLUGS) as LabId[]) if (SLUGS[id] === slug) return id;
  return null;
}

/**
 * The path for a lab. Sandbox gets the ROOT rather than `/sandbox`: it is the default,
 * and a shared link to the front door should look like the front door.
 */
export function pathForLab(lab: LabId, base = '/'): string {
  const b = base.endsWith('/') ? base : `${base}/`;
  return lab === 'sandbox' ? b : `${b}${SLUGS[lab]}`;
}
