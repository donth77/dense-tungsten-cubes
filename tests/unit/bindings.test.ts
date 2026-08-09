import { describe, expect, it } from 'vitest';
import {
  actionForCode,
  CONTROL_GROUPS,
  KEY_BINDINGS,
  MOUSE_GESTURES,
  TOUCH_GESTURES,
} from '../../src/interaction/bindings.ts';

/**
 * bindings.ts is "one table, two readers" — the input router dispatches from it and the
 * help sheet renders it. These tests defend that invariant, because the failure mode is
 * silent: a help panel confidently describing a shortcut that does nothing.
 */
describe('actionForCode', () => {
  it('maps both Delete and Backspace to deleteSelected', () => {
    // Laptop keyboards without a dedicated Delete key are the common case, and there
    // Backspace IS the delete key. Losing one of these strands a whole class of machine.
    expect(actionForCode('Delete')).toBe('deleteSelected');
    expect(actionForCode('Backspace')).toBe('deleteSelected');
  });

  it('resolves the metal row and the arrow row positionally', () => {
    expect(actionForCode('Digit1')).toBe('metal1');
    expect(actionForCode('Digit6')).toBe('metal6');
    expect(actionForCode('Digit7')).toBeNull();
    expect(actionForCode('ArrowLeft')).toBe('orbitLeft');
    expect(actionForCode('ArrowLeft', true)).toBe('panLeft');
    expect(actionForCode('ArrowDown', true)).toBe('panDown');
  });

  it('returns null for anything unbound', () => {
    expect(actionForCode('KeyZ')).toBeNull();
    expect(actionForCode('F7')).toBeNull();
  });

  it('dispatches every code the help sheet advertises', () => {
    for (const b of KEY_BINDINGS) {
      for (const code of b.codes) {
        expect(actionForCode(code), `${b.label} (${code}) is documented but dead`).not.toBeNull();
      }
    }
  });

  it('agrees with the declared action wherever a binding owns a single key', () => {
    // Row bindings (1–5, the arrows) declare one representative action and resolve
    // positionally, so they are exempt — everything else must match exactly.
    for (const b of KEY_BINDINGS) {
      if (b.codes.length !== 1) continue;
      expect(actionForCode(b.codes[0]!), `${b.label} dispatches the wrong action`).toBe(b.action);
    }
  });
});

describe('the help tables', () => {
  it('only uses groups the help sheet actually renders', () => {
    // A gesture in an unlisted group renders nowhere at all — it just vanishes.
    for (const g of [...MOUSE_GESTURES, ...TOUCH_GESTURES]) {
      expect(CONTROL_GROUPS, `"${g.label}" is in an unrendered group`).toContain(g.group);
    }
    for (const b of KEY_BINDINGS) {
      expect(CONTROL_GROUPS, `"${b.label}" is in an unrendered group`).toContain(b.group);
    }
  });

  it('documents fling-to-discard on both pointer types', () => {
    // The discard gesture has no UI affordance, so the help sheet is the only place it
    // is ever taught. If this drops out, the mechanic is undiscoverable.
    expect(MOUSE_GESTURES.some((g) => /fling/i.test(g.label))).toBe(true);
    expect(TOUCH_GESTURES.some((g) => /fling/i.test(g.label))).toBe(true);
  });
});
