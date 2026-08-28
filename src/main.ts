import './ui/tokens.css';
import { App } from './app.ts';
import { PhysicsWorld } from './core/physics.ts';

/**
 * Boot only (08 §4): feature-detect, await the wasm, construct the App, start the loop.
 * Everything else belongs in app.ts.
 */

function show(id: string): void {
  const el = document.getElementById(id);
  if (el) el.style.display = 'grid';
  document.getElementById('boot')?.remove();
}

function hasWebGL2(): boolean {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

async function boot(): Promise<void> {
  // Fail early and legibly rather than throwing into a blank canvas (08 §16.3).
  if (!hasWebGL2()) {
    show('fail-webgl');
    return;
  }

  const canvas = document.getElementById('stage');
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('missing #stage canvas');

  let physics: PhysicsWorld;
  try {
    physics = await PhysicsWorld.create();
  } catch (err) {
    console.error('[boot] physics failed to load', err);
    show('fail-physics');
    return;
  }

  const app = new App(canvas, physics);
  await app.start();
  document.getElementById('boot')?.remove();

  // Debug facade + tooling, dynamically imported so lil-gui/stats-gl never enter the
  // main chunk and never cost a visitor a byte (08 §16.5).
  if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) {
    const { attachDebug } = await import('./debug.ts');
    attachDebug(app);
  }
}

void boot();
