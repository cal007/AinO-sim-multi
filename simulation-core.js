// --- Config ---
const DEPT_NAMES = ["Sales", "Ops", "Finance", "Product"];
const MODES = {
  NORMAL: "Normal",
  TENSION: "Tension",
  CRISIS: "Crisis",
  RECOVERY: "Recovery",
  COOLDOWN: "Cooldown"
};

const SHOCK_PROFILES = {
  1: { realityDrift: [-0.05, -0.02], kpiDrop: [-0.04, -0.01], gamingSpike: 0.03, latencyBoost: 3,  shadowFreeze: true },
  2: { realityDrift: [-0.10, -0.04], kpiDrop: [-0.09, -0.03], gamingSpike: 0.07, latencyBoost: 6,  shadowFreeze: true },
  3: { realityDrift: [-0.18, -0.08], kpiDrop: [-0.18, -0.07], gamingSpike: 0.15, latencyBoost: 10, shadowFreeze: true }
};

// --- Seeded PRNG (mulberry32) ---
// Returns a stateless [0,1) float given a uint32 seed+counter.
// We thread a mutable `rngState` object through the simulation so
// every call to rand() advances it deterministically.
// makePRNG returns a plain serializable object {s: uint32}
// so it can safely pass through postMessage (structured clone).
export function makePRNG(seed) {
  return { s: seed >>> 0 };
}

// Advance the PRNG state and return a [0,1) float (mulberry32).
// Mutates rng.s in-place so the sequence is deterministic across ticks.
function rngNext(rng) {
  if (!rng) return Math.random();
  rng.s = (rng.s + 0x6D2B79F5) >>> 0;
  let t = Math.imul(rng.s ^ (rng.s >>> 15), 1 | rng.s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) >>> 0;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function rand(lo, hi, rng) {
  return lo + rngNext(rng) * (hi - lo);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const DEFAULT_CONFIG = {
  ticks: 720,
  gamingRate: 0.02,
  gamingDecay: { Normal: 0.01, Tension: 0.02, Crisis: 0.03 },
  shadowNoise: 0.02,
  thresholds: {
    tension: 0.25,
    crisis: 0.50,
    reEscalation: 2,
    latency: 14
  },
  shockDurationDays: 7,
  shockIntensity: 2,
  autoCrisisDaysForRecovery: 30,
  cooldownDays: 15,
  randomSeed: 42,          // default seed
  useRandomSeed: true      // when false → Math.random() (non-deterministic)
};

// --- Department init ---
export function initDept(name) {
  return {
    name,
    kpi: 0.5,
    reality: 0.5,
    gaming: 0,
    shadowMetric: 0.5,
    latency: 0,
    reEscalations: 0
  };
}

// --- Shared reality step ---
export function stepSharedReality(reality, shock, shockProfile, rng) {
  const [dlo, dhi] = shock ? shockProfile.realityDrift : [-0.03, 0.03];
  return clamp(reality + rand(dlo, dhi, rng), 0, 1);
}

// --- Baseline step ---
export function stepBaselineDept(dept, cfg, shock, shockProfile, baselineMode, sharedReality, rng) {
  const newReality = sharedReality;
  let newKpi, newGaming;

  if (baselineMode === "Recovery" || baselineMode === "Cooldown") {
    newKpi = clamp(dept.kpi + (newReality - dept.kpi) * 0.05 + rand(-0.03, 0.03, rng), 0, 1);
    newGaming = clamp(dept.gaming * 0.97, 0, 1);
  } else {
    const gamingPressure = 0.015 + dept.gaming * 0.01;
    newKpi = clamp(dept.kpi + gamingPressure + rand(-0.01, 0.01, rng), 0, 1);
    newGaming = clamp(dept.gaming + cfg.gamingRate, 0, 1);

    if (shock) {
      const [klo, khi] = shockProfile.kpiDrop;
      newKpi = clamp(newKpi + rand(klo, khi, rng), 0, 1);
      newGaming = clamp(newGaming + shockProfile.gamingSpike * 0.5, 0, 1);
    }

    const gap = newKpi - newReality;
    if (gap > 0.3) {
      newKpi = clamp(newKpi - gap * 0.04 + rand(-0.02, 0.02, rng), 0, 1);
      newGaming = clamp(newGaming * 0.98, 0, 1);
    }
  }

  return { ...dept, reality: newReality, kpi: newKpi, gaming: newGaming };
}

// --- AïnO step ---
export function stepAinoDept(dept, cfg, shock, shockProfile, mode, sharedReality, rng) {
  const newReality = sharedReality;
  let newShadow, newKpi, newGaming, newLatency, newReEsc;

  if (mode === "Recovery") {
    newKpi = clamp(newReality + rand(-0.05, 0.05, rng), 0, 1);
    newShadow = clamp(dept.shadowMetric + (newReality - dept.shadowMetric) * 0.30 + rand(-0.01, 0.01, rng), 0, 1);
    newGaming = clamp(dept.gaming * 0.85, 0, 1);
    newLatency = 0;
    newReEsc = 0;
  } else if (mode === "Cooldown") {
    newKpi = clamp(dept.kpi + (newReality - dept.kpi) * 0.10 + rand(-0.01, 0.01, rng), 0, 1);
    newShadow = clamp(dept.shadowMetric + (newReality - dept.shadowMetric) * 0.15 + rand(-0.005, 0.005, rng), 0, 1);
    newGaming = clamp(dept.gaming * 0.94, 0, 1);
    newLatency = 0;
    newReEsc = 0;
  } else {
    if (shock) {
      newShadow = clamp(dept.shadowMetric + rand(-0.005, 0.005, rng), 0, 1);
      const [klo, khi] = shockProfile.kpiDrop;
      newKpi = clamp(dept.kpi + rand(klo, khi, rng), 0, 1);
      newGaming = clamp(dept.gaming + shockProfile.gamingSpike, 0, 1);
      newLatency = dept.latency + 1 + shockProfile.latencyBoost;
      newReEsc = dept.reEscalations;
      const divergence = Math.abs(newKpi - newShadow);
      if (divergence > cfg.thresholds.tension && newLatency > cfg.thresholds.latency) {
        newReEsc++;
        newLatency = 0;
      }
    } else {
      const shadowNoise = rand(-cfg.shadowNoise, cfg.shadowNoise, rng);
      newShadow = clamp(newReality + shadowNoise, 0, 1);

      const modeFactors = {
        Normal:  { pressure: 1.0, decay: cfg.gamingDecay.Normal },
        Tension: { pressure: 0.6, decay: cfg.gamingDecay.Tension },
        Crisis:  { pressure: 0.3, decay: cfg.gamingDecay.Crisis }
      };
      const f = modeFactors[mode] || modeFactors.Normal;

      const gamingPressure = 0.015 * f.pressure + dept.gaming * 0.005 * f.pressure;
      newKpi = clamp(dept.kpi + gamingPressure + rand(-0.01, 0.01, rng), 0, 1);
      newGaming = clamp(dept.gaming + cfg.gamingRate - f.decay, 0, 1);

      const divergence = Math.abs(newKpi - newShadow);
      newLatency = dept.latency + 1;
      newReEsc = dept.reEscalations;

      if (divergence > cfg.thresholds.tension) {
        if (newLatency > cfg.thresholds.latency) {
          newReEsc++;
          newLatency = 0;
        }
      } else {
        newLatency = Math.max(0, dept.latency - 2);
        newReEsc = Math.max(0, dept.reEscalations - 0.05);
      }
    }
  }

  return {
    ...dept,
    reality: newReality,
    kpi: newKpi,
    gaming: newGaming,
    shadowMetric: newShadow,
    latency: newLatency,
    reEscalations: newReEsc
  };
}

// --- Mode logic ---
export function computeMode(depts, cfg) {
  const avgDiv =
    depts.reduce((s, d) => s + Math.abs(d.kpi - d.shadowMetric), 0) /
    depts.length;
  const maxReEsc = Math.max(...depts.map(d => d.reEscalations));

  if (avgDiv >= cfg.thresholds.crisis || maxReEsc >= cfg.thresholds.reEscalation)
    return MODES.CRISIS;
  if (avgDiv >= cfg.thresholds.tension)
    return MODES.TENSION;
  return MODES.NORMAL;
}

// --- Org health ---
export function computeOrgHealth(depts) {
  const avgDiv =
    depts.reduce((s, d) => s + Math.abs(d.kpi - d.reality), 0) / depts.length;
  const avgGaming = depts.reduce((s, d) => s + d.gaming, 0) / depts.length;
  return clamp(1 - avgDiv * 0.9 - avgGaming * 0.3, 0, 1);
}

// --- Apply recovery ---
export function applyRecoveryToAinoDepts(depts, rng) {
  return depts.map(d => ({
    ...d,
    kpi: d.kpi * 0.5 + d.reality * 0.5,
    gaming: d.gaming * 0.50,
    shadowMetric: d.shadowMetric + (d.reality - d.shadowMetric) * 0.5,
    latency: 0,
    reEscalations: 0
  }));
}

export function applyRecoveryToBaselineDepts(depts, rng) {
  return depts.map(d => ({
    ...d,
    kpi: d.kpi * 0.7 + d.reality * 0.3 + rand(-0.03, 0.03, rng),
    gaming: d.gaming * 0.75
  }));
}

// --- Initial state ---
export function createInitialState(cfg) {
  const sharedReality = DEPT_NAMES.map(() => 0.5);
  // Create a fresh PRNG from seed (or null for Math.random)
  const rng = (cfg && cfg.useRandomSeed) ? makePRNG(cfg.randomSeed) : null;
  return {
    tick: 0,
    sharedReality,
    baselineDepts: DEPT_NAMES.map(initDept),
    ainoDepts: DEPT_NAMES.map(initDept),
    mode: MODES.NORMAL,
    baselineMode: MODES.NORMAL,
    captureRisk: 0,
    shockActive: false,
    shockDaysRemaining: 0,
    crisisDayCount: 0,
    cooldownRemaining: 0,
    baselineCooldownRemaining: 0,
    graceRemaining: 0,
    crisisEventCount: 0,
    pendingIntervention: false,
    interventionDelayRemaining: 0,
    rng,   // carried in state so it advances deterministically tick-by-tick
    history: {
      baseHealth: [],
      ainoHealth: [],
      divergence: [],
      mode: [],
      interventionMarkers: [],
      recoveryHealthMarkers: []
    }
  };
}

// --- Tick ---
export function runTick(state, cfg) {
  if (state.tick >= cfg.ticks) return state;

  const shockProfile = SHOCK_PROFILES[cfg.shockIntensity] || SHOCK_PROFILES[2];
  const rng = state.rng; // may be null (non-deterministic)

  let shockActive = state.shockActive;
  let shockDaysRemaining = state.shockDaysRemaining;
  if (shockActive) {
    shockDaysRemaining--;
    if (shockDaysRemaining <= 0) {
      shockActive = false;
      shockDaysRemaining = 0;
    }
  }

  let currentMode = state.mode;
  let baselineMode = state.baselineMode;
  let crisisDayCount = state.crisisDayCount;
  let cooldownRemaining = state.cooldownRemaining;
  let baselineCooldownRemaining = state.baselineCooldownRemaining;
  let graceRemaining = state.graceRemaining;
  let crisisEventCount = state.crisisEventCount;
  let pendingIntervention = state.pendingIntervention;
  let interventionDelayRemaining = state.interventionDelayRemaining;
  const interventionMarkers = [...state.history.interventionMarkers];
  const recoveryHealthMarkers = [...state.history.recoveryHealthMarkers];

  if (pendingIntervention) {
    interventionDelayRemaining--;
    if (interventionDelayRemaining <= 0) {
      pendingIntervention = false;
      interventionDelayRemaining = 0;
      currentMode = MODES.RECOVERY;
      baselineMode = MODES.RECOVERY;
      crisisDayCount = 0;
      cooldownRemaining = cfg.cooldownDays;
      baselineCooldownRemaining = cfg.cooldownDays;
      graceRemaining = Math.floor(cfg.cooldownDays / 2);
      interventionMarkers.push(state.tick);
    }
  }

  const newSharedReality = state.sharedReality.map(r =>
    stepSharedReality(r, shockActive, shockProfile, rng)
  );

  let newAino = state.ainoDepts.map((d, i) =>
    stepAinoDept(d, cfg, shockActive, shockProfile, currentMode, newSharedReality[i], rng)
  );
  let newBaseline = state.baselineDepts.map((d, i) =>
    stepBaselineDept(d, cfg, shockActive, shockProfile, baselineMode, newSharedReality[i], rng)
  );

  if (currentMode === MODES.RECOVERY) {
    const bhSnap = computeOrgHealth(newBaseline);
    const ahSnap = computeOrgHealth(newAino);
    recoveryHealthMarkers.push({ tick: state.tick, baseHealth: bhSnap, ainoHealth: ahSnap });
    newAino = applyRecoveryToAinoDepts(newAino, rng);
    newBaseline = applyRecoveryToBaselineDepts(newBaseline, rng);
    currentMode = MODES.COOLDOWN;
    baselineMode = MODES.COOLDOWN;
  }

  let newMode, newBaselineMode;
  if (currentMode === MODES.COOLDOWN) {
    cooldownRemaining--;
    if (cooldownRemaining <= 0) {
      cooldownRemaining = 0;
      currentMode = MODES.NORMAL;
      newMode = MODES.NORMAL;
    } else {
      newMode = MODES.COOLDOWN;
    }
  } else {
    newMode = computeMode(newAino, cfg);
  }

  if (baselineMode === MODES.COOLDOWN) {
    baselineCooldownRemaining--;
    if (baselineCooldownRemaining <= 0) {
      baselineCooldownRemaining = 0;
      baselineMode = MODES.NORMAL;
      newBaselineMode = MODES.NORMAL;
    } else {
      newBaselineMode = MODES.COOLDOWN;
    }
  } else {
    newBaselineMode = MODES.NORMAL;
  }

  if (graceRemaining > 0) {
    graceRemaining--;
    if (newMode === MODES.CRISIS) newMode = MODES.TENSION;
  }

  if (newMode === MODES.CRISIS) {
    crisisDayCount++;
    if (crisisDayCount === 1) crisisEventCount++;
    if (crisisDayCount >= cfg.autoCrisisDaysForRecovery && !pendingIntervention) {
      const bhSnap = computeOrgHealth(newBaseline);
      const ahSnap = computeOrgHealth(newAino);
      recoveryHealthMarkers.push({ tick: state.tick, baseHealth: bhSnap, ainoHealth: ahSnap });
      newAino = applyRecoveryToAinoDepts(newAino, rng);
      newBaseline = applyRecoveryToBaselineDepts(newBaseline, rng);
      newMode = MODES.COOLDOWN;
      newBaselineMode = MODES.COOLDOWN;
      cooldownRemaining = cfg.cooldownDays;
      baselineCooldownRemaining = cfg.cooldownDays;
      graceRemaining = Math.floor(cfg.cooldownDays / 2);
      crisisDayCount = 0;
      interventionMarkers.push(state.tick);
    }
  } else {
    crisisDayCount = 0;
  }

  const maxReEsc = Math.max(...newAino.map(d => d.reEscalations));
  const riskDelta =
    newMode === MODES.CRISIS   ?  0.015 :
    newMode === MODES.TENSION  ?  0.005 :
    newMode === MODES.COOLDOWN ? -0.005 :
    newMode === MODES.NORMAL   ? -0.008 :
    0;
  const recoveryFiredThisTick = interventionMarkers.length > state.history.interventionMarkers.length;
  const recoveryBonus = recoveryFiredThisTick ? -state.captureRisk * 0.20 : 0;
  const newCapture = clamp(
    state.captureRisk + riskDelta + maxReEsc * 0.001 + recoveryBonus,
    0, 1
  );

  const bh = computeOrgHealth(newBaseline);
  const ah = computeOrgHealth(newAino);
  const div =
    newAino.reduce((s, d) => s + Math.abs(d.kpi - d.shadowMetric), 0) /
    newAino.length;

  const modeIntensity =
    newMode === MODES.NORMAL   ? 0.2 :
    newMode === MODES.TENSION  ? 0.6 :
    newMode === MODES.COOLDOWN ? 0.35 :
    newMode === MODES.RECOVERY ? 0.1 :
    1.0;

  return {
    ...state,
    tick: state.tick + 1,
    sharedReality: newSharedReality,
    baselineDepts: newBaseline,
    ainoDepts: newAino,
    mode: newMode,
    baselineMode: newBaselineMode,
    captureRisk: newCapture,
    shockActive,
    shockDaysRemaining,
    crisisDayCount,
    cooldownRemaining,
    baselineCooldownRemaining,
    graceRemaining,
    crisisEventCount,
    pendingIntervention,
    interventionDelayRemaining,
    rng,
    history: {
      baseHealth: [...state.history.baseHealth, bh],
      ainoHealth: [...state.history.ainoHealth, ah],
      divergence: [...state.history.divergence, div],
      mode: [...state.history.mode, modeIntensity],
      interventionMarkers,
      recoveryHealthMarkers
    }
  };
}
