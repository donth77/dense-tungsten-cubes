/**
 * The canonical control list — **one table, two readers**.
 *
 * `interaction/input.ts` dispatches from it and `ui/help.ts` renders it, so the help
 * screen physically cannot describe a shortcut that doesn't exist or miss one that
 * does. A help panel maintained by hand is wrong within a week.
 */

export type ActionId =
  | 'spawn'
  | 'deleteSelected'
  | 'resetLab'
  | 'resetView'
  | 'toggleUnits'
  | 'toggleSound'
  | 'toggleEngraving'
  | 'cycleGrip'
  | 'toggleHelp'
  | 'dismiss'
  | 'metal1'
  | 'metal2'
  | 'metal3'
  | 'metal4'
  | 'metal5'
  | 'metal6'
  | 'orbitLeft'
  | 'orbitRight'
  | 'orbitUp'
  | 'orbitDown'
  | 'panLeft'
  | 'panRight'
  | 'panUp'
  | 'panDown'
  | 'zoomIn'
  | 'zoomOut';

export interface KeyBinding {
  /** `KeyboardEvent.code` values that trigger this. */
  codes: readonly string[];
  /** How the key is written in the help panel. */
  label: string;
  action: ActionId;
  description: string;
  group: ControlGroup;
}

export type ControlGroup = 'Cubes' | 'Camera' | 'Display';

export const KEY_BINDINGS: readonly KeyBinding[] = [
  {
    codes: ['Space'],
    label: 'Space',
    action: 'spawn',
    description: 'Spawn a cube',
    group: 'Cubes',
  },
  {
    codes: ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6'],
    label: '1 – 6',
    action: 'metal1',
    description: 'Pick metal (W, Au, Cu, Fe, Ti, Al)',
    group: 'Cubes',
  },
  {
    // Backspace as well as Delete: laptop keyboards without a dedicated Delete key are
    // the common case, and on those Backspace *is* the delete key.
    codes: ['Delete', 'Backspace'],
    label: 'Del',
    action: 'deleteSelected',
    description: 'Remove the selected cube',
    group: 'Cubes',
  },
  {
    codes: ['KeyR'],
    label: 'R',
    action: 'resetLab',
    description: 'Clear the lab and start over',
    group: 'Cubes',
  },
  {
    codes: ['KeyG'],
    label: 'G',
    action: 'cycleGrip',
    description: 'Cycle grip strength',
    group: 'Cubes',
  },
  {
    codes: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'],
    label: '← ↑ ↓ →',
    action: 'orbitLeft',
    description: 'Orbit the camera',
    group: 'Camera',
  },
  {
    codes: [],
    label: 'Shift + arrows',
    action: 'panLeft',
    description: 'Pan across the stage',
    group: 'Camera',
  },
  {
    codes: ['Equal', 'Minus'],
    label: '+ / −',
    action: 'zoomIn',
    description: 'Zoom in and out',
    group: 'Camera',
  },
  {
    codes: ['KeyF'],
    label: 'F',
    action: 'resetView',
    description: 'Reset the camera',
    group: 'Camera',
  },
  {
    codes: ['KeyU'],
    label: 'U',
    action: 'toggleUnits',
    description: 'Switch units (kg / lb)',
    group: 'Display',
  },
  {
    codes: ['KeyM'],
    label: 'M',
    action: 'toggleSound',
    description: 'Mute / unmute',
    group: 'Display',
  },
  {
    codes: ['KeyE'],
    label: 'E',
    action: 'toggleEngraving',
    description: 'Engraved / plain face',
    group: 'Display',
  },
  {
    codes: ['Slash', 'KeyH'],
    label: '? or H',
    action: 'toggleHelp',
    description: 'Show these controls',
    group: 'Display',
  },
  {
    codes: ['Escape'],
    label: 'Esc',
    action: 'dismiss',
    description: 'Close this / deselect',
    group: 'Display',
  },
];

/** Pointer and touch gestures, for the help panel only — the router owns the behaviour. */
export interface GestureHelp {
  label: string;
  description: string;
  group: ControlGroup;
}

export const MOUSE_GESTURES: readonly GestureHelp[] = [
  { label: 'Drag a cube', description: 'Pick it up — if you are strong enough', group: 'Cubes' },
  { label: 'Click a cube', description: 'Show its details', group: 'Cubes' },
  { label: 'Drag empty space', description: 'Orbit the camera', group: 'Camera' },
  { label: 'Scroll', description: 'Zoom in and out', group: 'Camera' },
  { label: 'Shift-drag / middle-drag', description: 'Pan across the stage', group: 'Camera' },
  { label: 'Double-click empty', description: 'Reset the camera', group: 'Camera' },
  { label: 'Hold on the floor', description: 'Spawn a cube right there', group: 'Cubes' },
  {
    label: 'Scroll while holding',
    description: 'Push the cube away or pull it closer',
    group: 'Cubes',
  },
  { label: 'Fling off the edge', description: 'Throw a cube away to be rid of it', group: 'Cubes' },
];

export const TOUCH_GESTURES: readonly GestureHelp[] = [
  { label: 'Drag a cube', description: 'Pick it up — if you are strong enough', group: 'Cubes' },
  { label: 'Tap a cube', description: 'Show its details', group: 'Cubes' },
  { label: 'One finger on empty', description: 'Orbit the camera', group: 'Camera' },
  {
    label: 'Two fingers',
    description: 'Pinch to zoom, drag to orbit — at the same time',
    group: 'Camera',
  },
  { label: 'Three fingers', description: 'Pan across the stage', group: 'Camera' },
  { label: 'Double-tap empty', description: 'Reset the camera', group: 'Camera' },
  { label: 'Press and hold the floor', description: 'Spawn a cube right there', group: 'Cubes' },
  { label: 'Fling off the edge', description: 'Throw a cube away to be rid of it', group: 'Cubes' },
];

const ARROWS: Record<string, string> = {
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
};

export const CONTROL_GROUPS: readonly ControlGroup[] = ['Cubes', 'Camera', 'Display'];

/** Resolves a `KeyboardEvent.code` to an action, honouring the 1–5 metal row. */
export function actionForCode(code: string, shift = false): ActionId | null {
  if (/^Digit[1-6]$/.test(code)) return `metal${code.slice(-1)}` as ActionId;
  // Arrows orbit, or pan with Shift. Handled here so the help table and the router
  // can never disagree about which is which.
  const arrow = ARROWS[code];
  if (arrow) return (shift ? `pan${arrow}` : `orbit${arrow}`) as ActionId;
  if (code === 'Equal') return 'zoomIn';
  if (code === 'Minus') return 'zoomOut';
  for (const b of KEY_BINDINGS) {
    if (b.codes.includes(code)) return b.action;
  }
  return null;
}
