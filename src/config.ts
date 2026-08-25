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
    /**
     * Where cubes are staged, in front of the instrument bay (15 §5.1). Deterministic and
     * non-overlapping: random scatter beside a moving balance is how a cube ends up
     * bouncing off a pan nobody was looking at.
     */
    stagingZ: 0.48,

    scale: {
      /*
       * Gross capacity above the tared platter. 15 §1 said 5 kg, to match a real kitchen
       * scale — but in THIS app a 3 in tungsten cube is 8 kg and a 4 in is 18.9, so a 5 kg
       * scale cannot weigh the cubes the toy is about. 20 kg covers every cube in the
       * size-button row; a 5 in (36.9 kg) or 6 in (63.7 kg) tungsten cube reads OL, which
       * is itself a lesson. 50 kg was tried and does not stabilise at 60 Hz for any platter
       * up to 8 kg or travel up to 12 mm — the cell gets too stiff for its own platter.
       */
      ratedKg: 20,
      /** Displayed division, and the minimum indication below which no hundredths show. */
      divisionKg: 0.01,
      minIndicationKg: 0.05,

      /*
       * PLATTER MASS IS A NUMERICAL PARAMETER, NOT A COSMETIC ONE.
       *
       * The spring rate is fixed by rated load over rated travel, so a light platter puts a
       * stiff spring on a small mass, and symplectic Euler needs `sqrt(k/m)·dt < 2` on the
       * EMPTY platter — the lightest mass the cell ever sees. 15 §7.3's 0.6 kg seed cannot
       * work at any travel; at 5 kg rated the W0 sweep found 2.5 kg / 8 mm.
       *
       * Re-swept for 20 kg rated (loads 0 / 1 / 5 / 10 / 19 kg, all must settle inside 2 s
       * to 100 ppm), with the damping clamp scaled to the carried load:
       *
       *      platter  travel  | result
       *      2.5-3    6-10 mm | empty platter never settles
       *      4        6 mm    | never settles
       *      4        8-10 mm | passes, 0.55-0.60 s
       *      5        6-10 mm | passes, 0.48-0.58 s
       *
       * 5 kg / 8 mm: settles in 0.50 s, worst error 1.5e-5 kg, sqrt(k/m)·dt = 1.30, and a
       * 19 kg drop peaks at 12.7 mm against a 16 mm stop. A heavy platter costs nothing
       * visible — 15 §7.4 tares it away.
       *
       * Additional solver iterations do not help any of this: the instability is in our
       * own explicit force integration, outside the solver.
       */
      platterKg: 5,
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
       * Lower stop as a multiple of rated travel. A legitimate rated placement peaks at
       * about 1.6x the static travel (12.7 mm against 8 mm at 20 kg), so 1.6x would flash
       * OVERLOAD on a valid weighing. 2.0x keeps the stop clear of every in-range placement
       * while still engaging before proof force on a real overload.
       */
      stopFactor: 2.0,
      /** Proof force as a multiple of rated gross weight; reaching it is OVERLOAD. */
      proofFactor: 1.5,

      /*
       * The signal chain (15 §7.5). Two cascaded one-pole sections; the cutoff is in Hz
       * rather than a bare coefficient so it means the same thing at any step rate, and
       * `dt` being fixed is what makes that true.
       */
      filterCutoffHz: 4,
      /** A reading becomes stable only after this long with EVERY condition holding. */
      stabilityWindowS: 0.5,
      /** Platter speed below which it counts as settled. */
      platterSpeedMps: 0.002,
      /** Peak-to-peak platter travel across the window, below which it counts as settled. */
      travelSpanM: 0.0002,
      /**
       * Corner speed of any cube in the measurement volume, below which the load counts as
       * settled. Guards the case the force cannot see: a cube sliding sideways across the
       * platter holds the vertical force perfectly constant while plainly still moving.
       */
      loadMotionMps: 0.02,
      /** The DOM does not need 60 updates a second; transitions publish immediately. */
      publishHz: 10,
      /**
       * OVERLOAD is a claim too, and gets a dwell like STABLE does. Without one a
       * legitimate 4 in tungsten drop flashed OL three times on its bounces — each contact
       * spike crossed proof force for a single frame — before settling to a correct
       * reading. A real overload holds; a spike does not.
       */
      overloadDwellS: 0.25,

      /*
       * Stage layout (15 §5.1).
       *
       * The housing has to sit clear of the platter's FULLY COMPRESSED underside, not
       * merely of its resting one. At 0.02 half-height it topped out at y = 0.04 and the
       * platter's bottom reached 0.039 under a 1 kg load — so the housing quietly carried
       * the load and a kilo cube weighed 0.15 kg.
       */
      /*
       * The prepared asset is baked with a 45-degree yaw so its display faces the default
       * camera (15 §5.1). The collider footprint is therefore the ROTATED bounding box,
       * which is squarer than the model's own.
       */
      housingHalfM: { x: 0.1763, y: 0.0117, z: 0.1763 },
      platterHalfM: { x: 0.0936, y: 0.0084, z: 0.0936 },
      /*
       * The platter's unloaded height — deliberately ABOVE where the asset parks it.
       *
       * The model sits its platter INSIDE the housing, as a real scale does, because a
       * real strain gauge deflects by microns. Ours moves millimetres so a 60 Hz solver
       * can resolve it (15 §7.2, which says to design the housing seam around that and
       * document it). The seam must clear the FULL stop travel, or the housing becomes the
       * stop: rest 52 mm, platter underside 43.6 mm, housing top 23.4 mm, so a platter on
       * its 16 mm stop still clears the housing by 4 mm.
       */
      platterRestHeightM: 0.052,
    },

    balance: {
      beamKg: 1.4,
      /*
       * 15 §6.1 seeds 0.3 kg and calls the assembly mass a calibration seed. It has to be
       * much heavier here, because this app's loads are not a kitchen balance's: a 2 in
       * tungsten cube is 2.36 kg, and a 0.3 kg dish hit by 8x its own mass does not tilt,
       * it FLIPS. Measured max pan tilt from one off-centre 2 in W cube:
       *
       *     0.3 kg -> 52-178 deg (fully inverted), cube never stays
       *     1.0 kg -> 14-124 deg, sometimes
       *     2.0 kg -> 8.9-29 deg, cube stays every time
       *
       * Equal pans cancel side to side, so mass costs nothing in accuracy — but it does
       * cost sensitivity, because heavy pans at the beam tips add rotational inertia. 1.4
       * is the compromise: stable enough to hold a loaded pan, light enough that the
       * signature demonstration still reads.
       */
      panKg: 1.4,
      /*
       * THE PHYSICS IS THE SOURCE OF TRUTH HERE, and the asset is fitted to it.
       *
       * 15 §6.1 says the final proportions should come from the uniformly rescaled asset,
       * and that was tried: the asset's own ratios give a 0.254 m arm and a 0.273 m drop,
       * and adopting them broke the loaded balance — a 1 kg cube on one pan sent the beam
       * oscillating between -9 and +6 degrees instead of pinning at its stop, and threw the
       * cube on the floor. That needs its own calibration pass, and these values already
       * have one behind them (the W0 sweep).
       *
       * So `tools/prepare-balance.py` scales each part to ITS target instead — the beam to
       * `armM`, the pans to `panRadiusM`, the stand to `pivotHeightM`. Slightly non-uniform
       * between parts, invisible at a glance, and it keeps the drawn instrument and the
       * simulated one the same size.
       */
      armM: 0.37,
      /**
       * Rope length, hook ring to pan rim. The asset hangs its pans at 0.3976; this is
       * shorter on purpose — a longer pendulum swings slower and settles later, and the
       * chains are DRAWN from the live anchors rather than modelled, so shortening them
       * costs nothing visually.
       */
      dropM: 0.26,
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
      /*
       * COM 36 mm below the pivot. Sensitivity and stability trade directly, and this is
       * the point that serves the demonstration: 15 §1's one 2 in W95 against seven 2 in
       * aluminium (about 5 % heavier) settles at -2.06 deg with every cube staying in its
       * pan. Swept across pan masses 0.8-2.0 kg and COM depths 18-54 mm, the demo reads
       * -1.8 to -2.2 deg almost everywhere, so this is a broad optimum rather than a
       * knife edge.
       */
      keelDropM: 0.12,
      keelMassFraction: 0.7,
      /**
       * Viscous pivot friction, applied implicitly (see BalanceInstrument.beforePhysics).
       *
       * Retuned for the RIGID-PAN beam, which carries both 1.4 kg pans at ±0.37 m and so
       * has roughly five times the rotational inertia the hung-pan version did. 0.75 was
       * chosen for that lighter beam and leaves this one badly underdamped: it rings for
       * ~2.5 s after every placement, which is the "shaking" a cube on the pan produces.
       *
       * Measured, dropping a 2 in tungsten cube (overshoot past the final angle):
       *
       *      0.75 -> 0.84 deg    20 -> 0.55 deg
       *      3    -> 1.90 deg, never settles in 15 s
       *      8    -> 1.11 deg, never settles in 15 s
       *      45   -> 0.62 deg    90 -> 0.30 deg, settles in 2.15 s
       *
       * The middle of that range being the worst is not a typo — 3 and 8 sit where the
       * damping resonates with the contact solver. Do not interpolate into it.
       */
      pivotDamping: 90,
      /**
       * Beam travel, enforced by PHYSICAL STOPS the beam rests on (see below). The joint
       * limit is kept a little wider as a backstop and no longer does the work.
       */
      limitDeg: 12,
      /*
       * The stops are blocks on the stand that the beam lands against, because a joint
       * limit alone cannot hold a heavy load still.
       *
       * A revolute limit is a soft constraint. Measured residual motion three seconds
       * after a cube lands, with the limit doing the stopping:
       *
       *      1.5 in (1.0 kg)  -> 0.00 deg, dead still
       *      2   in (2.4 kg)  -> 0.00 deg, dead still
       *      3   in (8.0 kg)  -> 3.66 deg, 33 reversals
       *      4   in (18.9 kg) -> 5.33 deg, 34 reversals
       *
       * Past roughly the assembly's own 4.2 kg the beam is pushed through the limit,
       * shoved back, and never settles — an 11 Hz limit cycle. A contact has friction and
       * restitution and the solver treats it as an ordinary collision, which it can hold.
       *
       * `stopRadiusM` is where they sit out from the pivot: clear of the column, far
       * inboard of the pans, and close enough in that the beam's own bar hides them.
       */
      stopRadiusM: 0.09,
      /** Backstop only. Wider than limitDeg so the contacts are what the beam meets. */
      jointLimitMarginDeg: 3,
      /*
       * APPROACH BRAKING — the last few degrees before the stop, where damping ramps up.
       *
       * A hard joint limit delivers a violent impulse, and that impulse is what throws a
       * cube out of the pan: load one side with the other empty and the beam accelerates
       * across its whole travel and slams. Measured, no pan mass fixes it — 0.6 kg through
       * 4 kg all lose the cube, because the pan is not the problem.
       *
       * A real balance answers this with ARRESTMENT: the beam is locked while you load it.
       * This is the cheap equivalent — the beam eases into its stop instead of hitting it.
       */
      /*
       * Narrow, and it has to stay clear of where the beam actually rests. At 8 degrees
       * the band began at 12-8 = 4, and a typical loaded beam settles at ~4 — so the brake
       * engaged and released around the resting angle on every step.
       */
      stopApproachDeg: 3,
      stopBrakingDamping: 40,
      /** Per pan (15 §1). Physical fit and load capacity are deliberately separate facts. */
      capacityKgPerPan: 10,

      /*
       * Stage layout (15 §5.1). The pivot is lower than the W0 rig's arbitrary 0.55 m,
       * which changes nothing numerically — gravity is uniform, so every W0 measurement
       * transfers unchanged — and puts the pans at a height a camera framing the floor
       * can actually see.
       */
      /*
       * All three come from ONE uniform scale of the prepared asset (0.50636), reported by
       * tools/prepare-balance.py. The dish is 0.32 m across because that is what the model
       * is: 43 % of its beam length. It needs to be — 15 §1's signature demonstration puts
       * SEVEN 2 in aluminium cubes in one pan, and seven 2 in cubes are a 0.152 m square
       * that will not sit in the 0.23 m dish §5.1's seed table asked for.
       */
      pivotHeightM: 0.6834,
      panRadiusM: 0.16,
      panThicknessM: 0.004,
      /*
       * MEASURED OFF THE PREPARED MESH, so a cube sits ON the dish rather than above it.
       * The asset's dish floor is at -10.5 mm in the pan's frame (rising to -6 mm toward
       * the edge) and its rim crests at +10.5 mm at r = 0.15. With the collider's top at
       * +4 mm — the pan origin plus half its thickness — every cube floated 14.5 mm above
       * the metal, and an invisible rim wall stood 13.5 mm proud of the visible one.
       */
      panFloorM: -0.009,
      panRimRadiusM: 0.152,
      panRimTopM: 0.0105,
      /*
       * Where the three drawn chains leave the beam, per side. VISUAL ONLY now — the pans
       * are rigid with the beam, so nothing hangs from these.
       *
       * Small, and it has to be: the beam mesh ends at `armM`, and the old 50 mm value was
       * a *bridle* radius added OUTSIDE that, so every chain began 50 mm past the tip of
       * the beam, attached to nothing. That is what "the strings float at the top" was.
       */
      /*
       * THE LOAD PATH HAS A FILTER IN IT, and without one the instrument does not work.
       *
       * A cube landing on a pan delivers a one-step contact spike of several times its
       * weight — 453 N from an 8 kg cube dropped 2 cm. Turned straight into torque, that
       * kicks the beam to 1.7 rad/s and the pan drops out from under the cube faster than
       * the cube can fall from rest; the gap opens, the load reads zero, the keel pulls
       * the pan back up into the falling cube at 890 N, and it never stops. Every angle
       * measured before this filter existed was the time-average of a bouncing cube.
       *
       * A real beam cannot respond to a 16 ms spike — the bearing is compliant and the
       * beam has inertia — and this is that, in the same two-pole form the digital scale
       * already uses on its cell (15 §7.5). The cutoff is deliberately lower than the
       * scale's 4 Hz: a beam is slower than a load cell.
       */
      loadFilterHz: 2,
      /**
       * Cap on what one pan may report, as a multiple of its rated capacity's weight.
       * Anything above it is an impact, not a load, and the bearing would not carry it.
       */
      loadProofFactor: 2.5,

      hookRingM: 0.006,
      /**
       * Where a chain leaves the hook: the BOTTOM of the ring, which on the prepared mesh
       * spans -17 to +27 mm at the tips. +18 mm (the first value) hung the chains from
       * the top of the ring, which looks wrong the moment the camera moves.
       */
      hookHeightM: -0.012,
      /*
       * STIRRUP HEIGHT — how far ABOVE the dish the three ropes attach.
       *
       * This is what stops a pan flipping, and it is the difference between a pan and a
       * plate on strings. The ropes used to land on the dish's top face, which is level
       * with its own centre of mass, and a body suspended at its centre of mass is
       * neutrally stable in tilt: it will happily turn over. Real balance pans hang from a
       * bail that rises above the dish, putting the suspension above the centre of gravity
       * so gravity rights it.
       */
      panStirrupM: 0.075,

      /*
       * Stand, measured off the prepared mesh (radius by height, pivot at 0): a 0.16 m
       * foot 20 mm thick, a bulb of ~60 mm radius centred 0.55 m below the pivot, and a
       * 15-23 mm stem above it. One 36 mm column matched none of those three.
       */
      baseRadiusM: 0.16,
      baseThicknessM: 0.02,
      bulbRadiusM: 0.05,
      bulbCentreBelowPivotM: 0.55,
      bulbHalfHeightM: 0.06,
      stemRadiusM: 0.02,
      /**
       * How far out in Z each half of the counterweight sits. It has to CLEAR the column,
       * i.e. exceed `columnRadiusM + KEEL_HALF` — a keel that overlaps the stand makes the
       * solver shove the two apart, and an EMPTY balance then rests degrees off level.
       * This has bitten twice: once on the centreline, once after the column was widened
       * to match the asset and the keel was left where it was.
       */
      keelOffsetZM: 0.062,

      /*
       * Bridle losses, on the PANS ONLY (15 §6.1). Never on player cubes — 14 PHY-05
       * deleted exactly this lever there for corrupting free fall.
       *
       * Without it the pans are frictionless pendulums on 0.2 m ropes and they swing
       * forever: measured, an empty balance whose BEAM had settled to 0.02 degrees still
       * had a pan turning at 0.37 rad/s ten seconds in, so the instrument could never
       * report BALANCED. A 0.9 s pendulum period wants a rate that kills the swing in
       * about two periods.
       */
      panLinearDamping: 1.6,
      panAngularDamping: 2.2,

      /*
       * Reading the beam (15 §9.3, §13.2). BALANCED is a claim about equality, so it gets
       * the same treatment as the scale's STABLE: a tolerance AND a dwell, with every
       * disturbance resetting the clock.
       */
      balancedToleranceDeg: 0.25,
      settleWindowS: 0.5,
      /**
       * Peak-to-peak beam travel across the settle window, below which it counts as
       * stopped. Judged on POSITION, not angular velocity — see BalanceSignal for the
       * measurement that made that necessary.
       */
      settledAngleSpanDeg: 0.2,
      /**
       * Pan swing below which the bridle counts as hanging still.
       *
       * Loose on purpose. The pans hang on six ropes and keep a small residual sway long
       * after the beam has stopped — measured, a lightly loaded beam sat at 4.4 degrees
       * with its angle steady to within 0.05 while a pan still turned at ~0.2 rad/s, and a
       * tighter gate reported MOVING indefinitely. The BEAM's angle is what the reading
       * depends on, and that has its own, strict, span test.
       */
      settledPanSpeedRadS: 0.35,
      /**
       * How close to the 12 deg stop counts as ON it. The solver overshoots the limit by
       * ~0.19 deg, so a beam pinned by a real imbalance must not be read as merely tilted.
       */
      // 1 deg rather than 0.4: the stop posts and the soft contact between them leave the
      // beam resting about 0.75 deg short of the nominal limit, and a beam on its stop is
      // held there (see BalanceInstrument.beforePhysics) — so "on the stop" has to include
      // where it actually comes to rest.
      atStopMarginDeg: 1.0,
    },
  },

  /**
   * The Drop Tower's air column (16 §6.3) — quadratic drag, AIR/VACUUM toggleable,
   * applied by the lab and by nothing else. Fluid (M4) reuses the model with its own
   * density. D0 measured the 60 Hz explicit scheme within 0.11 % of the analytic law.
   */
  /** FX numbers (16 §10). Haptics only for now; shake and particles land in D3. */
  fx: {
    hapticTickMs: 8,
    hapticImpactBaseMs: 10,
    hapticImpactScaleMs: 40,
    /** Below this delivered energy an impact earns no buzz at all. */
    hapticImpactMinJ: 2,
    /** Camera shake (16 §10.1): the wow moment (1.9 kJ) is full scale. */
    shake: { refJ: 1900, minJ: 2, ampFrac: 0.004, tauS: 0.18, freqHz: 19, phaseRad: 2.1 },
    /** Impact puffs (16 §10.2). */
    particles: { minJ: 1, sparkMinJ: 50 },
    /** Floor marks (16 §7.5): FIFO cap per plate, halved on the low tier. */
    decals: { cap: 24, fadeLast: 4 },
  },

  aero: {
    rhoAirKgM3: 1.225,
    /** Cube face-on drag coefficient (02's formula sheet); the drop is carried level. */
    cdFaceOn: 1.05,
  },

  drop: {
    /*
     * The compliant pads (16 §7.3, numbers measured in D0 and pinned by
     * tests/physics/drop.test.ts). See labs/shared/compliant-pad.ts for what each
     * parameter does and the failures behind the design.
     */
    pads: {
      trampoline: {
        padKg: 1.5,
        travelM: 0.25,
        /**
         * The mat needs its own travel VOLUME under it: mounted 5 cm off the stage, a
         * 25 cm-travel mat had 4 cm of usable stroke before its body met the stage
         * floor — no stored energy, no throw, every catch read ABSORBED (caught by
         * drop-lab.test.ts). A real mini-tramp stands about this tall.
         */
        restCentreYM: 0.3,
        /**
         * Retuned 2026-08-25 (was 3470): a 2″ W from 2 m now returns ~63 % — a
         * trampoline that reads as one (user verdict on the old tuning: "if it's not
         * going to behave properly, it should not exist"). Stiffer is also MORE
         * honest: the max under-gate catch (150 J) compresses 0.19 m of the 0.25 m
         * stroke, so the soft travel-stop (86 % energy-adding artefact, doc 14) never
         * fires inside the legal envelope. ω·dt = 1.22 < 2 keeps the explicit spring
         * stable; the sweep lives in doc 16 §7.3's amendment.
         */
        kNpm: 8000,
        /** ζ ≈ 0.08 on the bare pad — the mat stays alive. */
        dampingImplicit: 7.7,
        surface: 'trampoline',
      },
      foam: {
        padKg: 1.0,
        travelM: 0.12,
        /** The block's top skin: travel + a whisker of clearance above the stage. */
        restCentreYM: 0.13,
        /** A 4 in W (185 N) sags 50 mm at rest. */
        kNpm: 3700,
        /** Critically damped under a load: no wobble, no bounce. */
        zetaLoaded: 1.0,
        /** Rate-controlled memory: within 2 mm of rest in ln(25)·τ ≈ 1 s (10 §4.9). */
        creepTauS: 0.3,
        surface: 'foam',
      },
    },
    /** The winch (16 §6.1–6.2). Heights are of the cube's BOTTOM FACE above the plate. */
    tower: {
      minHM: 0.1,
      maxHM: 20,
      defaultHM: 2,
      /** Trapezoidal hoist: 2 m in ~0.9 s, the full 20 m in ~3.8 s. */
      hoistSpeedMps: 6,
      hoistAccelMps2: 12,
      /**
       * The CABLE END's rest height (17 §3): the carriage hangs 0.89 m below it, so
       * at rest the open bay floats with its door plane ~0.46 m over the plate.
       */
      /**
       * Redesigned 2026-08-25 (user): the carriage IDLES RAISED AND CLOSED — its
       * floor is the loading platform. Spawns land on it, HOIST goes straight up,
       * and the whole descend-and-capture phase is gone. Idle door plane 0.85 m
       * clears the tallest target (0.45) with spawn headroom.
       */
      restCableEndYM: 1.74,
      /** The capture nudge (17 §3.3): the cube rises this much so the doors can close under it. */
      clampGapM: 0.006,
      /** How fast a carried cube slerps level after the clamp (1/s). */
      levelRate: 10,
    },
    /** The floor plate (16 §7.1): one floor mounted at a time, top face at plateTopYM. */
    plate: {
      halfM: 0.6,
      thicknessM: 0.02,
      topYM: 0.02,
    },
    /** Reading the drop (16 §8.1, §12.2). */
    signal: {
      restSpeedMps: 0.05,
      restAngSpeedRadS: 0.2,
      restDwellS: 0.5,
      /** The verdict is never withheld forever: settling ends here regardless. */
      settleTimeoutS: 4,
    },
    /** Verdict thresholds (16 §7.6), on the DELIVERED energy E_n (02 §7 anchors). */
    verdicts: {
      chipJ: 200,
      crackJ: 400,
      dentJ: 10,
      ringJ: 5,
      craterJ: 10,
      /** Rebound fraction of the drop height that counts as BOUNCED / CAUGHT. */
      bounceFrac: 0.1,
      /** Past this return fraction the mat THREW the cube — BOUNCED, not CAUGHT (2026-08-25 retune). */
      thrownFrac: 0.35,
    },
    /** Where spawned cubes stage, in front of the plate (16 §5.4). */
    staging: { zM: 0.55, rowHalfM: 0.42, gapM: 0.02 },
    /** 16 §5.1: frame the landing zone; the tower rises out of frame by design. */
    camera: { radiusM: 0.9, centreYM: 0.66 }, // low platform-first idle shot (user, 2026-08-25)
    /*
     * The capacity gates (16 §7.3 amendment): past ½mv², the mat is already beaten
     * and the landing goes to the rigid crushed-mat regime. Trampoline: above the
     * spring's 108 J because the fabric eats its share first — a 2 in W arriving
     * with 116 J measurably does NOT reach the stop. Foam: just above its 27 J.
     */
    gates: {
      trampolineBottomOutJ: 150,
      foamBottomOutJ: 30,
    },
  },
};
// Deliberately NOT `as const`: the calibration page writes through this object live
// (08 §5.4), and readonly literal types would make that a type error.

export type Config = typeof config;
