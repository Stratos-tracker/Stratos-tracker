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

// Type thrust-to-weight at MTOW (static, sea level) and engine count.
const TYPES = {
  A319: { tw: 0.33, engines: 2 }, A320: { tw: 0.31, engines: 2 }, A20N: { tw: 0.31, engines: 2 },
  A321: { tw: 0.28, engines: 2 }, A21N: { tw: 0.29, engines: 2 }, A339: { tw: 0.27, engines: 2 },
  A359: { tw: 0.28, engines: 2 }, A346: { tw: 0.25, engines: 4 }, A388: { tw: 0.23, engines: 4 },
  B738: { tw: 0.30, engines: 2 }, B38M: { tw: 0.31, engines: 2 }, B772: { tw: 0.29, engines: 2 },
  B77L: { tw: 0.30, engines: 2 }, B77W: { tw: 0.29, engines: 2 }, B789: { tw: 0.28, engines: 2 },
};

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

function takeoffRun(profile, input, flap, tempC) {
  const type = TYPES[profile.icao] || { tw: 0.29, engines: 2 };
  const { weightKg, paFt, headwindKt = 0, surface = 'dry' } = input;
  const vs = stallLanding(profile, weightKg) * flap.vs;
  const v2 = Math.round(vs * 1.13);
  const vr = v2 - 4;
  const vlof = vr + 6;
  const thrust = type.tw * (profile.limits.mtowKg / weightKg) * thrustFactor(paFt, tempC) * 0.8;
  const resist = 0.02 + 0.03 + flap.drag;
  const aAeo = G * (thrust - resist);
  const aOei = G * (thrust * (type.engines - 1) / type.engines - resist);
  if (aAeo <= 0.3 || aOei <= 0.05) return null;
  const w = factoredWind(headwindKt);
  const gs = kias => Math.max(1, tas(kias, paFt, tempC) - w);
  const run = (v, a) => (gs(v) ** 2) / (2 * a);
  const todAeo = run(vlof, aAeo) + gs(vlof) * 3;
  const todrAeo = 1.15 * todAeo;
  const options = [];
  for (let v1 = vr; v1 >= vr - 25; v1 -= 1) {
    const todOei = run(v1, aAeo) + (gs(vlof) ** 2 - gs(v1) ** 2) / (2 * aOei) + gs(vlof) * 5;
    const asd = run(v1, aAeo) + gs(v1) * 3 + (gs(v1) ** 2) / (2 * RTO_DECEL[surface]);
    options.push({ v1, todr: Math.max(todrAeo, todOei), asdr: asd });
  }
  // Balanced V1: the one that makes the longer of the two distances shortest.
  const best = options.reduce((a, b) => (Math.max(b.todr, b.asdr) < Math.max(a.todr, a.asdr) ? b : a));
  return {
    v1: best.v1, vr, v2, vlof,
    todrM: best.todr, asdrM: best.asdr,
    v1M: run(best.v1, aAeo), vrM: run(vr, aAeo), liftoffM: run(vlof, aAeo),
  };
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
  const fits = r => r && (!toraM || (r.todrM <= toraM && r.asdrM <= toraM));
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
    requiredFt: Math.round(neededM / FT),
    fits: fits(run) !== false,
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
