import { hapticTick } from '../fx/haptics.ts';
import { setClass } from './dom.ts';

/**
 * Slider plumbing shared by the spawner and the lab panel (12 §4, 13 §5.4): live
 * updates while dragging, a snap on release, the value bubble, and the detent tick
 * through the one haptics seam. Extracted from `spawner.ts` in D1 so the Drop
 * Tower's height slider is the same slider, not a lookalike.
 */
export function bindSlider(
  input: HTMLInputElement,
  wrapper: HTMLElement,
  bubble: HTMLElement,
  onChange: (raw: number, committed: boolean) => void,
): void {
  let lastSnapped: number | null = null;

  const position = (): void => {
    const min = Number(input.min);
    const max = Number(input.max);
    const frac = (Number(input.value) - min) / (max - min || 1);
    bubble.style.left = `${10 + frac * (wrapper.clientWidth - 20)}px`;
  };

  input.addEventListener('input', () => {
    onChange(Number(input.value), false);
    position();
  });
  input.addEventListener('change', () => {
    onChange(Number(input.value), true);
    position();
    const now = Number(input.value);
    if (now !== lastSnapped) {
      lastSnapped = now;
      hapticTick();
    }
  });
  const start = (): void => {
    setClass(wrapper, 'dragging', true);
    position();
  };
  const end = (): void => setClass(wrapper, 'dragging', false);
  input.addEventListener('pointerdown', start);
  input.addEventListener('focus', start);
  input.addEventListener('pointerup', end);
  input.addEventListener('pointercancel', end);
  input.addEventListener('blur', end);
}
