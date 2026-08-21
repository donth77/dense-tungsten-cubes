/**
 * Every tunable constant in the app (08 §10). Zero magic numbers inside systems —
 * a constant that can't be found in ten seconds is a bug (08 §5.4).
 *
 * These are *start* values. `calibrate.html` mounts lil-gui over this object and is
 * where they get finalised. Mutable on purpose: the calibration page edits them live.
 */

export const config = {
  /** The one authoritative physical constant. Nothing may re-declare g (14 PHY-14). */
  physics: {
    /**
     * Standard gravity, exactly 9.80665 m/s² by definition (NIST SP 811 B.8). The app
     * previously carried 9.81 in physics, in the calibration page and in tests; three
     * copies of a constant is how they drift apart, and the definition costs nothing.
     */
    gravityMps2: 9.80665,
  },

  geometry: {
    /**
     * Cube edge chamfer, as a fraction of the side. The RENDERER and the COLLIDER both
     * read this and must never disagree (14 PHY-07): the mesh had a 3 % chamfer while
     * physics used a sharp cuboid, so first contact, tipping threshold, rocking and the
     * corner-impact lever arm were all computed for a shape nobody could see.
     *
     * The advertised outer side stays exactly `sideM` either way — the chamfer is cut
     * INTO the cube, it does not grow it.
     */
    chamferFraction: 0.03,
  },

  loop: {
    /** Fixed physics timestep. 60 Hz, always — decoupled from the display refresh. */
    DT: 1 / 60,
    /** Guards the tab-return spiral: never simulate more than a quarter-second of catch-up. */
    accumulatorClampS: 0.25,
  },

  hand: {
    /** Critically damped: kp = m·ω₀², kd = 2·m·ω₀. Feel falls out of real mass (08 §8.4). */
    omega0: 12,
    zeta: 1.0,
    /** 02 §9. The cap is what makes a 6″ tungsten cube (625 N) refuse to be lifted. */
    capOneHandN: 350,
    capTwoHandN: 700,
    capForkliftN: 50_000,
    /** Applied while held so a corner-grabbed cube hangs rather than spins. Restored on release. */
    heldAngularDamping: 3.0,
    /** Held bodies get CCD above this speed — prevents thrown-cube tunneling. */
    ccdSpeedMps: 5,
    /**
     * Touch only: lift the grab target this far up the screen so the cube rides above
     * the fingertip instead of under it (12 §4). Zero on mouse. Wants tuning on device.
     */
    touchGrabOffsetPx: 28,
  },

  camera: {
    /** Long lens: flattens toward isometric while keeping depth cues. */
    fovDeg: 38,
    /** The ¾ view where three cube faces always read (user decision 2026-08-07). */
    azimuthDeg: 45,
    elevationDeg: 30,
    distanceM: 2.2,
    /**
     * Default framing is DERIVED from cube size, not absolute (measured at M0).
     * 08 §8.5's flat 2.2 m was written before anything rendered; on screen it frames the
     * 6 m floor and leaves a 2" cube as a speck, so "the ¾ view where three faces always
     * read" wasn't true at the documented distance. side × 11 gives 0.56 m for a 2" cube
     * and 4.2 m for a 15" one — both frame well, and the size slider becomes self-framing.
     * `distanceM` stays as the fallback when no size is in hand.
     */
    distancePerSide: 11,
    target: { x: 0, y: 0.15, z: 0 },
    /** Exponential damping rate: state += (goal − state)·(1 − e^(−λ·dt)). Framerate-independent. */
    lambda: 12,
    /** prefers-reduced-motion raises λ rather than removing damping (13 §7): less drift, not a jump-cut. */
    lambdaReducedMotion: 24,
    polarMinDeg: 15,
    polarMaxDeg: 80,
    distMinM: 0.3,
    distMaxM: 20,
    orbitSpeed: 0.008,
    /** Pan scales with distance so it feels the same zoomed in or out. */
    panSpeed: 0.0016,
    /** Target stays inside the play area — pan must never strand you on empty floor. */
    panLimitM: 1.2,
    panLimitYM: 1.0,
    dollySpeed: 0.0015,
  },

  impact: {
    /**
     * The impact channel needs *closing motion*, and both conditions must hold (08 §8.1).
     * An earlier draft OR-ed force with energy, which fires forever under any resting
     * cube heavier than ~300 g. Force rides along on the event as data only.
     */
    minEnergyJ: 0.005,
    minNormalSpeedMps: 0.05,
  },

  audio: {
    /** gain = clamp01((log10(E) + gainOffset) / gainRange): 0.01 J whisper → 300 J full. */
    gainOffset: 2,
    gainRange: 3.5,
    /** playbackRate = (pitchRefSideM / sideM)^pitchExp — small cubes ring higher. */
    pitchRefSideM: 0.0508, // 2″
    pitchExp: 0.4,
    pitchJitter: 0.04,
    /**
     * Per body-pair debounce, so one landing is one thud rather than a machine-gun burst.
     *
     * This lives in `audio` and not in `impact` on purpose (14 PHY-06): it is
     * presentation debouncing, and while it sat inside the physics signal path it also
     * suppressed *real* rapid rebounds from anything else reading impacts — a lab, a
     * damage model, a test. Physics now reports every qualifying contact; the ear gets
     * the filtered version.
     */
    pairCooldownMs: 60,
    /** Tungsten's sub-bass signature layers in above this energy. */
    subLayerMinEnergyJ: 5,
    /** Per-voice, oldest-steals. */
    polyphony: 4,
    masterGain: 0.9,
  },

  stability: {
    /**
     * Solver iterations. Measured across 4/8/16/32 with and without extra internal PGS
     * iterations (14 §4.2): none of them move the extreme-size-ratio case at all
     * (55.93 % → 55.89 % at 8, 55.92 % at 16), while 16 costs 3.9x the step time. The
     * limiting factor is neither convergence nor contact tolerance — `allowedLinearError`
     * of exactly 0 still leaves 54.4 % — it is the size ratio itself. See
     * `SUPPORTED_STACK_SIZE_RATIO`. Stays 4, now for a measured reason.
     */
    solverIterations: 4,
    /**
     * Contact tolerances, tightened from Rapier's defaults after measuring at M0.
     *
     * The defaults (allowed error 0.001, prediction 0.002 — i.e. 1 mm and 2 mm at
     * length_unit = 1 m) are sized for human-scale props. Our size slider starts at
     * 0.25" = 6.35 mm, so a 1 mm allowed penetration is 16 % of the whole cube: small
     * cubes visibly sink into the floor and a 3-stack measures 4 % short. That breaks
     * "real numbers, honestly labeled" (01 pillar 2) in the most literal way.
     *
     * We can afford to tighten because the jitter measurement came back 500x inside
     * budget (1 um drift against a 0.5 mm gate), leaving plenty of solver headroom.
     */
    /*
     * Tightened again after 14 PHY-03. Resting penetration is very nearly CONSTANT in
     * absolute terms — it is set by these tolerances, not by the body — so it is the
     * smallest cube that pays for a loose value. Swept, with settled drift measured at
     * every step (all of them 0.00000 mm, so none of this costs jitter):
     *
     *   err / predict     0.25" sink     1" sink     4" sink
     *   0.0002 / 0.0005      6.465 %      1.638 %     0.326 %   <- previous
     *   0.0001 / 0.0002      4.889 %      1.244 %     0.228 %
     *   0.00005 / 0.0001     2.862 %      0.715 %     0.262 %   <- now
     *   0.00002 / 0.00005    2.389 %      0.597 %     0.232 %
     *
     * 0.05 mm keeps most of the available gain while leaving an order of magnitude of
     * headroom above the point where the solver starts fighting itself.
     */
    allowedLinearError: 0.00005, // 0.05 mm
    predictionDistance: 0.0001, // 0.1 mm
    /**
     * Rapier's length_units. Swept 0.01 / 0.1 / 1 against the size-ratio case: it buys
     * 1.5 percentage points (55.93 % → 54.37 %) and changes nothing qualitatively, so it
     * stays at 1 and the world stays in real metres.
     *
     * `WORLD_SCALE` used to live here as "the ×4 escalation, wired from day one". It was
     * never read by anything (14 PHY-14); a stability lever that no code consults is not
     * a lever, so it is gone rather than left as reassurance.
     */
    lengthUnit: 1,
    /**
     * Absolute speed ceiling — a fail-safe against a NaN-adjacent blow-up, not physics.
     *
     * Applied BEFORE the step, so it actually bounds how far a body can move in one
     * (50/60 = 0.833 m). It used to be applied after integration, which measured out as a
     * body travelling 1.046 m in the step it was "limited" to 50 m/s for: the cap could
     * not prevent the swept-collision failure it existed for, and silently deleted
     * momentum afterwards (14 §4.6).
     */
    maxSpeedMps: 50,
    /**
     * CCD is enabled for a body when its predicted sweep this step exceeds this fraction
     * of its own half-extent. Sweep includes the corner's ANGULAR travel, so a slow but
     * fast-spinning cube is protected too — centre-of-mass speed alone misses it.
     */
    ccdSweepFraction: 0.5,
    /**
     * Rapier's `maxCcdSubsteps`, which defaults to 1. Measured against a 10 mm plate: the
     * old adaptive-substep strategy tunnelled straight through in 5 of 6 speed/size cases
     * (0.25" and 1" cubes at 30 and 50 m/s); pre-step CCD held all 6. 4 substeps also cut
     * the worst first-frame overlap of a 4" cube at 40 m/s from 56.0 mm to 0.65 mm.
     */
    maxCcdSubsteps: 4,
    /**
     * Soft-CCD prediction distance, as a fraction of a body's half-extent. **Zero, and
     * deliberately so.**
     *
     * It looks like free insurance — a cheaper predictive contact alongside full CCD —
     * and it measured as a disaster for restitution: a 1" W cube on concrete rebounded at
     * e = 0.055 with it against a modelled 0.150, because the solver treats the approach
     * as an already-established contact and absorbs the closing velocity before the
     * bounce is computed. It bought nothing in exchange: against a 10 mm plate, full CCD
     * held all six speed/size cases with and without it.
     *
     * Left as a named constant rather than deleted because it is a real Rapier feature
     * worth re-testing if the contact model changes; anything above 0 must be re-measured
     * against `tests/physics/restitution.test.ts` before it ships.
     */
    softCcdFraction: 0,
  },

  stage: {
    /** 6×6 m concrete test chamber (08 §8.3). */
    floorHalfSizeM: 3,
    floorThicknessM: 0.2,
    /**
     * The shadow camera covers only where cubes actually are, not the whole floor.
     * Measured at M0: spanning the full 6 m left a 2" cube's shadow in ~15 texels.
     */
    shadowHalfSizeM: 1.5,
    /**
     * "The tray" (08 §16.8) is a spawn *zone*, not a UI object: where new cubes appear,
     * where cross-lab persistence puts them, and where the NaN watchdog teleports a
     * body that has gone non-finite.
     */
    trayCentre: { x: 0, y: 0.4, z: 0 },
    trayScatterM: 0.06,
    /**
     * Below this, an un-held cube is gone for good.
     *
     * The floor is a finite 6 m slab, so anything pushed past its edge falls forever —
     * and before this existed, nothing ever cleaned those up. They kept a Rapier body, a
     * mesh and a shadow blob alive off-screen, and counted against `limits.maxCubes`,
     * so a scene could evict cubes you could see to make room for cubes you couldn't.
     *
     * -2 m is roughly 0.64 s of fall: long enough that the cube is well out of frame at
     * any camera angle we allow, short enough that it never becomes a fast-moving body
     * the solver has to keep thinking about.
     */
    killPlaneY: -2,
  },

  limits: {
    /** Spawning past this despawns the oldest un-held cube with a toast. */
    maxCubes: 60,
    drawCallBudget: 150,
    /** Desktop. Phones clamp harder — the single biggest mobile win (12 §5). */
    pixelRatioMax: 2,
    pixelRatioMaxPhone: 1.5,
  },

  quality: {
    /** Dynamic resolution: sustained slow frames shrink the render target, never the physics. */
    slowFrameMs: 20,
    slowFrameCount: 30,
    resolutionScaleStep: 0.85,
    resolutionScaleFloor: 0.6,
    /** Recovery needs a long clean run — ~4 s at 60 fps. Scaling up causes the next
     *  slow frame, so an eager recovery just oscillates between two resolutions. */
    recoverAfterFrames: 240,
    shadowMapDesktop: 2048,
    shadowMapPhone: 1024,
  },

  input: {
    /** Tap vs drag (08 §8.6), slop measured in CSS px. Fingers wobble more than mice. */
    tapMaxMs: 200,
    tapMaxMovePxMouse: 8,
    tapMaxMovePxTouch: 12,
    /** Two pointers do dolly *and* orbit simultaneously, each past its own deadzone (12 §4). */
    twoPointerDeadzonePx: 8,
    longPressMs: 450,
    doubleTapMaxMs: 300,
  },

  layout: {
    /** One source of truth, computed in JS and read by CSS *and* the camera (12 §3). */
    phoneMaxWidthPx: 700,
    /** Height, not width — a bottom sheet eats a landscape phone (12 §3). */
    shortMaxHeightPx: 520,
    tabletMaxWidthPx: 1023,
    /** Camera look-at offsets so a selected cube never sits behind an open panel (12 §3). */
    cameraOffsetPortraitFrac: 1 / 6,
    cameraOffsetRailPx: 140,
  },

  /**
   * The Weigh Station (15). M2a.
   *
   * Every number below was CHOSEN BY MEASUREMENT in the Stage W0 spike
   * (`tests/physics/weigh.test.ts`, rig in `tests/physics/weigh-rig.ts`), not estimated.
   * The sweeps that produced them are quoted at each field, because the alternative —
   * a plausible-looking constant with no provenance — is how 15 §7.3's own seed values
   * came to be wrong.
   */
  weigh: {
    scale: {
      /** Gross capacity above the tared platter (15 §1). */
      ratedKg: 5,
      /** Displayed division, and the minimum indication below which no hundredths show. */
      divisionKg: 0.01,
      minIndicationKg: 0.05,

      /*
       * PLATTER MASS IS A NUMERICAL PARAMETER, NOT A COSMETIC ONE.
       *
       * 15 §7.3 seeds 0.6 kg. Measured, **0.6 kg cannot work at 60 Hz at any travel or
       * damping in the swept range** — the empty platter never settles. Two independent
       * limits bind, both evaluated on the EMPTY platter because that is the lightest
       * mass the cell ever sees:
       *
       *     spring:            sqrt(k/m)·dt < 2
       *     explicit damper:   c·dt/m       < 2
       *
       * and k is fixed by rated load over rated travel, so a light platter forces a stiff
       * spring onto a small mass. At 0.6 kg / 6 mm, sqrt(k/m)·dt = 2.06 — over the limit.
       *
       * Minimum platter mass that passes 0/1/5 kg, measured (clamped damper):
       *
       *      travel   6 mm ->  2.5 kg        travel  12 mm -> 1.5 kg
       *      travel   8 mm ->  2.0 kg        travel  16 mm -> 1.5 kg
       *      travel  10 mm ->  1.5 kg
       *
       * 2.5 kg at 8 mm is the pick: settles in 1.20 s against a 2 s gate, raw error
       * 3.4e-7 kg against a 1e-3 kg gate, steady-state span 0.0000 N, and sqrt(k/m)·dt =
       * 1.01, half the stability limit. A heavy platter costs nothing visible because
       * 15 §7.4 excludes the empty-platter indication from capacity — it is tared away.
       *
       * Additional solver iterations DO NOT HELP: +0/+4/+16/+32 all fail identically on
       * the 0.6 kg seed, because the instability is in our own explicit force integration,
       * outside the solver entirely.
       */
      platterKg: 2.5,
      /** Solver-resolvable travel at rated load. Larger than a real strain gauge (15 §7.2). */
      travelM: 0.008,
      /**
       * Damping ratio around platter + 1 kg. Currently INERT: `clampDamping` binds every
       * step of a transient, so 0.7 and 2.0 measure identically. Kept as the physical
       * parameter it is, so whoever revisits the clamp has the knob back.
       */
      zeta: 1.0,
      /**
       * Cap the damping impulse at what would just stop the platter this step.
       * Unconditionally dissipative, which removes the `c·dt/m < 2` limit above: 88 of the
       * swept configurations pass with it against 26 without.
       */
      clampDamping: true,
      /**
       * Lower stop as a multiple of rated travel. A legitimate 5 kg placement peaks at
       * 12.43 mm of compression — 1.55x the static 8 mm — so the first choice of 1.6x
       * (12.8 mm) left 0.37 mm of margin and would have flashed OVERLOAD on a valid
       * weighing. 2.0x keeps the stop clear of every in-range placement while still
       * engaging before proof force on a real overload.
       */
      stopFactor: 2.0,
      /** Proof force as a multiple of rated gross weight; reaching it is OVERLOAD. */
      proofFactor: 1.5,
    },

    balance: {
      beamKg: 1.4,
      panKg: 0.3,
      /** Load arm: pivot to pan centre (15 §6.1 seeds 0.36–0.38 m). */
      armM: 0.37,
      /** Rope length, hook ring to pan rim. */
      dropM: 0.2,
      /*
       * The beam/yoke COM sits `keelDropM · keelMassFraction` = 84 mm below the pivot.
       * Gravity restores the beam; nothing else does (15 §6.2 — no motor, no angle spring).
       *
       * 15 §6.1 seeds a much shallower keel. Deeper is better for two measured reasons:
       *
       *   1. Residual solver bias appears as a fixed torque, so the rest angle it produces
       *      shrinks as the restoring moment grows. Equal-load rest angle by COM depth:
       *      30 mm -> 0.26 deg (outside the ±0.25 deg gate), 45 mm -> 0.18, 63 mm -> 0.11,
       *      84 mm -> 0.067, 112 mm -> 0.062.
       *   2. It is what makes the signature demonstration READABLE. With a 5 % mass
       *      difference — 15 §1's seven aluminium cubes against one tungsten — a shallow
       *      keel slams the beam onto the 12 deg stop (-12.01 deg at 30-45 mm) and every
       *      difference looks identical. At 84 mm the same 5 % rests at -8.2 deg: plainly
       *      tipped, plainly not pinned, and visibly less than the -12.2 deg a 2x load gives.
       */
      keelDropM: 0.12,
      keelMassFraction: 0.7,
      /**
       * Viscous pivot torque, N·m·s/rad, clamped like the cell damper. Measured after a
       * 1.2 rad/s nudge: 0.3 swings for 4.8 s (past 15 §6.1's 2–3 s target), 1.5 kills the
       * nudge inside one step and reads dead, 0.75 settles in 1.47 s with a visible swing.
       */
      pivotDamping: 0.75,
      /** Beam travel. The stop holds to within ~0.19 deg of solver tolerance, as 15 §13.2 allows. */
      limitDeg: 12,
    },
  },
};
// Deliberately NOT `as const`: the calibration page writes through this object live
// (08 §5.4), and readonly literal types would make that a type error.

export type Config = typeof config;
