// --- Config ---
const DEPT_NAMES = ["Sales", "Ops", "Finance", "Product"];
const MODES = {
  NORMAL: "Normal",
  TENSION: "Tension",
  CRISIS: "Crisis",
  RECOVERY: "Recovery",
  COOLDOWN: "Cooldown"
};

// --- Helpers ---
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rand = (lo, hi) => lo + Math.random() * (hi - lo);

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
  shockDurationDays: 7,        // shock lasts N simulation days (replaces shockDurationMs)
  autoCrisisDaysForRecovery: 30,
  cooldownDays: 15
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

// --- Shared reality step (same reality for both orgs) ---
export function stepSharedReality(reality, shock) {
  const drift = rand(-0.03, 0.03) + (shock ? rand(-0.15, -0.05) : 0);
  return clamp(reality + drift, 0, 1);
}

// --- Baseline step (receives shared reality) ---
export function stepBaselineDept(dept, cfg, shock, baselineMode, sharedReality) {
  const newReality = sharedReality;

  let newKpi, newGaming;

  if (baselineMode === "Recovery" || baselineMode === "Cooldown") {
    // Slower, noisier recovery — baseline doesn't know root cause
    newKpi = clamp(dept.kpi + (newReality - dept.kpi) * 0.05 + rand(-0.03, 0.03), 0, 1);
    newGaming = clamp(dept.gaming * 0.97, 0, 1);
  } else {
    const gamingPressure = 0.015 + dept.gaming * 0.01;
    newKpi = clamp(dept.kpi + gamingPressure + rand(-0.01, 0.01), 0, 1);
    newGaming = clamp(dept.gaming + cfg.gamingRate, 0, 1);

    // Baseline self-correction: when KPI diverges far from reality, slow noisy correction kicks in
    const gap = newKpi - newReality;
    if (gap > 0.3) {
      newKpi = clamp(newKpi - gap * 0.04 + rand(-0.02, 0.02), 0, 1);
      newGaming = clamp(newGaming * 0.98, 0, 1);
    }
  }

  return { ...dept, reality: newReality, kpi: newKpi, gaming: newGaming };
}

// --- AïnO step (receives shared reality) ---
export function stepAinoDept(dept, cfg, shock, mode, sharedReality) {
  const newReality = sharedReality;

  let newShadow, newKpi, newGaming, newLatency, newReEsc;

  if (mode === "Recovery") {
    // AïnO: precise fast reset — knows root cause via shadow data
    newKpi = clamp(newReality + rand(-0.05, 0.05), 0, 1);
    newShadow = clamp(dept.shadowMetric + (newReality - dept.shadowMetric) * 0.30 + rand(-0.01, 0.01), 0, 1);
    newGaming = clamp(dept.gaming * 0.85, 0, 1);
    newLatency = 0;
    newReEsc = 0;
  } else if (mode === "Cooldown") {
    // Steady convergence, trust rebuilding, no escalation
    newKpi = clamp(dept.kpi + (newReality - dept.kpi) * 0.10 + rand(-0.01, 0.01), 0, 1);
    newShadow = clamp(dept.shadowMetric + (newReality - dept.shadowMetric) * 0.15 + rand(-0.005, 0.005), 0, 1);
    newGaming = clamp(dept.gaming * 0.94, 0, 1);
    newLatency = 0;
    newReEsc = 0;
  } else {
    // Normal / Tension / Crisis
    if (shock) {
      // During shock: shadow lags behind reality to create divergence spike
      newShadow = clamp(dept.shadowMetric + rand(-0.005, 0.005), 0, 1);
    } else {
      const shadowNoise = rand(-cfg.shadowNoise, cfg.shadowNoise);
      newShadow = clamp(newReality + shadowNoise, 0, 1);
    }

    const modeFactors = {
      Normal:  { pressure: 1.0, decay: cfg.gamingDecay.Normal },
      Tension: { pressure: 0.6, decay: cfg.gamingDecay.Tension },
      Crisis:  { pressure: 0.3, decay: cfg.gamingDecay.Crisis }
    };
    const f = modeFactors[mode] || modeFactors.Normal;

    const gamingPressure = 0.015 * f.pressure + dept.gaming * 0.005 * f.pressure;
    newKpi = clamp(dept.kpi + gamingPressure + rand(-0.01, 0.01), 0, 1);
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

// --- Mode logic (only for Normal/Tension/Crisis) ---
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

// --- Apply recovery to AïnO departments (precise, fast — knows root cause) ---
export function applyRecoveryToAinoDepts(depts) {
  return depts.map(d => ({
    ...d,
    kpi: d.kpi * 0.5 + d.reality * 0.5,
    gaming: d.gaming * 0.50,
    shadowMetric: d.shadowMetric + (d.reality - d.shadowMetric) * 0.5,
    latency: 0,
    reEscalations: 0
  }));
}

// --- Apply recovery to Baseline departments (slow, noisy — blind to root cause) ---
export function applyRecoveryToBaselineDepts(depts) {
  return depts.map(d => ({
    ...d,
    kpi: d.kpi * 0.7 + d.reality * 0.3 + rand(-0.03, 0.03),
    gaming: d.gaming * 0.75
  }));
}

// --- Initial state ---
export function createInitialState() {
  const sharedReality = DEPT_NAMES.map(() => 0.5);
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
    history: {
      baseHealth: [],
      ainoHealth: [],
      divergence: [],
      mode: [],
      interventionMarkers: []
    }
  };
}

// --- Tick ---
export function runTick(state, cfg) {
  if (state.tick >= cfg.ticks) return state;

  // --- Shock duration management (in simulation days) ---
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

  // --- Handle pending manual intervention countdown ---
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

  // --- Step shared reality (same for both orgs) ---
  const newSharedReality = state.sharedReality.map(r =>
    stepSharedReality(r, shockActive)
  );

  // --- Step departments (both receive same shared reality) ---
  let newAino = state.ainoDepts.map((d, i) =>
    stepAinoDept(d, cfg, shockActive, currentMode, newSharedReality[i])
  );
  let newBaseline = state.baselineDepts.map((d, i) =>
    stepBaselineDept(d, cfg, shockActive, baselineMode, newSharedReality[i])
  );

  // --- Apply recovery snap on first Recovery tick ---
  if (currentMode === MODES.RECOVERY) {
    newAino = applyRecoveryToAinoDepts(newAino);
    newBaseline = applyRecoveryToBaselineDepts(newBaseline);
    currentMode = MODES.COOLDOWN;
    baselineMode = MODES.COOLDOWN;
  }

  // --- Manage Cooldown countdown ---
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

  // --- Grace period: block Crisis escalation ---
  if (graceRemaining > 0) {
    graceRemaining--;
    if (newMode === MODES.CRISIS) newMode = MODES.TENSION;
  }

  // --- Auto-recovery: if Crisis persists for N days ---
  if (newMode === MODES.CRISIS) {
    crisisDayCount++;
    if (crisisDayCount === 1) crisisEventCount++;
    if (crisisDayCount >= cfg.autoCrisisDaysForRecovery && !pendingIntervention) {
      newAino = applyRecoveryToAinoDepts(newAino);
      newBaseline = applyRecoveryToBaselineDepts(newBaseline);
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

  // --- Capture risk: mode-gated decay (Option A) + recovery event bonus (Option B) ---
  const maxReEsc = Math.max(...newAino.map(d => d.reEscalations));
  const riskDelta =
    newMode === MODES.CRISIS   ?  0.015 :
    newMode === MODES.TENSION  ?  0.005 :
    newMode === MODES.COOLDOWN ? -0.005 :
    newMode === MODES.NORMAL   ? -0.008 :
    0;
  // Option B bonus: if a recovery just fired this tick, extra -20% instant reduction
  const recoveryFiredThisTick = interventionMarkers.length > state.history.interventionMarkers.length;
  const recoveryBonus = recoveryFiredThisTick ? -state.captureRisk * 0.20 : 0;
  const newCapture = clamp(
    state.captureRisk + riskDelta + maxReEsc * 0.001 + recoveryBonus,
    0, 1
  );

  // --- Health & divergence ---
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
    1.0; // Crisis

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
    history: {
      baseHealth: [...state.history.baseHealth, bh],
      ainoHealth: [...state.history.ainoHealth, ah],
      divergence: [...state.history.divergence, div],
      mode: [...state.history.mode, modeIntensity],
      interventionMarkers
    }
  };
}
