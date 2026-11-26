/* Stratos takeoff and landing estimate, for simulator planning.
 *
 * A compact physics model, not an AFM: it scales the profile's published
 * approach speed (1.3 Vs at MLW) into stall speeds, accelerates the aircraft
 * with a type thrust-to-weight ratio, and resolves the field lengths:
 *
 *   Takeoff  V1/VR/V2, all-engine and engine-out distance to 35 ft,
 *            accelerate-stop, balanced V1, the best flap setting and the
 *            highest assumed (FLEX) temperature that still fits the runway.
 *   Landing  VREF/VLS and VAPP, air distance, ground roll by autobrake and
 *            surface, the 1.15 in-flight factor and the runway margin.
 *
 * Wind is factored as the regulations do (50 % of headwind, 150 % of tailwind).
 * Every figure is an estimate; the page labels it so.
 */

const G = 9.80665;
const KT = 0.514444; // m/s per knot
const FT = 0.3048;

/* Per-type takeoff data, so no aircraft goes through one generic formula.
   spd: V1/VR/V2 (KIAS) per flap setting at refKg, sea level; speeds scale with sqrt(W/refKg).
   kN: rated thrust per engine. vmcg/vmca: minimum control speeds. ld: lift/drag per flap (2nd segment).
   Typical FCOM-style figures for simulator planning, not certified data. */
const TYPES = {
  A319: { refKg: 64000, eng: 2, kN: 105, vmcg: 108, vmca: 113, spd: { '1+F': [136, 138, 142], 2: [131, 133, 137], 3: [127, 129, 133] }, ld: [12, 11, 10] },
  A320: { refKg: 70000, eng: 2, kN: 120, vmcg: 109, vmca: 114, spd: { '1+F': [144, 146, 150], 2: [139, 141, 145], 3: [135, 137, 141] }, ld: [12, 11, 10] },
  A20N: { refKg: 73000, eng: 2, kN: 121, vmcg: 109, vmca: 114, spd: { '1+F': [146, 148, 152], 2: [141, 143, 147], 3: [137, 139, 143] }, ld: [12.5, 11.5, 10.5] },
  A321: { refKg: 89000, eng: 2, kN: 147, vmcg: 112, vmca: 117, spd: { '1+F': [155, 158, 162], 2: [150, 153, 157], 3: [146, 149, 153] }, ld: [12, 11, 10] },
  A21N: { refKg: 93000, eng: 2, kN: 147, vmcg: 112, vmca: 117, spd: { '1+F': [154, 157, 161], 2: [149, 152, 156], 3: [145, 148, 152] }, ld: [12.5, 11.5, 10.5] },
  A339: { refKg: 240000, eng: 2, kN: 320, vmcg: 120, vmca: 124, spd: { '1+F': [150, 155, 160], 2: [146, 150, 155], 3: [142, 146, 151] }, ld: [13, 12, 11] },
  A346: { refKg: 365000, eng: 4, kN: 249, vmcg: 113, vmca: 118, spd: { '1+F': [152, 160, 166], 2: [148, 155, 161], 3: [144, 151, 157] }, ld: [11, 10.5, 10] },
  A359: { refKg: 275000, eng: 2, kN: 375, vmcg: 118, vmca: 122, spd: { '1+F': [150, 155, 160], 2: [146, 151, 156], 3: [142, 147, 152] }, ld: [14, 13, 12] },
  A388: { refKg: 560000, eng: 4, kN: 311, vmcg: 115, vmca: 120, spd: { '1+F': [150, 155, 161], 2: [146, 151, 157], 3: [142, 147, 153] }, ld: [12, 11.5, 11] },
  B738: { refKg: 79000, eng: 2, kN: 117, vmcg: 107, vmca: 112, spd: { 1: [156, 160, 165], 5: [151, 155, 160], 15: [146, 150, 155] }, ld: [12, 11.5, 10.5] },
  B38M: { refKg: 82000, eng: 2, kN: 130, vmcg: 108, vmca: 113, spd: { 1: [157, 161, 166], 5: [152, 156, 161], 15: [147, 151, 156] }, ld: [12.5, 12, 11] },
  B772: { refKg: 290000, eng: 2, kN: 418, vmcg: 120, vmca: 124, spd: { 5: [160, 166, 172], 15: [154, 160, 166], 20: [151, 157, 163] }, ld: [13, 12, 11] },
  B77L: { refKg: 340000, eng: 2, kN: 489, vmcg: 122, vmca: 126, spd: { 5: [166, 172, 178], 15: [160, 166, 172], 20: [157, 163, 169] }, ld: [13, 12, 11] },
  B77W: { refKg: 345000, eng: 2, kN: 513, vmcg: 124, vmca: 128, spd: { 5: [167, 174, 180], 15: [161, 168, 174], 20: [158, 165, 171] }, ld: [13, 12, 11] },
  B789: { refKg: 250000, eng: 2, kN: 320, vmcg: 118, vmca: 122, spd: { 5: [158, 164, 169], 15: [153, 158, 164], 20: [150, 155, 161] }, ld: [14, 13, 12] },
};
// Minimum second-segment gradient, engine out (CS/FAR 25.121).
const MIN_GRADIENT = { 2: 2.4, 3: 2.7, 4: 3.0 };
export const typeData = profile => TYPES[profile.icao] || null;

// Takeoff flaps: stall speed relative to the landing configuration, and extra drag (fraction of weight).
const TAKEOFF_FLAPS = {
  airbus: [{ id: '1+F', vs: 1.18, drag: 0 }, { id: '2', vs: 1.13, drag: 0.006 }, { id: '3', vs: 1.09, drag: 0.012 }],
  b737: [{ id: '1', vs: 1.2, drag: 0 }, { id: '5', vs: 1.14, drag: 0.005 }, { id: '15', vs: 1.09, drag: 0.011 }],
  boeing: [{ id: '5', vs: 1.16, drag: 0 }, { id: '15', vs: 1.11, drag: 0.006 }, { id: '20', vs: 1.08, drag: 0.011 }],
};
// Landing flaps: VREF factor against the normal landing setting the profile's speed is published for.
const LANDING_FLAPS = {
  airbus: [{ id: 'FULL', f: 1 }, { id: '3', f: 1.035 }],
  b737: [{ id: '30', f: 1 }, { id: '40', f: 0.975 }],
  boeing: [{ id: '30', f: 1 }, { id: '25', f: 1.03 }],
};
// Autobrake target deceleration, m/s².
const AUTOBRAKES = {
  airbus: [['LO', 1.7], ['MED', 3.0], ['MAX', 4.0]],
  boeing: [['1', 1.22], ['2', 1.52], ['3', 2.19], ['4', 2.74], ['MAX', 3.66]],
};
const SURFACE_DECEL = { dry: 4.4, wet: 2.4 }; // the most the surface gives, m/s²
const RTO_DECEL = { dry: 3.0, wet: 2.0 }; // max braking, reversers not credited

export function family(profile) {
  if (/airbus/i.test(profile.manufacturer)) return 'airbus';
  return /^B73|^B3/.test(profile.icao) ? 'b737' : 'boeing';
}
export const takeoffFlaps = profile => TAKEOFF_FLAPS[family(profile)];
export const landingFlaps = profile => LANDING_FLAPS[family(profile)];
export const autobrakes = profile => AUTOBRAKES[family(profile) === 'airbus' ? 'airbus' : 'boeing'];

const isaC = paFt => 15 - 1.98 * (paFt / 1000);
const pressureRatio = paFt => Math.pow(1 - 6.8756e-6 * paFt, 5.2559);
const densityRatio = (paFt, oatC) => pressureRatio(paFt) * 288.15 / (oatC + 273.15);
const tas = (kias, paFt, oatC) => kias * KT / Math.sqrt(densityRatio(paFt, oatC));

// Flat-rated thrust: full up to ISA+15, then about 0.85 % less per degree.
function thrustFactor(paFt, tempC) {
  const flat = isaC(paFt) + 15;
  return Math.pow(pressureRatio(paFt), 0.8) * (tempC <= flat ? 1 : Math.max(0.3, 1 - 0.0085 * (tempC - flat)));
}
// Regulatory wind: half the headwind, one and a half times the tailwind.
const factoredWind = hw => (hw >= 0 ? 0.5 * hw : 1.5 * hw) * KT;

/** VREF at a weight from the profile's approach speed (1.3 Vs at MLW). */
function stallLanding(profile, weightKg) {
  return (profile.landing.vrefKt / 1.3) * Math.sqrt(weightKg / profile.limits.mlwKg);
}

const speedLapse = kt => 1 - 0.0012 * kt; // turbofan thrust falls with speed

function takeoffRun(profile, input, flap, tempC) {
  const type = typeData(profile);
  if (!type) return null;
  const { weightKg, paFt, headwindKt = 0, surface = 'dry' } = input;
  const fi = takeoffFlaps(profile).findIndex(f => f.id === flap.id);
  const [refV1, refVr, refV2] = type.spd[flap.id];
  const k = Math.sqrt(weightKg / type.refKg);
  // VR/V2 scale with weight but never below the control-speed limits.
  const vr = Math.round(Math.max(refVr * k, 1.05 * type.vmca));
  const v2 = Math.round(Math.max(refV2 * k, 1.1 * type.vmca, vr + 4));
  const vlof = vr + 5;
  const weightN = weightKg * G;
  const staticN = type.eng * type.kN * 1000 * thrustFactor(paFt, tempC);
  const roll = staticN * speedLapse(0.7 * vlof) / weightN; // mean thrust/weight over the roll
  const resist = (surface === 'wet' ? 0.025 : 0.02) + 0.03 + flap.drag;
  const aAeo = G * (roll - resist);
  const aOei = G * (roll * (type.eng - 1) / type.eng - resist);
  if (aAeo <= 0.3 || aOei <= 0.05) return null;
  // Second segment: engine out, gear up, at V2.
  const gradient = 100 * ((staticN * (type.eng - 1) / type.eng) * speedLapse(v2) / weightN - 1 / type.ld[fi]);
  const w = factoredWind(headwindKt);
  const gs = kias => Math.max(1, tas(kias, paFt, tempC) - w);
  const run = (v, a) => (gs(v) ** 2) / (2 * a);
  const todAeo = run(vlof, aAeo) + gs(vlof) * 3;
  const options = [];
  const v1Low = Math.min(vr, Math.max(type.vmcg, Math.round(refV1 * k) - 20));
  for (let v1 = vr; v1 >= v1Low; v1 -= 1) {
    const agd = run(v1, aAeo) + (gs(vlof) ** 2 - gs(v1) ** 2) / (2 * aOei) + gs(vlof) * 5;
    const asd = run(v1, aAeo) + gs(v1) * 3 + (gs(v1) ** 2) / (2 * RTO_DECEL[surface]);
    options.push({ v1, agd, todr: Math.max(1.15 * todAeo, agd), asdr: asd });
  }
  // Balanced V1: the one that makes the longer of the two distances shortest.
  const best = options.reduce((a, b) => (Math.max(b.todr, b.asdr) < Math.max(a.todr, a.asdr) ? b : a));
  return {
    v1: best.v1, vr, v2, vlof, gradient,
    todrM: best.todr, asdrM: best.asdr, agdM: best.agd,
    v1M: run(best.v1, aAeo), vrM: run(vr, aAeo), liftoffM: run(vlof, aAeo),
  };
}

/* The heaviest TOGA weight each limit allows with this flap: runway (field
   length), climb (2nd segment) and structural MTOW. The lowest one governs. */
function weightLimits(profile, input, flap, minGrad, toraM) {
  const heaviest = test => {
    let lo = profile.limits.mtowKg * 0.4, hi = profile.limits.mtowKg * 1.5;
    if (!test(lo)) return null;
    for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (test(mid)) lo = mid; else hi = mid; }
    return Math.floor(lo / 100) * 100;
  };
  const runAt = kg => takeoffRun(profile, { ...input, weightKg: kg }, flap, input.oatC);
  const runwayKg = toraM ? heaviest(kg => { const r = runAt(kg); return !!r && r.todrM <= toraM && r.asdrM <= toraM; }) : null;
  const climbKg = heaviest(kg => { const r = runAt(kg); return !!r && r.gradient >= minGrad; });
  const limits = { structural: profile.limits.mtowKg, runway: runwayKg ?? (toraM ? 0 : null), climb: climbKg ?? 0 };
  const known = Object.entries(limits).filter(([, kg]) => kg != null);
  const [limitedBy, maxTowKg] = known.reduce((a, b) => (b[1] < a[1] ? b : a));
  return { maxTowKg, limitedBy, limits };
}

/**
 * input: { weightKg, paFt, oatC, headwindKt, toraFt, surface: 'dry'|'wet', flaps: 'auto'|id, thrust: 'auto'|'toga' }
 * -> { flaps, thrust: 'FLEX'|'TOGA', flexC, v1, vr, v2, todrFt, asdrFt, ...positions, fits, marginFt }
 */
export function estimateTakeoff(profile, input) {
  const toraM = (input.toraFt || 0) * FT;
  const chosenFlap = takeoffFlaps(profile).filter(f => f.id === input.flaps);
  // Auto picks the setting with the highest FLEX; with no runway length there is nothing to optimise.
  const flaps = chosenFlap.length ? chosenFlap : toraM ? takeoffFlaps(profile) : takeoffFlaps(profile).slice(0, 1);
  const minGrad = MIN_GRADIENT[(typeData(profile) || { eng: 2 }).eng];
  const fits = r => !!r && r.gradient >= minGrad && (!toraM || (r.todrM <= toraM && r.asdrM <= toraM));
  const topTemp = Math.min(75, isaC(input.paFt) + 60);
  let chosen = null;
  for (const [index, flap] of flaps.entries()) {
    const toga = takeoffRun(profile, input, flap, input.oatC);
    let option = { flap, flexC: null, run: toga };
    if (input.thrust !== 'toga' && toraM && fits(toga)) {
      // Highest assumed temperature that still fits, no more than 25 % below full thrust.
      const full = thrustFactor(input.paFt, input.oatC);
      for (let t = Math.ceil(Math.max(input.oatC + 1, isaC(input.paFt) + 15)); t <= topTemp; t += 1) {
        if (thrustFactor(input.paFt, t) < 0.75 * full) break;
        const run = takeoffRun(profile, input, flap, t);
        if (!fits(run)) break;
        option = { flap, flexC: t, run };
      }
    }
    // Highest FLEX wins; at equal FLEX the least flap (less drag, better climb), and a runway that does not fit takes the shortest.
    const score = o => (fits(o.run) ? 1e6 - index : -Math.max(o.run ? o.run.todrM : 1e9, o.run ? o.run.asdrM : 1e9) / 100) + (o.flexC ?? -100) * 100;
    if (!chosen || score(option) > score(chosen)) chosen = option;
  }
  if (!chosen || !chosen.run) return null;
  const { run } = chosen;
  const neededM = Math.max(run.todrM, run.asdrM);
  return {
    flaps: chosen.flap.id,
    thrust: chosen.flexC != null ? 'FLEX' : 'TOGA',
    flexC: chosen.flexC,
    v1: run.v1, vr: run.vr, v2: run.v2,
    todrFt: Math.round(run.todrM / FT), asdrFt: Math.round(run.asdrM / FT),
    v1Ft: Math.round(run.v1M / FT), vrFt: Math.round(run.vrM / FT), liftoffFt: Math.round(run.liftoffM / FT),
    agdFt: Math.round(run.agdM / FT),
    requiredFt: Math.round(neededM / FT),
    gradientPct: Math.round(run.gradient * 10) / 10, minGradientPct: minGrad,
    ...weightLimits(profile, input, chosen.flap, minGrad, toraM),
    fits: fits(run),
    marginFt: toraM ? Math.round((toraM - neededM) / FT) : null,
  };
}

/**
 * input: { weightKg, paFt, oatC, headwindKt, gustKt, windKt, ldaFt, surface, flaps, autobrake }
 * -> { flaps, autobrake, vref, vapp, airFt, touchdownFt, stopFt, factoredFt, marginFt, fits }
 */
export function estimateLanding(profile, input) {
  const fam = family(profile);
  const flap = landingFlaps(profile).find(f => f.id === input.flaps) || landingFlaps(profile)[0];
  const brakes = autobrakes(profile);
  const brake = brakes.find(([id]) => id === input.autobrake) || brakes[Math.min(1, brakes.length - 1)];
  const { weightKg, paFt, oatC, headwindKt = 0, gustKt = 0, windKt = 0, surface = 'dry' } = input;
  const vref = Math.round(stallLanding(profile, weightKg) * 1.3 * flap.f);
  const steadyHead = Math.max(0, headwindKt);
  const gustExcess = Math.max(0, (gustKt || 0) - (windKt || 0));
  const additive = fam === 'airbus'
    ? Math.max(5, Math.min(15, steadyHead / 3))
    : Math.max(5, Math.min(20, steadyHead / 2 + gustExcess));
  const vapp = Math.round(vref + additive);
  const w = factoredWind(headwindKt);
  const gs = kias => Math.max(1, tas(kias, paFt, oatC) - w);
  const airM = 300 * (gs(vapp) / (140 * KT)); // 50 ft over the threshold to touchdown
  const td = gs(vapp - 4);
  const decel = Math.min(brake[1], SURFACE_DECEL[surface]);
  const rollM = td * 2 + (td ** 2) / (2 * decel);
  const stopM = airM + rollM;
  const factoredM = stopM * 1.15;
  const ldaM = (input.ldaFt || 0) * FT;
  return {
    flaps: flap.id, autobrake: brake[0],
    vref, vapp, additive: Math.round(additive),
    airFt: Math.round(airM / FT), touchdownFt: Math.round(airM / FT),
    stopFt: Math.round(stopM / FT), factoredFt: Math.round(factoredM / FT),
    marginFt: ldaM ? Math.round((ldaM - factoredM) / FT) : null,
    fits: !ldaM || factoredM <= ldaM,
  };
}
