// simulation-core-worker.js — mirrors simulation-core.js exactly (no ES module exports)

const DEPT_NAMES = ["Sales", "Ops", "Finance", "Product"];

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function rand(lo, hi) { return lo + Math.random() * (hi - lo); }

function initDept(name) {
  return { name, kpi: 0.5, reality: 0.5, gaming: 0, shadowMetric: 0.5, latency: 0, reEscalations: 0 };
}

function stepBaselineDept(dept, cfg, shock) {
  const realityDrift = rand(-0.03, 0.03) + (shock ? rand(-0.15, -0.05) : 0);
  const newReality = clamp(dept.reality + realityDrift, 0, 1);
  const gamingPressure = 0.015 + dept.gaming * 0.01;
  const newKpi = clamp(dept.kpi + gamingPressure + rand(-0.01, 0.01), 0, 1);
  const newGaming = clamp(dept.gaming + cfg.gamingRate, 0, 1);
  return { ...dept, reality: newReality, kpi: newKpi, gaming: newGaming };
}

function stepAinoDept(dept, cfg, shock, mode) {
  const realityDrift = rand(-0.03, 0.03) + (shock ? rand(-0.15, -0.05) : 0);
  const newReality = clamp(dept.reality + realityDrift, 0, 1);

  let newShadow;
  if (shock) {
    newShadow = clamp(dept.shadowMetric + rand(-0.01, 0.01), 0, 1);
  } else if (mode === "Cooldown" || mode === "Recovery") {
    const convergenceRate = 0.05;
    newShadow = clamp(dept.shadowMetric + (newReality - dept.shadowMetric) * convergenceRate + rand(-0.005, 0.005), 0, 1);
  } else {
    newShadow = clamp(newReality + rand(-cfg.shadowNoise, cfg.shadowNoise), 0, 1);
  }

  if (mode === "Cooldown") {
    const newGaming = clamp(dept.gaming * 0.96, 0, 1);
    const newKpi = clamp(dept.kpi + (newReality - dept.kpi) * 0.03 + rand(-0.005, 0.005), 0, 1);
    return {
      ...dept,
      reality: newReality,
      kpi: newKpi,
      gaming: newGaming,
      shadowMetric: newShadow,
      latency: Math.max(0, dept.latency - 1),
      reEscalations: Math.max(0, dept.reEscalations - 0.2)
    };
  }

  if (mode === "Recovery") {
    const newGaming = clamp(dept.gaming * 0.90, 0, 1);
    const newKpi = clamp(dept.kpi + rand(-0.005, 0.005), 0, 1);
    return {
      ...dept,
      reality: newReality,
      kpi: newKpi,
      gaming: newGaming,
      shadowMetric: newShadow,
      latency: 0,
      reEscalations: 0
    };
  }

  const modeFactors = {
    Normal:  { pressure: 1.0, decay: cfg.gamingDecay.Normal },
    Tension: { pressure: 0.6, decay: cfg.gamingDecay.Tension },
    Crisis:  { pressure: 0.3, decay: cfg.gamingDecay.Crisis }
  };
  const f = modeFactors[mode] || modeFactors.Normal;

  const gamingPressure = 0.015 * f.pressure + dept.gaming * 0.005 * f.pressure;
  const newKpi = clamp(dept.kpi + gamingPressure + rand(-0.01, 0.01), 0, 1);
  const newGaming = clamp(dept.gaming + cfg.gamingRate - f.decay, 0, 1);

  const divergence = Math.abs(newKpi - newShadow);
  let newLatency = dept.latency + 1;
  let newReEsc = dept.reEscalations;

  if (divergence > cfg.thresholds.tension) {
    if (newLatency > cfg.thresholds.latency) {
      newReEsc = newReEsc + 1;
      newLatency = 0;
    }
  } else {
    newLatency = Math.max(0, newLatency - 2);
    newReEsc = Math.max(0, newReEsc - 0.05);
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

function computeMode(depts, cfg) {
  const avgDiv = depts.reduce((s, d) => s + Math.abs(d.kpi - d.shadowMetric), 0) / depts.length;
  const maxReEsc = Math.max(...depts.map(d => d.reEscalations));
  if (avgDiv >= cfg.thresholds.crisis || maxReEsc >= cfg.thresholds.reEscalation) return "Crisis";
  if (avgDiv >= cfg.thresholds.tension) return "Tension";
  return "Normal";
}

function computeOrgHealth(depts) {
  const avgDiv = depts.reduce((s, d) => s + Math.abs(d.kpi - d.reality), 0) / depts.length;
  const avgGaming = depts.reduce((s, d) => s + d.gaming, 0) / depts.length;
  return clamp(1 - avgDiv * 0.9 - avgGaming * 0.3, 0, 1);
}

function applyRecoveryToDepts(depts) {
  return depts.map(d => ({ ...d, gaming: d.gaming * 0.5, reEscalations: 0, latency: 0 }));
}

function runTick(state, cfg) {
  if (state.tick >= cfg.ticks) return state;

  const shock = state.shockActive;
  let currentMode = state.mode;
  let crisisDayCount = state.crisisDayCount || 0;
  let cooldownRemaining = state.cooldownRemaining || 0;
  let crisisEventCount = state.crisisEventCount || 0;
  let pendingIntervention = state.pendingIntervention || false;
  let interventionDelayRemaining = state.interventionDelayRemaining || 0;
  let shadowNoise = state.shadowNoise !== undefined ? state.shadowNoise : cfg.shadowNoise;
  let interventionMarkers = [...(state.history.interventionMarkers || [])];
  let recoveryTriggeredThisTick = false;

  if (pendingIntervention && interventionDelayRemaining > 0) {
    interventionDelayRemaining--;
    if (interventionDelayRemaining === 0) {
      pendingIntervention = false;
      recoveryTriggeredThisTick = true;
    }
  }

  if (currentMode === "Crisis") {
    crisisDayCount++;
    if (crisisDayCount >= (cfg.autoCrisisDaysForRecovery || 30)) {
      recoveryTriggeredThisTick = true;
      crisisDayCount = 0;
    }
  } else if (currentMode !== "Recovery" && currentMode !== "Cooldown") {
    crisisDayCount = 0;
  }

  let newBaseline = state.baselineDepts.map(d => stepBaselineDept(d, cfg, shock));
  let newAino;

  if (recoveryTriggeredThisTick) {
    newAino = applyRecoveryToDepts(state.ainoDepts);
    shadowNoise = shadowNoise * 0.8;
    crisisDayCount = 0;
    cooldownRemaining = cfg.cooldownDays || 15;
    interventionMarkers = [...interventionMarkers, state.tick];
    newAino = newAino.map(d => stepAinoDept(d, cfg, shock, "Recovery"));
    currentMode = "Cooldown";

  } else if (currentMode === "Cooldown") {
    newAino = state.ainoDepts.map(d => stepAinoDept(d, cfg, shock, "Cooldown"));
    cooldownRemaining = Math.max(0, cooldownRemaining - 1);
    if (cooldownRemaining === 0) {
      currentMode = "Normal";
    }

  } else {
    newAino = state.ainoDepts.map(d => stepAinoDept(d, cfg, shock, currentMode));
  }

  let newMode;
  if (currentMode === "Cooldown") {
    newMode = "Cooldown";
  } else {
    newMode = computeMode(newAino, cfg);
    if (newMode === "Crisis" && state.mode !== "Crisis" && state.mode !== "Cooldown" && state.mode !== "Recovery") {
      crisisEventCount++;
    }
  }

  const maxReEsc = Math.max(...newAino.map(d => d.reEscalations));
  const riskDelta =
    newMode === "Crisis"   ?  0.010 :
    newMode === "Tension"  ?  0.005 :
    newMode === "Cooldown" ? -0.005 :
    newMode === "Recovery" ? -0.008 :
                             -0.003;
  const newCapture = clamp(state.captureRisk + riskDelta + maxReEsc * 0.001, 0, 1);

  const bh = computeOrgHealth(newBaseline);
  const ah = computeOrgHealth(newAino);
  const div = newAino.reduce((s, d) => s + Math.abs(d.kpi - d.shadowMetric), 0) / newAino.length;
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

onmessage = function (e) {
  const { state, cfg, steps } = e.data;
  let s = state;
  for (let i = 0; i < steps; i++) { s = runTick(s, cfg); }
  postMessage(s);
};
