/**
 * The contact-pair model (02 §5, audit 14 PHY-01/PHY-02).
 *
 * ## Why this file exists
 *
 * Friction and restitution are **pair** properties: there is no such thing as "the
 * friction of tungsten", only "the friction of tungsten *on ice*". Rapier stores one
 * scalar per collider and combines the two with a rule, so a pair table cannot be
 * expressed directly — and Rapier 0.19.3's JavaScript bindings expose only contact-pair
 * *filtering* (`ActiveHooks.FILTER_CONTACT_PAIRS`), never solver-contact modification, so
 * there is no hook to override a coefficient per pair either. Verified against the
 * installed `pipeline/physics_hooks.d.ts`, not against the website.
 *
 * ## The model
 *
 * A **separable** (rank-one) pair model, which is the standard way to expand a pair table
 * from two marginals:
 *
 *     mu(metal, surface) = mu_metal * mu_surface / MU_REF_PAIR
 *     e (metal, surface) = e_metal  * e_surface  / E_REF_PAIR
 *
 * where the stored numbers mean exactly this, and nothing else:
 *
 * | value                | meaning                                                     | kind |
 * | -------------------- | ----------------------------------------------------------- | ---- |
 * | `MetalSpec.friction` | kinetic mu of this metal against the REFERENCE METAL         | pair |
 * | `SurfaceSpec.friction` | kinetic mu of the REFERENCE METAL against this surface     | pair |
 * | `MetalSpec.restitution` | CoR of this metal against the REFERENCE SURFACE           | pair |
 * | `SurfaceSpec.restitution` | CoR of the REFERENCE METAL against this surface        | pair |
 *
 * Both tables quote the same reference pair, so the product double-counts it once; the
 * `_REF_PAIR` divisor removes it. That is the whole trick, and it makes the model exact
 * on the reference row and column rather than approximate everywhere.
 *
 * The reference pair is hardened ferrous metal on hardened ferrous metal / on a thick
 * steel plate — the anchor 02 §5 already quotes its published numbers against
 * ("steel-on-steel CoR 0.6–0.7 at ~1 m/s"; "friction steel-steel mu_k 0.4").
 *
 * ## What is fitted and what is measured
 *
 * The numbers in `metals.ts` / `surfaces.ts` are **material-pair properties** taken from
 * engineering tables. The numbers handed to Rapier are **fitted solver parameters**:
 * `factor()` below is the square root that makes Rapier's `Multiply` combine rule
 * reproduce the model above. Nothing outside this module should ever see a factor, and
 * nothing inside `data/` should ever see Rapier.
 *
 * ## Declared limits
 *
 * - Rapier's contact model has **no static/kinetic distinction** — one coefficient does
 *   both. Every `friction` here is therefore a *kinetic* coefficient, and stiction is not
 *   modelled. A block on a shallow ramp will creep where a real one would hold.
 * - Restitution is **speed-independent** in Rapier. Real metal CoR falls as impact speed
 *   rises. See `docs/14` for why the speed-scaled model that `02 §5` used to claim was
 *   removed rather than faked.
 * - The separable form cannot represent a pair that breaks rank one — e.g. a surface that
 *   grips one metal but not another for chemical rather than geometric reasons.
 */

/**
 * mu_k, reference metal on reference metal: dry, machined, air-oxidised, unlubricated.
 * 02 §5 quotes steel-on-steel mu_k 0.4; every metal in the table sits at 0.45, which is
 * inside the published spread for machined ferrous pairs and is what the app has always
 * used. It is NOT changed here — only given a definition.
 */
export const MU_REF_PAIR = 0.45;

/**
 * CoR, reference metal on the reference surface (thick steel plate), flat face, low
 * speed. 02 §5 quotes steel-on-steel 0.6–0.7 at ~1 m/s; `METALS.Fe.restitution` and
 * `SURFACES.steel.restitution` are both 0.6, so the model is exact at that anchor.
 */
export const E_REF_PAIR = 0.6;

/**
 * The per-collider number Rapier needs so that its `Multiply` rule reproduces the model.
 *
 * `factor(a) * factor(b) = a * b / ref`, so both colliders can be configured
 * independently — which is the only thing Rapier lets us do — while the *pair* still
 * comes out right.
 */
export function factor(coefficient: number, refPair: number): number {
  return coefficient / Math.sqrt(refPair);
}

/** Kinetic friction of a (metal, surface) pair. The value a slide test should measure. */
export function pairFriction(metalMu: number, surfaceMu: number): number {
  return (metalMu * surfaceMu) / MU_REF_PAIR;
}

/** Coefficient of restitution of a (metal, surface) pair. What a drop test should measure. */
export function pairRestitution(metalE: number, surfaceE: number): number {
  return (metalE * surfaceE) / E_REF_PAIR;
}

/** Kinetic friction of a (metal, metal) pair — two cubes sliding on each other. */
export function pairFrictionMetals(a: number, b: number): number {
  return (a * b) / MU_REF_PAIR;
}

/** CoR of a (metal, metal) pair — one cube landing on another. */
export function pairRestitutionMetals(a: number, b: number): number {
  return (a * b) / E_REF_PAIR;
}
