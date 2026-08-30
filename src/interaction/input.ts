import * as THREE from 'three';
import { config } from '../config.ts';
import type { EntityStore } from '../core/entities.ts';
import type { EventBus } from '../core/events.ts';
import type { PhysicsWorld } from '../core/physics.ts';
import type { CameraRig } from './camera.ts';
import type { TheHand } from './hand.ts';
import { actionForCode } from './bindings.ts';
import type { ActionId } from './bindings.ts';

/**
 * InputRouter — one capture-phase pointer pipeline on the canvas (08 §8.6).
 *
 * Mouse, touch and pen all arrive as Pointer Events, so there is one code path. This
 * module owns *interpretation only*; TheHand and CameraRig own behaviour.
 */

interface PointerState {
  id: number;
  type: string;
  x: number;
  y: number;
  startX: number;
  startY: number;
  startT: number;
  moved: number;
  /** True when this pointer is the one holding a cube. */
  grabbing: boolean;
  /** True when this drag is panning rather than orbiting (shift / middle button). */
  panning: boolean;
}

export interface InputCallbacks {
  /** Long-press on empty floor, or the spawn key. */
  onSpawnRequest(atWorld: THREE.Vector3 | null): void;
  /** First gesture of the session — the iOS AudioContext unlock (08 §8.7). */
  onFirstGesture(): void;
  onResetRequest(): void;
  /**
   * Long-press progress, 0..1, at a screen point — or null when it stops.
   * 450 ms of nothing feels like a dead app, and the ring also teaches that the
   * gesture exists at all (12 §4).
   */
  onLongPressProgress(progress: number, screen: { x: number; y: number } | null): void;
  /** Dispatched from the shared binding table (interaction/bindings.ts). */
  onAction(action: ActionId): void;
  /** A keyboard cannot be feature-detected, only witnessed — this is that witness. */
  onKeyboardUsed(): void;
}

export class InputRouter {
  readonly #pointers = new Map<number, PointerState>();
  readonly #raycaster = new THREE.Raycaster();
  readonly #ndc = new THREE.Vector2();
  readonly #hitPoint = new THREE.Vector3();
  #firstGestureDone = false;
  #longPressTimer: number | null = null;
  #longPressRaf: number | null = null;
  #lastTapT = 0;
  #lastTapX = 0;
  #lastTapY = 0;
  /** Two-pointer gesture baseline. */
  #pinchDist = 0;
  #midX = 0;
  #midY = 0;
  #twoPointerActive = false;
  #threePointerActive = false;
  #panMidX = 0;
  #panMidY = 0;

  /**
   * Cursor affordance (desktop only — `hover: hover` excludes touch, where a hover
   * raycast every frame is pure waste).
   *
   * Native `grab`/`grabbing` rather than custom SVG cursors, deliberately: native ones
   * inherit the OS pointer size and high-contrast settings, and a custom image cursor
   * ignores both — it stays 32 px for someone who has scaled their pointer up.
   *
   * The clamp state is NOT expressed here. A cursor is binary, The Hand is analog, and
   * a closed fist over a 6" tungsten cube would say "you've got it" while the cube
   * refuses to move — lying about the one thing the toy exists to teach. The force
   * meter owns that state (13 §5.3). `not-allowed` is wrong for the same reason: the
   * action isn't forbidden, you're just not strong enough.
   */
  readonly #canHover = window.matchMedia('(hover: hover)').matches;
  #hoverProbeQueued = false;
  #hoverX = 0;
  #hoverY = 0;
  #cursor = '';

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly rig: CameraRig,
    private readonly hand: TheHand,
    private readonly physics: PhysicsWorld,
    private readonly entities: EntityStore,
    private readonly bus: EventBus,
    private readonly cb: InputCallbacks,
  ) {
    const c = this.canvas;
    c.addEventListener('pointerdown', this.#onDown);
    c.addEventListener('pointermove', this.#onMove);
    c.addEventListener('pointerup', this.#onUp);
    // A cancelled pointer is a RELEASE, not a nothing: a notification shade otherwise
    // leaves a cube welded to a finger that no longer exists (12 §4).
    c.addEventListener('pointercancel', this.#onCancel);
    c.addEventListener('pointerleave', this.#onLeave);
    c.addEventListener('wheel', this.#onWheel, { passive: false });
    // Suppresses iOS's own ~500 ms long-press callout, which collides with our 450 ms
    // long-press spawn and would otherwise summon a text magnifier (12 §2).
    // Named, not an inline arrow: an anonymous listener cannot be removed, so this one
    // outlived every dispose() and leaked one per mount (14 ENG-03).
    c.addEventListener('contextmenu', this.#onContextMenu);
    window.addEventListener('keydown', this.#onKey);
  }

  dispose(): void {
    const c = this.canvas;
    c.removeEventListener('pointerdown', this.#onDown);
    c.removeEventListener('pointermove', this.#onMove);
    c.removeEventListener('pointerup', this.#onUp);
    c.removeEventListener('pointercancel', this.#onCancel);
    c.removeEventListener('pointerleave', this.#onLeave);
    c.removeEventListener('wheel', this.#onWheel);
    c.removeEventListener('contextmenu', this.#onContextMenu);
    window.removeEventListener('keydown', this.#onKey);
    this.#clearLongPress();
    this.#pointers.clear();
  }

  // ---- rays --------------------------------------------------------------------

  #setNdc(clientX: number, clientY: number, yOffsetPx = 0): void {
    const r = this.canvas.getBoundingClientRect();
    this.#ndc.x = ((clientX - r.left) / r.width) * 2 - 1;
    this.#ndc.y = -((clientY - yOffsetPx - r.top) / r.height) * 2 + 1;
  }

  /** Unoffset — you pick the cube you actually touched. */
  #pickRay(clientX: number, clientY: number): THREE.Ray {
    this.#setNdc(clientX, clientY);
    this.#raycaster.setFromCamera(this.#ndc, this.camera);
    return this.#raycaster.ray;
  }

  /**
   * Offset — on touch the held cube rides ~28 px above the fingertip, because your
   * finger covers the thing you are dragging. This is the single biggest difference
   * from a mouse (12 §4). Zero on desktop.
   */
  #aimRay(clientX: number, clientY: number, pointerType: string): THREE.Ray {
    const off = pointerType === 'touch' ? config.hand.touchGrabOffsetPx : 0;
    this.#setNdc(clientX, clientY, off);
    this.#raycaster.setFromCamera(this.#ndc, this.camera);
    return this.#raycaster.ray;
  }

  // ---- pointer lifecycle --------------------------------------------------------

  readonly #onDown = (e: PointerEvent): void => {
    if (!this.#firstGestureDone) {
      this.#firstGestureDone = true;
      this.cb.onFirstGesture();
    }
    this.canvas.setPointerCapture(e.pointerId);

    const st: PointerState = {
      id: e.pointerId,
      type: e.pointerType,
      x: e.clientX,
      y: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      startT: performance.now(),
      moved: 0,
      grabbing: false,
      panning: false,
    };
    this.#pointers.set(e.pointerId, st);

    if (this.#pointers.size === 2) {
      this.#beginTwoPointer();
      this.#clearLongPress();
      return;
    }
    if (this.#pointers.size === 3) {
      // Three fingers pan. Two are already spoken for — 12 §4 requires dolly AND orbit
      // simultaneously, never mode-locked — so this is the only free touch gesture.
      // Undiscoverable on its own, which is exactly what the help sheet is for.
      this.#beginThreePointer();
      this.#clearLongPress();
      return;
    }
    if (this.#pointers.size > 3) return;

    // First pointer: does the ray hit a cube?
    const ray = this.#pickRay(e.clientX, e.clientY);
    const hit = this.physics.raycast(ray.origin, ray.direction);
    const entity = hit ? this.entities.byBody(hit.handle) : undefined;

    // A winched (kinematic) cube cannot be grabbed — forces do nothing to it, so a
    // grab would be a lie the meter then repeats. Tap-select still works (pointerup).
    if (hit && entity && entity.kind === 'dynamic') {
      this.#hitPoint.set(hit.point.x, hit.point.y, hit.point.z);
      this.hand.grab(entity.id, this.#hitPoint, this.camera);
      // Re-aim immediately through the offset ray so a touched cube rises clear of
      // the fingertip instead of snapping there.
      this.hand.aim(this.#aimRay(e.clientX, e.clientY, e.pointerType));
      st.grabbing = true;
      this.#setCursor('grabbing');
    } else {
      // Shift-drag or the middle button pans instead of orbiting. Both are free on
      // desktop, and pan needs somewhere to live that doesn't fight the one-finger rule.
      st.panning = e.shiftKey || e.button === 1;
      // Empty space: this is an orbit (or pan), and a candidate long-press spawn.
      if (!st.panning) this.#armLongPress(e.clientX, e.clientY);
    }
  };

  readonly #onMove = (e: PointerEvent): void => {
    const st = this.#pointers.get(e.pointerId);
    if (!st) {
      // Not dragging: this is a hover, and the only thing it drives is the cursor.
      this.#queueHoverProbe(e.clientX, e.clientY);
      return;
    }
    const dx = e.clientX - st.x;
    const dy = e.clientY - st.y;
    st.x = e.clientX;
    st.y = e.clientY;
    st.moved += Math.hypot(dx, dy);

    const slop =
      st.type === 'touch' ? config.input.tapMaxMovePxTouch : config.input.tapMaxMovePxMouse;
    if (st.moved > slop) this.#clearLongPress();

    if (this.#pointers.size >= 3) {
      this.#updateThreePointer();
      return;
    }
    if (this.#pointers.size === 2) {
      this.#updateTwoPointer();
      return;
    }

    if (st.grabbing) {
      this.hand.aim(this.#aimRay(e.clientX, e.clientY, e.pointerType));
    } else if (st.panning) {
      this.rig.pan(dx, dy);
    } else {
      this.rig.orbit(dx, dy);
    }
  };

  readonly #onUp = (e: PointerEvent): void => {
    const st = this.#pointers.get(e.pointerId);
    this.#finishPointer(e.pointerId);
    if (!st) return;

    const dt = performance.now() - st.startT;
    const slop =
      st.type === 'touch' ? config.input.tapMaxMovePxTouch : config.input.tapMaxMovePxMouse;
    const wasTap = dt < config.input.tapMaxMs && st.moved < slop;

    if (st.grabbing) {
      this.hand.release();
      if (wasTap) {
        // A tap on a cube is a select, not a throw — the grab/release round trip
        // applied a negligible impulse and the info card is what was wanted.
        const ray = this.#pickRay(e.clientX, e.clientY);
        const hit = this.physics.raycast(ray.origin, ray.direction);
        const entity = hit ? this.entities.byBody(hit.handle) : undefined;
        // Selecting moves NOTHING (user, 2026-08-30). 08 §8.5's "gentle re-target onto
        // it" was here, and it never earned its keep: you can only tap a cube you can
        // already see, so the re-target buys no visibility and just slides the stage —
        // the instrument you were reading — off centre under your finger.
        if (entity) this.bus.emit('select', { id: entity.id });
      }
      this.#queueHoverProbe(e.clientX, e.clientY);
      return;
    }

    if (wasTap) this.#handleEmptyTap(e);
  };

  readonly #onCancel = (e: PointerEvent): void => {
    const st = this.#pointers.get(e.pointerId);
    this.#finishPointer(e.pointerId);
    // Zero throw velocity by intent: the cube drops where it was rather than being flung
    // by whatever the last pointer delta happened to be. `'cancel'` is what makes that
    // true — this used to call the same release a deliberate throw uses (14 ENG-02).
    if (st?.grabbing) this.hand.release('cancel');
    this.#setCursor('');
  };

  readonly #onContextMenu = (e: Event): void => e.preventDefault();

  /** Leaving the canvas must not strand a `grab` cursor over the rest of the page. */
  readonly #onLeave = (): void => {
    if (this.#pointers.size === 0) this.#setCursor('');
  };

  #finishPointer(id: number): void {
    this.#pointers.delete(id);
    this.#clearLongPress();
    if (this.#pointers.size < 2) this.#twoPointerActive = false;
    if (this.#pointers.size < 3) this.#threePointerActive = false;
    try {
      this.canvas.releasePointerCapture(id);
    } catch {
      /* already released */
    }
  }

  #handleEmptyTap(e: PointerEvent): void {
    const now = performance.now();
    const near = Math.hypot(e.clientX - this.#lastTapX, e.clientY - this.#lastTapY) < 32;
    if (now - this.#lastTapT < config.input.doubleTapMaxMs && near) {
      this.rig.reset();
      this.#lastTapT = 0;
      return;
    }
    this.#lastTapT = now;
    this.#lastTapX = e.clientX;
    this.#lastTapY = e.clientY;
    this.bus.emit('select', { id: null });
  }

  // ---- two-pointer: dolly AND orbit, never mode-locked ---------------------------

  #beginThreePointer(): void {
    const pts = [...this.#pointers.values()];
    this.#panMidX = pts.reduce((a, p) => a + p.x, 0) / pts.length;
    this.#panMidY = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    this.#threePointerActive = true;
    this.#twoPointerActive = false;
  }

  #updateThreePointer(): void {
    if (!this.#threePointerActive) return;
    const pts = [...this.#pointers.values()];
    if (pts.length < 3) return;
    const mx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
    const my = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    const dx = mx - this.#panMidX;
    const dy = my - this.#panMidY;
    if (Math.hypot(dx, dy) > config.input.twoPointerDeadzonePx) {
      this.rig.pan(dx, dy);
      this.#panMidX = mx;
      this.#panMidY = my;
    }
  }

  #beginTwoPointer(): void {
    const [a, b] = [...this.#pointers.values()];
    if (!a || !b) return;
    this.#pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    this.#midX = (a.x + b.x) / 2;
    this.#midY = (a.y + b.y) / 2;
    this.#twoPointerActive = true;
  }

  /**
   * Each frame: Δ(distance) -> dolly and Δ(midpoint) -> orbit, simultaneously, each
   * past its own ~8 px deadzone. Exclusive pinch-or-orbit modes feel broken because
   * human fingers always do a bit of both (12 §4).
   */
  #updateTwoPointer(): void {
    if (!this.#twoPointerActive) return;
    const [a, b] = [...this.#pointers.values()];
    if (!a || !b) return;

    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const dDist = dist - this.#pinchDist;
    const dMidX = midX - this.#midX;
    const dMidY = midY - this.#midY;
    const dead = config.input.twoPointerDeadzonePx;

    if (Math.abs(dDist) > dead) {
      this.rig.dolly(-dDist * 2);
      this.#pinchDist = dist;
    }
    if (Math.hypot(dMidX, dMidY) > dead) {
      if (this.hand.isHolding) {
        // Second pointer while grabbing: vertical component moves the grab plane's depth.
        this.hand.moveDepth(dMidY * 0.004, this.camera);
      } else {
        this.rig.orbit(dMidX, dMidY);
      }
      this.#midX = midX;
      this.#midY = midY;
    }
  }

  // ---- wheel & keys -------------------------------------------------------------

  readonly #onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    if (this.hand.isHolding) this.hand.moveDepth(-e.deltaY * 0.0015, this.camera);
    else this.rig.dolly(e.deltaY);
  };

  readonly #onKey = (e: KeyboardEvent): void => {
    // Never steal a key from a control that is meant to receive it — a range input uses
    // arrows and Home/End, and a text field uses everything.
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
    /*
     * Composite widgets own their arrows too. A tablist and a radiogroup navigate with
     * Left/Right (WAI-ARIA), and the camera also orbits on arrows — so without this the
     * two fire together and moving between tabs spins the scene behind them.
     */
    if (t instanceof HTMLElement && t.closest('[role="tablist"], [role="radiogroup"]')) return;
    // Modifier combinations belong to the browser (Cmd-R, Ctrl-F …).
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    this.cb.onKeyboardUsed();

    const action = actionForCode(e.code, e.shiftKey);
    if (!action) return;
    // Space scrolls and '/' opens quick-find if we don't claim them.
    e.preventDefault();
    this.cb.onAction(action);
  };

  // ---- long press ---------------------------------------------------------------

  #armLongPress(clientX: number, clientY: number): void {
    this.#clearLongPress();
    const started = performance.now();
    // Drive the fill ring off rAF rather than the timer, so it tracks real elapsed time
    // even if a frame is late.
    const tick = (): void => {
      if (this.#longPressTimer === null) return;
      const p = Math.min(1, (performance.now() - started) / config.input.longPressMs);
      this.cb.onLongPressProgress(p, { x: clientX, y: clientY });
      if (p < 1) this.#longPressRaf = requestAnimationFrame(tick);
    };
    this.#longPressRaf = requestAnimationFrame(tick);

    this.#longPressTimer = window.setTimeout(() => {
      this.#longPressTimer = null;
      this.cb.onLongPressProgress(0, null);
      // Spawn where they pressed: intersect the floor plane rather than guessing.
      const ray = this.#pickRay(clientX, clientY);
      const hit = this.physics.raycast(ray.origin, ray.direction);
      this.cb.onSpawnRequest(
        hit ? this.#hitPoint.set(hit.point.x, hit.point.y + 0.15, hit.point.z).clone() : null,
      );
    }, config.input.longPressMs);
  }

  #clearLongPress(): void {
    if (this.#longPressTimer !== null) {
      clearTimeout(this.#longPressTimer);
      this.#longPressTimer = null;
      this.cb.onLongPressProgress(0, null);
    }
    if (this.#longPressRaf !== null) {
      cancelAnimationFrame(this.#longPressRaf);
      this.#longPressRaf = null;
    }
  }

  // ---- cursor -------------------------------------------------------------------

  #setCursor(v: string): void {
    if (this.#cursor === v) return;
    this.#cursor = v;
    this.canvas.style.cursor = v;
  }

  /**
   * Coalesced to one raycast per frame. `pointermove` can fire far faster than the
   * display refreshes on a high-polling-rate mouse, and casting a ray per event would
   * spend more on the cursor than on the simulation.
   */
  #queueHoverProbe(clientX: number, clientY: number): void {
    if (!this.#canHover) return;
    this.#hoverX = clientX;
    this.#hoverY = clientY;
    if (this.#hoverProbeQueued) return;
    this.#hoverProbeQueued = true;
    requestAnimationFrame(() => {
      this.#hoverProbeQueued = false;
      this.#probeHover();
    });
  }

  #probeHover(): void {
    if (!this.#canHover) return;
    if (this.#pointers.size > 0) return; // mid-drag; the drag owns the cursor
    const ray = this.#pickRay(this.#hoverX, this.#hoverY);
    const hit = this.physics.raycast(ray.origin, ray.direction);
    const over = hit ? this.entities.byBody(hit.handle) : undefined;
    this.#setCursor(over ? 'grab' : '');
  }
}
