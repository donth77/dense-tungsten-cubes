import { describe, expect, it } from 'vitest';
import { labFromPath, pathForLab } from '../../src/core/routes.ts';
import type { LabId } from '../../src/types.ts';

/** Tab routing (`/`, `/weigh`, `/drop`, `/tank`). */
describe('routes', () => {
  const LABS: readonly LabId[] = ['sandbox', 'weigh', 'drop', 'fluid'];

  it('round-trips every lab', () => {
    for (const lab of LABS) expect(labFromPath(pathForLab(lab))).toBe(lab);
  });

  it('the root is the Sandbox, and so is /sandbox', () => {
    expect(pathForLab('sandbox')).toBe('/');
    expect(labFromPath('/')).toBe('sandbox');
    expect(labFromPath('/sandbox')).toBe('sandbox');
  });

  it('the tank is /tank, not /fluid — the URL is the tab the player sees', () => {
    expect(pathForLab('fluid')).toBe('/tank');
    expect(labFromPath('/tank')).toBe('fluid');
    expect(labFromPath('/fluid')).toBeNull();
  });

  it('tolerates trailing slashes and case', () => {
    expect(labFromPath('/drop/')).toBe('drop');
    expect(labFromPath('/DROP')).toBe('drop');
  });

  /* An unknown path must not silently dump the player somewhere; the caller keeps state. */
  it('returns null for anything it does not recognise', () => {
    expect(labFromPath('/nope')).toBeNull();
    expect(labFromPath('/tank/extra')).toBeNull();
  });

  it('routes under a subdirectory base, which is how a static host deploys it', () => {
    expect(pathForLab('fluid', '/dense/')).toBe('/dense/tank');
    expect(labFromPath('/dense/tank', '/dense/')).toBe('fluid');
    expect(labFromPath('/dense/', '/dense/')).toBe('sandbox');
  });
});
