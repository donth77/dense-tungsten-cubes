/**
 * Every tunable constant in the app (08 §10). Zero magic numbers inside systems —
 * a constant that can't be found in ten seconds is a bug (08 §5.4).
 *
 * These are *start* values. `calibrate.html` mounts lil-gui over this object and is
 * where they get finalised. Mutable on purpose: the calibration page edits them live.
 */

export const config = {
  loop: {
    /** Fixed physics timestep. 60 Hz, always — decoupled from the display refresh. */
    DT: 1 / 60,
    /** Guards the tab-return spiral: never simulate more than a quarter-second of catch-up. */
    accumulatorClampS: 0.25,
    /** Above this speed a body gets 4 physics substeps (tunneling insurance). */
    substepSpeedMps: 8,
    substepFactor: 4,
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
    /** Per body-pair, so one landing is one thud rather than a machine-gun burst. */
    pairCooldownMs: 60,
  },

  audio: {
    /** gain = clamp01((log10(E) + gainOffset) / gainRange): 0.01 J whisper → 300 J full. */
    gainOffset: 2,
    gainRange: 3.5,
    /** playbackRate = (pitchRefSideM / sideM)^pitchExp — small cubes ring higher. */
    pitchRefSideM: 0.0508, // 2″
    pitchExp: 0.4,
    pitchJitter: 0.04,
    /** Tungsten's sub-bass signature layers in above this energy. */
    subLayerMinEnergyJ: 5,
    /** Per-voice, oldest-steals. */
    polyphony: 4,
    masterGain: 0.9,
  },

  stability: {
    /** Cubes below 1″ get extra damping — the small-cube stability lever (05). */
    smallCubeSideM: 0.0254,
    smallCubeLinearDamping: 0.05,
    smallCubeAngularDamping: 0.1,
    /**
     * 08 §11 step 8 says raise this to 8 if the jitter gate demands it. It didn't — and
     * measured at M0, 8 changed nothing for the extreme-mass-ratio case either (the
     * 0.25" Al cube sank identically at 4 and at 8). The limiting factor there is contact
     * tolerance, not solver convergence, so the extra iterations were pure cost. Stays 4.
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
    allowedLinearError: 0.0002, // 0.2 mm
    predictionDistance: 0.0005, // 0.5 mm
    /**
     * The ×4 world-scale escalation, wired from day one so the decision is one constant
     * rather than a refactor (08 §2.7). Rapier's own `lengthUnit` is tried first (05).
     */
    WORLD_SCALE: 1,
    /** Rapier's length_units — the sanctioned first escalation before scaling the world. */
    lengthUnit: 1,
    maxSpeedMps: 50,
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
};
// Deliberately NOT `as const`: the calibration page writes through this object live
// (08 §5.4), and readonly literal types would make that a type error.

export type Config = typeof config;
