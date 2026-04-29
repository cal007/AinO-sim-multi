// --- Config ---
const DEPT_NAMES = ["Sales", "Ops", "Finance", "Product"];
const MODES = { NORMAL: "Normal", TENSION: "Tension", CRISIS: "Crisis", RECOVERY: "Recovery", COOLDOWN: "Cooldown" };

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
  shockDurationMs: 150,
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

// --- Baseline step ---
export function stepBaselineDept(dept, cfg, shock) {
  const realityDrift = rand(-0.03, 0.03) + (shock ? rand(-0.15, -0.05) : 0);
  const newReality = clamp(dept.reality + realityDrift, 0, 1);

  const gamingPressure = 0.015 + dept.gaming * 0.01;
  const newKpi = clamp(dept.kpi + gamingPressure + rand(-0.01, 0.01), 0, 1);

  const newGaming = clamp(dept.gaming + cfg.gamingRate, 0, 1);

  return { ...dept, reality: newReality, kpi: newKpi, gaming: newGaming };
}

// --- AïnO step ---
export function stepAinoDept(dept, cfg, shock, mode) {
  const realityDrift = rand(-0.03, 0.03) + (shock ? rand(-0.15, -0.05) : 0);
  const newReality = clamp(dept.reality + realityDrift, 0, 1);

  // KEY FIX: During shock, shadow does NOT immediately follow reality.
  // Shadow stays near its previous value (with small noise only),
  // while reality drops sharply -> creates real divergence spike.
  let newShadow;
  if (shock) {
    // Shadow lags: stays near previous value with tiny noise
    newShadow = clamp(dept.shadowMetric + rand(-0.01, 0.01), 0, 1);
  } else {
    const shadowNoise = rand(-cfg.shadowNoise, cfg.shadowNoise);
    newShadow = clamp(newReality + shadowNoise, 0, 1);
  }

  // Cooldown mode: reduce gaming, reduce noise, prevent escalation, rebuild trust
  if (mode === "Cooldown") {
    const newGaming = clamp(dept.gaming * 0.97, 0, 1);
    const newKpi = clamp(dept.kpi - 0.002 + rand(-0.005, 0.005), 0, 1);
    return {
      ...dept,
      reality: newReality,
      kpi: newKpi,
      gaming: newGaming,
      shadowMetric: newShadow,
      latency: 0,
      reEscalations: Math.max(0, dept.reEscalations - 0.1)
    };
  }

  const modeFactors = {
    Normal:   { pressure: 1.0, decay: cfg.gamingDecay.Normal },
    Tension:  { pressure: 0.6, decay: cfg.gamingDecay.Tension },
    Crisis:   { pressure: 0.3, decay: cfg.gamingDecay.Crisis },
    Recovery: { pressure: 0.2, decay: cfg.gamingDecay.Crisis }
  };
  const f = modeFactors[mode] || modeFactors.Normal;

  const gamingPressure = 0.015 * f.pressure + dept.gaming * 0.005 * f.pressure;
  const newKpi = clamp(dept.kpi + gamingPressure + rand(-0.01, 0.01), 0, 1);
  const newGaming = clamp(dept.gaming + cfg.gamingRate - f.decay, 0, 1);

  // Latency & re-escalations (blocked in Recovery/Cooldown)
  const divergence = Math.abs(newKpi - newShadow);
  let newLatency = dept.latency + 1;
  let newReEsc = dept.reEscalations;

  if (mode !== "Recovery") {
    if (divergence > cfg.thresholds.tension) {
      if (newLatency > cfg.thresholds.latency) {
        newReEsc++;
        newLatency = 0;
      }
    } else {
      newLatency = 0;
    }
  } else {
    newLatency = 0;
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
export function computeMode(depts, cfg, prevMode) {
  // Cooldown and Recovery are managed externally
  if (prevMode === "Cooldown" || prevMode === "Recovery") return prevMode;

  const avgDiv =
    depts.reduce((s, d) => s + Math.abs(d.kpi - d.shadowMetric), 0) /
    depts.length;

  const maxReEsc = Math.max(...depts.map(d => d.reEscalations));

  if (avgDiv >= cfg.thresholds.crisis || maxReEsc >= cfg.thresholds.reEscalation)
    return MODES.CRISIS;

  if (avgDiv >= cfg.thresholds.tension) return MODES.TENSION;

  return MODES.NORMAL;
}

// --- Org health ---
export function computeOrgHealth(depts) {
  const avgDiv =
    depts.reduce((s, d) => s + Math.abs(d.kpi - d.reality), 0) / depts.length;
  const avgGaming = depts.reduce((s, d) => s + d.gaming, 0) / depts.length;
  return clamp(1 - avgDiv * 0.9 - avgGaming * 0.3, 0, 1);
}

// --- Apply recovery effects to departments ---
export function applyRecoveryToDepts(depts, cfg) {
  return depts.map(d => ({
    ...d,
    gaming: d.gaming * 0.5,
    reEscalations: 0,
    latency: 0
  }));
}

// --- Initial state ---
export function createInitialState() {
  return {
    tick: 0,
    baselineDepts: DEPT_NAMES.map(initDept),
    ainoDepts: DEPT_NAMES.map(initDept),
    mode: MODES.NORMAL,
    captureRisk: 0,
    shockActive: false,
    crisisDayCount: 0,
    cooldownRemaining: 0,
    crisisEventCount: 0,
    pendingIntervention: false,
    interventionDelayRemaining: 0,
    history: {
      baseHealth: [],
      ainoHealth: [],
      divergence: [],
      mode: [],
      interventionMarkers: []
    },
    shadowNoise: DEFAULT_CONFIG.shadowNoise
  };
}

// --- Tick ---
export function runTick(state, cfg) {
  if (state.tick >= cfg.ticks) return state;

  const shock = state.shockActive;
  let currentMode = state.mode;
  let crisisDayCount = state.crisisDayCount;
  let cooldownRemaining = state.cooldownRemaining;
  let crisisEventCount = state.crisisEventCount;
  let pendingIntervention = state.pendingIntervention;
  let interventionDelayRemaining = state.interventionDelayRemaining;
  let shadowNoise = state.shadowNoise !== undefined ? state.shadowNoise : cfg.shadowNoise;
  let interventionMarkers = [...(state.history.interventionMarkers || [])];
  let recoveryTriggeredThisTick = false;

  // Handle pending intervention countdown
  if (pendingIntervention && interventionDelayRemaining > 0) {
    interventionDelayRemaining--;
    if (interventionDelayRemaining === 0) {
      pendingIntervention = false;
      recoveryTriggeredThisTick = true;
    }
  }

  // Auto-recovery: if in Crisis for N days
  if (currentMode === "Crisis") {
    crisisDayCount++;
    if (crisisDayCount >= cfg.autoCrisisDaysForRecovery) {
      recoveryTriggeredThisTick = true;
      crisisDayCount = 0;
    }
  } else if (currentMode !== "Recovery" && currentMode !== "Cooldown") {
    crisisDayCount = 0;
  }

  let newAino = state.ainoDepts;
  let newBaseline = state.baselineDepts.map(d => stepBaselineDept(d, cfg, shock));

  // Apply recovery if triggered
  if (recoveryTriggeredThisTick) {
    currentMode = "Recovery";
    newAino = applyRecoveryToDepts(state.ainoDepts, cfg);
    shadowNoise = shadowNoise * 0.8;
    crisisDayCount = 0;
    cooldownRemaining = 0;
    interventionMarkers = [...interventionMarkers, state.tick];
    newAino = newAino.map(d => stepAinoDept(d, cfg, shock, "Recovery"));
  } else if (currentMode === "Recovery") {
    // Recovery lasts 1 tick then transitions to Cooldown
    currentMode = "Cooldown";
    cooldownRemaining = cfg.cooldownDays;
    newAino = state.ainoDepts.map(d => stepAinoDept(d, cfg, shock, "Cooldown"));
  } else if (currentMode === "Cooldown") {
    cooldownRemaining--;
    newAino = state.ainoDepts.map(d => stepAinoDept(d, cfg, shock, "Cooldown"));
    if (cooldownRemaining <= 0) {
      currentMode = "Normal";
      cooldownRemaining = 0;
    }
  } else {
    newAino = state.ainoDepts.map(d => stepAinoDept(d, cfg, shock, currentMode));
  }

  // Compute new mode (only if not in special modes)
  let newMode = currentMode;
  if (currentMode !== "Recovery" && currentMode !== "Cooldown") {
    newMode = computeMode(newAino, cfg, currentMode);
    // Track crisis events: entering crisis
    if (newMode === "Crisis" && currentMode !== "Crisis") {
      crisisEventCount++;
    }
  }

  const maxReEsc = Math.max(...newAino.map(d => d.reEscalations));
  const riskDelta =
    newMode === "Crisis"   ? 0.01 :
    newMode === "Tension"  ? 0.005 :
    newMode === "Cooldown" ? -0.005 :
    newMode === "Recovery" ? -0.008 :
    -0.003;

  const newCapture = clamp(
    state.captureRisk + riskDelta + maxReEsc * 0.001,
    0,
    1
  );

  const bh = computeOrgHealth(newBaseline);
  const ah = computeOrgHealth(newAino);
  const div =
    newAino.reduce((s, d) => s + Math.abs(d.kpi - d.shadowMetric), 0) /
    newAino.length;

  const modeIntensity =
    newMode === "Normal"   ? 0.2 :
    newMode === "Tension"  ? 0.6 :
    newMode === "Crisis"   ? 1.0 :
    newMode === "Recovery" ? 0.4 :
    newMode === "Cooldown" ? 0.3 : 0.2;

  return {
    ...state,
    tick: state.tick + 1,
    baselineDepts: newBaseline,
    ainoDepts: newAino,
    mode: newMode,
    captureRisk: newCapture,
    crisisDayCount,
    cooldownRemaining,
    crisisEventCount,
    pendingIntervention,
    interventionDelayRemaining,
    shadowNoise,
    history: {
      baseHealth: [...state.history.baseHealth, bh],
      ainoHealth: [...state.history.ainoHealth, ah],
      divergence: [...state.history.divergence, div],
      mode: [...state.history.mode, modeIntensity],
      interventionMarkers
    }
  };
}
