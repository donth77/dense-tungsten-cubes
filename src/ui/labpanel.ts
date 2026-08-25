import type { LabPanelHandle, LabPanelModel, PanelControl, PanelReading } from '../labs/lab.ts';
import { button, el, setClass, setText } from './dom.ts';
import { bindSlider } from './slider.ts';

/**
 * Renders a `LabPanelModel` (16 §11.5) — keyed DOM, built once, updated by
 * `textContent` swaps. Numeric values change instantly (13 §7: an animated number is
 * a number that is briefly wrong), and nothing is rebuilt per sample: `panelDelta`
 * names exactly what changed, and structural change — different controls, different
 * actions — is the only thing that rebuilds.
 *
 * `panelDelta` is pure and unit-tested (`tests/unit/labpanel.test.ts`); the DOM half
 * is deliberately thin enough to verify in smoke.
 */

export type PanelOp =
  | { kind: 'structure' }
  | { kind: 'status'; text: string; tone: LabPanelModel['status']['tone'] }
  | { kind: 'primary'; reading: PanelReading }
  | { kind: 'secondary'; index: number; reading: PanelReading }
  | { kind: 'fact'; index: number; k: string; v: string; v2: string }
  | { kind: 'control-value'; id: string; value: number | string | boolean }
  | { kind: 'control-reading'; id: string; text: string; sub: string }
  | { kind: 'action-state'; id: string; disabled: boolean; label: string }
  | { kind: 'announce'; text: string };

/** The structural identity of a model — when this changes, the DOM is rebuilt. */
function shape(m: LabPanelModel): string {
  return [
    m.id,
    m.title,
    m.primary ? 'P' : '-',
    (m.secondary ?? []).length,
    m.facts.length,
    m.controls.map((c) => `${c.kind}:${c.id}${sliderShape(c)}`).join(','),
    m.actions.map((a) => `${a.id}${a.primary ? '!' : ''}`).join(','),
  ].join('|');
}

function sliderShape(c: PanelControl): string {
  if (c.kind !== 'slider')
    return c.kind === 'segmented' ? `[${c.options.map((o) => o.id).join(' ')}]` : '';
  return `(${c.min}..${c.max}:${(c.ticks ?? []).join(' ')})`;
}

export function panelDelta(prev: LabPanelModel | null, next: LabPanelModel): PanelOp[] {
  if (!prev || shape(prev) !== shape(next)) {
    const ops: PanelOp[] = [{ kind: 'structure' }];
    if (next.announce && next.announce !== prev?.announce) {
      ops.push({ kind: 'announce', text: next.announce });
    }
    return ops;
  }
  const ops: PanelOp[] = [];
  if (prev.status.text !== next.status.text || prev.status.tone !== next.status.tone) {
    ops.push({ kind: 'status', text: next.status.text, tone: next.status.tone });
  }
  if (next.primary && readingDiffers(prev.primary, next.primary)) {
    ops.push({ kind: 'primary', reading: next.primary });
  }
  const prevSec = prev.secondary ?? [];
  (next.secondary ?? []).forEach((r, i) => {
    if (readingDiffers(prevSec[i], r)) ops.push({ kind: 'secondary', index: i, reading: r });
  });
  next.facts.forEach((f, i) => {
    const p = prev.facts[i];
    if (!p || p.k !== f.k || p.v !== f.v || (p.v2 ?? '') !== (f.v2 ?? '')) {
      ops.push({ kind: 'fact', index: i, k: f.k, v: f.v, v2: f.v2 ?? '' });
    }
  });
  for (const c of next.controls) {
    const p = prev.controls.find((x) => x.id === c.id);
    if (!p || p.kind !== c.kind) continue; // shape() guarantees this cannot happen
    const value = c.kind === 'toggle' ? c.value : c.value;
    const pv = p.kind === 'toggle' ? p.value : (p as { value: number | string }).value;
    if (pv !== value) ops.push({ kind: 'control-value', id: c.id, value });
    if (c.kind === 'slider') {
      const r = c.format(c.value);
      const pr = (p as typeof c).format((p as typeof c).value);
      if (pr.text !== r.text || (pr.sub ?? '') !== (r.sub ?? '')) {
        ops.push({ kind: 'control-reading', id: c.id, text: r.text, sub: r.sub ?? '' });
      }
    }
  }
  for (const a of next.actions) {
    const p = prev.actions.find((x) => x.id === a.id);
    if (!p) continue;
    if ((p.disabled ?? false) !== (a.disabled ?? false) || p.label !== a.label) {
      ops.push({ kind: 'action-state', id: a.id, disabled: a.disabled ?? false, label: a.label });
    }
  }
  if (next.announce && next.announce !== prev.announce) {
    ops.push({ kind: 'announce', text: next.announce });
  }
  return ops;
}

function readingDiffers(a: PanelReading | undefined, b: PanelReading): boolean {
  return (
    !a ||
    a.label !== b.label ||
    a.value !== b.value ||
    (a.sub ?? '') !== (b.sub ?? '') ||
    (a.provisional ?? false) !== (b.provisional ?? false)
  );
}

/** Announce throttle: one message per this window, and only when the text changes. */
const ANNOUNCE_MIN_GAP_MS = 500;

export class LabPanel {
  #model: LabPanelModel | null = null;
  #root: HTMLElement | null = null;
  #statusEl!: HTMLElement;
  #primaryVal!: HTMLElement;
  #primarySub!: HTMLElement;
  #secondaryEls: { val: HTMLElement; sub: HTMLElement }[] = [];
  #factEls: { k: HTMLElement; v: HTMLElement; v2: HTMLElement }[] = [];
  #controlEls = new Map<
    string,
    { input?: HTMLInputElement; reading?: HTMLElement; sub?: HTMLElement; group?: HTMLElement }
  >();
  #actionEls = new Map<string, HTMLButtonElement>();
  #live: HTMLElement;
  #lastAnnounce = '';
  #lastAnnounceAt = 0;

  constructor(private readonly host: HTMLElement) {
    this.#live = el('div.lp-live', { role: 'status', 'aria-live': 'polite' });
  }

  mount(model: LabPanelModel): LabPanelHandle {
    this.#build(model);
    return {
      update: (next) => this.#update(next),
      dispose: () => this.dispose(),
    };
  }

  dispose(): void {
    this.#model = null;
    this.#root = null;
    this.host.replaceChildren();
  }

  #update(next: LabPanelModel): void {
    const ops = panelDelta(this.#model, next);
    this.#model = next;
    for (const op of ops) this.#apply(op, next);
  }

  #apply(op: PanelOp, model: LabPanelModel): void {
    switch (op.kind) {
      case 'structure':
        this.#build(model);
        break;
      case 'status':
        setText(this.#statusEl, op.text);
        this.#statusEl.dataset['tone'] = op.tone;
        break;
      case 'primary':
        setText(this.#primaryVal, op.reading.value);
        setText(this.#primarySub, op.reading.sub ?? '');
        setClass(this.#primaryVal, 'provisional', op.reading.provisional ?? false);
        break;
      case 'secondary': {
        const s = this.#secondaryEls[op.index];
        if (s) {
          setText(s.val, op.reading.value);
          setText(s.sub, op.reading.sub ?? '');
        }
        break;
      }
      case 'fact': {
        const f = this.#factEls[op.index];
        if (f) {
          setText(f.k, op.k);
          setText(f.v, op.v);
          setText(f.v2, op.v2);
        }
        break;
      }
      case 'control-value': {
        const c = this.#controlEls.get(op.id);
        if (!c) break;
        if (c.input) c.input.value = String(op.value);
        if (c.group) {
          for (const b of Array.from(c.group.children)) {
            const on = (b as HTMLElement).dataset['optionId'] === String(op.value);
            b.setAttribute('aria-checked', String(on));
          }
        }
        break;
      }
      case 'control-reading': {
        const c = this.#controlEls.get(op.id);
        if (c?.reading) setText(c.reading, op.text);
        if (c?.sub) setText(c.sub, op.sub);
        break;
      }
      case 'action-state': {
        const b = this.#actionEls.get(op.id);
        if (b) {
          b.disabled = op.disabled;
          setText(b, op.label);
        }
        break;
      }
      case 'announce': {
        const now = performance.now();
        if (op.text !== this.#lastAnnounce && now - this.#lastAnnounceAt >= ANNOUNCE_MIN_GAP_MS) {
          this.#lastAnnounce = op.text;
          this.#lastAnnounceAt = now;
          setText(this.#live, op.text);
        }
        break;
      }
    }
  }

  #build(model: LabPanelModel): void {
    this.#model = model;
    this.#secondaryEls = [];
    this.#factEls = [];
    this.#controlEls.clear();
    this.#actionEls.clear();

    this.#statusEl = el('span.lp-status', { text: model.status.text });
    this.#statusEl.dataset['tone'] = model.status.tone;
    const head = el('div.lp-head', {}, el('span.k', { text: model.title }), this.#statusEl);

    const parts: HTMLElement[] = [head];

    this.#primaryVal = el('div.lp-primary', { text: model.primary?.value ?? '' });
    this.#primarySub = el('div.lp-primary-sub', { text: model.primary?.sub ?? '' });
    if (model.primary) {
      setClass(this.#primaryVal, 'provisional', model.primary.provisional ?? false);
      parts.push(this.#primaryVal, this.#primarySub);
    }

    if (model.secondary?.length) {
      const row = el('div.cells');
      for (const r of model.secondary) {
        const val = el('div.val', { text: r.value });
        const sub = el('div.val2', { text: r.sub ?? '' });
        this.#secondaryEls.push({ val, sub });
        row.append(el('div.cell', {}, el('div.k', { text: r.label }), val, sub));
      }
      parts.push(row);
    }

    if (model.facts.length) {
      const rows = el('div.lp-facts');
      for (const f of model.facts) {
        const k = el('span.k', { text: f.k });
        const v = el('span.lp-fact-v', { text: f.v });
        const v2 = el('span.lp-fact-v2', { text: f.v2 ?? '' });
        this.#factEls.push({ k, v, v2 });
        rows.append(el('div.lp-fact', {}, k, v, v2));
      }
      parts.push(rows);
    }

    for (const c of model.controls) parts.push(this.#buildControl(c));

    if (model.actions.length) {
      const row = el('div.lp-actions');
      for (const a of model.actions) {
        const b = button(
          a.label,
          () => {
            const live = this.#model?.actions.find((x) => x.id === a.id);
            if (live && !live.disabled) live.onSelect();
          },
          { class: a.primary ? 'primary lp-act' : 'chip action' },
        ) as HTMLButtonElement;
        b.disabled = a.disabled ?? false;
        this.#actionEls.set(a.id, b);
        row.append(b);
      }
      parts.push(row);
    }

    this.#root = el('div.labpanel-inner.lp', {}, ...parts, this.#live);
    this.host.replaceChildren(this.#root);
  }

  #buildControl(c: PanelControl): HTMLElement {
    if (c.kind === 'slider') {
      const input = el('input', {
        type: 'range',
        min: String(c.min),
        max: String(c.max),
        step: String(c.step ?? 1),
        value: String(c.value),
        'aria-label': c.label,
      }) as HTMLInputElement;
      const bubble = el('div.bubble');
      const ticks = el('div.ticks');
      for (const t of c.ticks ?? []) {
        ticks.append(
          el('i', { style: `left:${(((t - c.min) / (c.max - c.min || 1)) * 100).toFixed(2)}%` }),
        );
      }
      const wrap = el('div.slider', {}, input, ticks, bubble);
      const r0 = c.format(c.value);
      const reading = el('span.lp-fact-v', { text: r0.text });
      const sub = el('span.lp-fact-v2', { text: r0.sub ?? '' });
      this.#controlEls.set(c.id, { input, reading, sub });
      bindSlider(input, wrap, bubble, (raw, committed) => {
        const live = this.#model?.controls.find((x) => x.id === c.id);
        if (live?.kind === 'slider') {
          setText(bubble, live.format(raw).text);
          live.onChange(raw, committed);
        }
      });
      setText(bubble, r0.text);
      return el(
        'div.lp-control',
        {},
        el('div.lp-control-row', {}, el('span.k', { text: c.label }), reading, sub),
        wrap,
      );
    }
    if (c.kind === 'segmented') {
      const group = el('div.lp-seg', { role: 'radiogroup', 'aria-label': c.label });
      for (const opt of c.options) {
        const b = button(
          opt.label,
          () => {
            const live = this.#model?.controls.find((x) => x.id === c.id);
            if (live?.kind === 'segmented') live.onChange(opt.id);
          },
          { class: 'chip lp-seg-opt', role: 'radio' },
        );
        b.dataset['optionId'] = opt.id;
        b.setAttribute('aria-checked', String(opt.id === c.value));
        group.append(b);
      }
      this.#controlEls.set(c.id, { group });
      return el('div.lp-control', {}, el('span.k', { text: c.label }), group);
    }
    // toggle
    const b = button(
      c.label,
      () => {
        const live = this.#model?.controls.find((x) => x.id === c.id);
        if (live?.kind === 'toggle') live.onChange(!live.value);
      },
      { class: 'chip lp-toggle', role: 'switch' },
    );
    b.setAttribute('aria-checked', String(c.value));
    this.#controlEls.set(c.id, {
      group: (() => {
        const g = el('div.lp-toggle-wrap');
        g.append(b);
        return g;
      })(),
    });
    const holder = this.#controlEls.get(c.id)!.group!;
    // control-value updates flip aria-checked through the group path:
    holder.children[0]?.setAttribute('data-option-id', 'true');
    return el('div.lp-control', {}, holder);
  }
}
