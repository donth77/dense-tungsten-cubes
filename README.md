# Dense — a tungsten cube physics toy (design phase)

A browser physics toy about density: tungsten heavy-alloy cubes (90–97% W) vs gold, copper, iron, titanium, and aluminum — weighed, dropped, crushed into things, and sunk in fluids. Three.js + Rapier. Desktop & mobile.

## The labs

| Tab         | What it is                                                                           |
| ----------- | ------------------------------------------------------------------------------------ |
| **Sandbox** | Mats of five materials, and the two line-ups: same size, and same mass.              |
| **Weigh**   | A digital scale and a balance. Gold and tungsten read the same number twice.         |
| **Drop**    | A six-floor tower, honest verdicts, and crush targets from an egg to a cinder block. |
| **Tank**    | Buoyancy in water, honey and mercury.                                                |

### The Tank

Buoyancy is density's courtroom: a cube floats at exactly `ρ_cube / ρ_fluid` submerged,
and nothing about that is authored — it falls out of Archimedes for free.

In water and honey everything sinks, but at visibly different speeds. In **mercury** four
of the six metals float, riding at their true submerged fractions, while gold and
tungsten glide to the bottom — and they separate on the way down. Everywhere else in this
toy those two are indistinguishable, which is the point of the gold-plated-tungsten
story; the tank is the one place the fraud is visible. `DROP ALL` stages the line-up and
captions it from the running simulation:

```
4 float — Cu 66 % · Fe 58 % · Ti 33 % · Al 20 %.  Au hit bottom 0.05 s before W.
```

The surface is a GPU wave-equation heightfield (the Evan Wallace / jeantimex technique),
and the tiled floor refracts and catches caustics from it — computed analytically in the
floor's own shader, so the whole effect costs no extra render passes.

## Development

The project uses Node 22 and pnpm 10.14.0. With Corepack available:

```bash
corepack enable
pnpm install
pnpm dev
```

Other useful commands:

```bash
pnpm build
pnpm lint
pnpm test
pnpm smoke
```
