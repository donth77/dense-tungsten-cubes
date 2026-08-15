import './ui/tokens.css';
import { App } from './app.ts';
import { config } from './config.ts';
import { PhysicsWorld } from './core/physics.ts';
import { cubeMassKg } from './data/metals.ts';
import type { MetalId } from './types.ts';

/**
 * The tuning workbench (08 §11 step 24, 05). Built but never linked from the toy.
 *
 * It exists from M0 rather than M2a because M0's entire job is tuning: the Hand's PD
 * constants, the impact gate, and the audio curve are all guesses until someone drags a
 * cube with a slider in the other hand. Making that a 10-second loop instead of an
 * edit-reload loop is the difference between tuning the feel and arguing about it.
 */

const IN = 0.0254;

async function boot(): Promise<void> {
  const canvas = document.getElementById('stage') as HTMLCanvasElement;
  const readout = document.getElementById('readout')!;

  const app = new App(canvas, await PhysicsWorld.create());
  app.start();

  const { default: GUI } = await import('lil-gui');
  const gui = new GUI({ title: 'Dense · calibration' });

  const spawner = { metal: 'W' as MetalId, sizeIn: 2, purityPctW: 95 };
  const sf = gui.addFolder('Spawner');
  sf.add(spawner, 'metal', ['W', 'Cu', 'Fe', 'Ti', 'Al']).onChange(apply);
  sf.add(spawner, 'sizeIn', 0.25, 15, 0.25).name('size (in)').onChange(apply);
  sf.add(spawner, 'purityPctW', 90, 97, 0.5).name('purity (% W)').onChange(apply);
  sf.add({ spawn: () => app.spawn() }, 'spawn').name('Spawn  [space]');
  sf.add({ reset: () => app.reset() }, 'reset').name('Reset  [R]');

  function apply(): void {
    app.spec = {
      metal: spawner.metal,
      sideM: spawner.sizeIn * IN,
      purityPctW: spawner.purityPctW,
    };
  }
  apply();

  const hf = gui.addFolder('The Hand');
  hf.add(config.hand, 'omega0', 2, 30, 0.5).name('ω₀ (rad/s)');
  hf.add(config.hand, 'zeta', 0.3, 2, 0.05).name('ζ (damping)');
  hf.add(config.hand, 'capOneHandN', 50, 2000, 10).name('cap · one hand (N)');
  hf.add(config.hand, 'heldAngularDamping', 0, 12, 0.1).name('held ang. damping');
  hf.add({ mode: 'one' }, 'mode', ['one', 'two', 'forklift']).onChange((m: string) =>
    app.hand.setMode(m as 'one' | 'two' | 'forklift'),
  );

  const cf = gui.addFolder('Camera');
  cf.add(config.camera, 'fovDeg', 15, 80, 1).onChange(() => {
    app.render.camera.fov = config.camera.fovDeg;
    app.render.camera.updateProjectionMatrix();
  });
  cf.add(config.camera, 'lambda', 2, 30, 0.5).name('damping λ');
  cf.close();

  const imf = gui.addFolder('Impact gate');
  imf.add(config.impact, 'minEnergyJ', 0, 0.05, 0.001).name('min energy (J)');
  imf.add(config.impact, 'minNormalSpeedMps', 0, 0.5, 0.005).name('min closing (m/s)');
  imf.close();

  const af = gui.addFolder('Audio');
  af.add(config.audio, 'gainOffset', 0, 4, 0.1);
  af.add(config.audio, 'gainRange', 1, 6, 0.1);
  af.add(config.audio, 'pitchExp', 0, 1.5, 0.05).name('pitch exponent');
  af.add(config.audio, 'subLayerMinEnergyJ', 0, 40, 0.5).name('W sub layer > (J)');
  // Presentation debounce, not a physics gate — see config.audio.pairCooldownMs.
  af.add(config.audio, 'pairCooldownMs', 0, 300, 5).name('pair cooldown (ms)');
  af.add(config.audio, 'masterGain', 0, 1, 0.02);
  af.close();

  // Live readout. The mass line is the honesty check: what the sim thinks a cube weighs
  // must equal what data/metals.ts computes, every frame, for every purity.
  const tick = (): void => {
    const m = cubeMassKg(spawner.metal, spawner.sizeIn * IN, spawner.purityPctW);
    const held = app.hand.heldId !== null ? app.entities.get(app.hand.heldId) : undefined;
    const imp = app.lastImpact;
    readout.innerHTML =
      `spec    <b>${spawner.metal}</b> ${spawner.sizeIn}" ` +
      `${spawner.metal === 'W' ? `@ ${spawner.purityPctW}% W` : ''}\n` +
      `mass    <b>${m.toFixed(m < 1 ? 4 : 2)} kg</b>  (${(m * 2.20462).toFixed(2)} lb)\n` +
      `weight  <b>${(m * config.physics.gravityMps2).toFixed(1)} N</b>   cap ${app.hand.capN} N\n` +
      `bodies  ${app.entities.size}    fps <b>${app.loop.fps.toFixed(0)}</b>\n` +
      `hand    ${held ? `holding #${held.id}` : '—'}  meter <b>${(app.hand.meter * 100).toFixed(0)}%</b>\n` +
      `impact  ${imp ? `${imp.energyJ.toFixed(3)} J @ ${imp.normalSpeedMps.toFixed(2)} m/s` : '—'}`;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  const { attachDebug } = await import('./debug.ts');
  await attachDebug(app);
}

void boot();
