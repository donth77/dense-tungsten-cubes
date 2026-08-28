import {
  CONTROL_GROUPS,
  KEY_BINDINGS,
  MOUSE_GESTURES,
  TOUCH_GESTURES,
} from '../interaction/bindings.ts';
import type { ControlGroup, GestureHelp } from '../interaction/bindings.ts';
import { button, clear, el } from './dom.ts';
import { icon } from './icons.ts';

/**
 * The Help sheet.
 *
 * "Help" is the sheet; Controls is the first topic in it (see #topics()) — the structure
 * is there so a second topic costs one array entry rather than a redesign.
 *
 * The Controls topic is rendered from the same binding table the input router dispatches
 * from, so it cannot describe a shortcut that doesn't exist (see interaction/bindings.ts).
 *
 * **Capability-detected, not device-sniffed.** A tablet with a keyboard, a laptop with a
 * touchscreen and a phone with a Bluetooth keyboard are all real and all common, so the
 * panel asks what the machine actually has rather than guessing from a user-agent:
 *
 *   - `any-pointer: fine`   -> a mouse or trackpad exists; show mouse gestures
 *   - `any-pointer: coarse` -> a touchscreen exists; show touch gestures
 *   - keyboard              -> cannot be queried at all, so it is *observed*: assumed
 *                              on a fine-pointer device, and revealed the moment a real
 *                              key is pressed anywhere else. That is what makes
 *                              phone-plus-keyboard work.
 *
 * Both pointer sections can show at once. That is correct, not a bug.
 */
export class HelpPanel {
  readonly root: HTMLElement;
  #open = false;
  #keyboardSeen: boolean;
  #lastFocused: Element | null = null;
  readonly #body: HTMLElement;
  readonly #closeBtn: HTMLElement;

  readonly #hasFine = window.matchMedia('(any-pointer: fine)').matches;
  readonly #hasCoarse = window.matchMedia('(any-pointer: coarse)').matches;

  constructor(private readonly onClose: () => void) {
    this.#keyboardSeen = this.#hasFine;
    this.#body = el('div.help-body');
    this.#closeBtn = button('', () => this.close(), {
      class: 'iconbtn',
      'aria-label': 'Close help',
      title: 'Close',
    });
    this.#closeBtn.appendChild(icon('close'));

    // The source link lives in the header, beside Close, rather than at the foot of the
    // sheet: the help body scrolls, and a colophon under it was only ever found by
    // someone who had already read to the end.
    const source = el('a.iconbtn.help-source', {
      href: 'https://github.com/donth77/dense-tungsten-cubes#dense',
      target: '_blank',
      // Without noopener the new tab gets a handle on this window.
      rel: 'noopener noreferrer',
      'aria-label': 'Source on GitHub',
      title: 'Source on GitHub',
    });
    source.appendChild(icon('github'));

    this.root = el(
      'div.help',
      {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'help-title',
        hidden: true,
      },
      el(
        'div.help-card',
        {},
        el(
          'div.help-head',
          {},
          el('h2.help-title', { id: 'help-title', text: 'Help' }),
          el('div.help-actions', {}, source, this.#closeBtn),
        ),
        this.#body,
      ),
    );
    // Clicking the scrim closes, but a click inside the card must not.
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.close();
    });
    this.#render();
  }

  get isOpen(): boolean {
    return this.#open;
  }

  /**
   * Called on any real keydown. A keyboard cannot be feature-detected, only witnessed —
   * this is what makes the keyboard section appear on a phone with a keyboard attached.
   */
  noteKeyboardUsed(): void {
    if (this.#keyboardSeen) return;
    this.#keyboardSeen = true;
    this.#render();
  }

  toggle(): void {
    if (this.#open) this.close();
    else this.open();
  }

  open(): void {
    if (this.#open) return;
    this.#open = true;
    this.#lastFocused = document.activeElement;
    this.root.hidden = false;
    this.#render();
    // Move focus into the dialog so a keyboard user is actually inside it.
    this.#closeBtn.focus();
    document.addEventListener('keydown', this.#onKeydown, true);
  }

  close(): void {
    if (!this.#open) return;
    this.#open = false;
    this.root.hidden = true;
    document.removeEventListener('keydown', this.#onKeydown, true);
    // Return focus where it came from, or it lands on <body> and the user is lost.
    if (this.#lastFocused instanceof HTMLElement) this.#lastFocused.focus();
    this.onClose();
  }

  /**
   * Esc closes, and Tab is trapped inside the dialog. Without the trap, tabbing walks
   * into the controls behind the scrim, which for a screen-reader user means the dialog
   * silently stopped being a dialog.
   */
  readonly #onKeydown = (e: KeyboardEvent): void => {
    if (!this.#open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = [
      ...this.root.querySelectorAll<HTMLElement>('button, [href], [tabindex]:not([tabindex="-1"])'),
    ].filter((n) => n.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  /**
   * The sheet is "Help", and Controls is one topic inside it — so a second topic is a
   * second entry here and nothing else has to move. Empty topics drop out rather than
   * rendering a bare heading.
   */
  #topics(): { title: string; content: HTMLElement[] }[] {
    return [{ title: 'Controls', content: this.#controlRows() }].filter(
      (t) => t.content.length > 0,
    );
  }

  #controlRows(): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (const group of CONTROL_GROUPS) {
      const rows: HTMLElement[] = [];

      if (this.#hasCoarse) {
        rows.push(...gestureRows(TOUCH_GESTURES, group, 'touch'));
      }
      if (this.#hasFine) {
        rows.push(...gestureRows(MOUSE_GESTURES, group, 'mouse'));
      }
      if (this.#keyboardSeen) {
        for (const b of KEY_BINDINGS) {
          if (b.group !== group) continue;
          rows.push(
            el(
              'div.help-row',
              {},
              el('kbd.help-key', { text: b.label }),
              el('span.help-desc', { text: b.description }),
            ),
          );
        }
      }

      if (rows.length === 0) continue;
      // h4, because the group now sits under the topic's h3 — a heading level skipped
      // is a heading level a screen-reader user has to guess at.
      out.push(el('section.help-group', {}, el('h4.k', { text: group }), ...rows));
    }

    if (this.#hasCoarse && this.#hasFine) {
      out.push(
        el('p.help-note', {
          text: 'This device reports both touch and a mouse, so both are listed.',
        }),
      );
    }
    return out;
  }

  #render(): void {
    clear(this.#body);
    for (const topic of this.#topics()) {
      this.#body.append(
        el(
          'section.help-topic',
          {},
          el('h3.help-topic-title', { text: topic.title }),
          ...topic.content,
        ),
      );
    }
  }
}

function gestureRows(
  gestures: readonly GestureHelp[],
  group: ControlGroup,
  kind: 'touch' | 'mouse',
): HTMLElement[] {
  return gestures
    .filter((g) => g.group === group)
    .map((g) =>
      el(
        'div.help-row',
        {},
        el(`span.help-gesture.${kind}`, { text: g.label }),
        el('span.help-desc', { text: g.description }),
      ),
    );
}
