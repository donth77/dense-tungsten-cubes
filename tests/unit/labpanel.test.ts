import { describe, expect, it } from 'vitest';
import { panelDelta } from '../../src/ui/labpanel.ts';
import type { LabPanelModel } from '../../src/labs/lab.ts';

const noop = (): void => undefined;

function model(over: Partial<LabPanelModel> = {}): LabPanelModel {
  return {
    id: 'drop',
    title: 'DROP TOWER',
    status: { text: 'ARMED', tone: 'neutral' },
    primary: { label: 'Energy', value: '46.2 J', sub: '34.1 ft·lb' },
    facts: [{ k: 'IMPACT', v: '6.26 m/s', v2: '14.0 mph' }],
    controls: [
      {
        kind: 'slider',
        id: 'height',
        label: 'HEIGHT',
        min: 0,
        max: 1000,
        value: 500,
        format: (v) => ({ text: `${v}` }),
        onChange: noop,
      },
    ],
    actions: [{ id: 'drop', label: 'DROP', primary: true, onSelect: noop }],
    ...over,
  };
}

describe('panelDelta (16 §11.5) — the DOM only hears what changed', () => {
  it('a first model is a structure build', () => {
    expect(panelDelta(null, model()).map((o) => o.kind)).toEqual(['structure']);
  });

  it('an identical model produces NO ops at all', () => {
    expect(panelDelta(model(), model())).toEqual([]);
  });

  it('a value change is one targeted op, never a rebuild', () => {
    const ops = panelDelta(model(), model({ status: { text: 'FALLING', tone: 'neutral' } }));
    expect(ops).toEqual([{ kind: 'status', text: 'FALLING', tone: 'neutral' }]);
  });

  it('primary readings swap by text, provisional included', () => {
    const ops = panelDelta(
      model(),
      model({
        primary: { label: 'Energy', value: '46.2 J', sub: '34.1 ft·lb', provisional: true },
      }),
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe('primary');
  });

  it('slider position and its reading update by id', () => {
    const next = model();
    (next.controls[0] as { value: number }).value = 750;
    const ops = panelDelta(model(), next);
    expect(ops.map((o) => o.kind).sort()).toEqual(['control-reading', 'control-value']);
  });

  it('a different control set is structural', () => {
    const next = model({
      controls: [{ kind: 'toggle', id: 'air', label: 'AIR', value: true, onChange: noop }],
    });
    expect(panelDelta(model(), next).map((o) => o.kind)).toContain('structure');
  });

  it('disabling an action is targeted; adding one is structural', () => {
    const disabled = model();
    (disabled.actions[0] as { disabled?: boolean }).disabled = true;
    expect(panelDelta(model(), disabled)).toEqual([
      { kind: 'action-state', id: 'drop', disabled: true, label: 'DROP' },
    ]);
    const added = model({
      actions: [...model().actions, { id: 'share', label: 'SHARE', onSelect: noop }],
    });
    expect(panelDelta(model(), added).map((o) => o.kind)).toContain('structure');
  });

  it('announce fires only when the text changes', () => {
    expect(panelDelta(model({ announce: 'Armed' }), model({ announce: 'Armed' }))).toEqual([]);
    expect(panelDelta(model({ announce: 'Armed' }), model({ announce: 'Dropped' }))).toEqual([
      { kind: 'announce', text: 'Dropped' },
    ]);
  });
});
