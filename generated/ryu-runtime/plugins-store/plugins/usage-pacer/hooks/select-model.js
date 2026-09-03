// Turn-hook body for Usage Pacer. This is a fragment, not an ES module.
// `ctx` holds the resolved agent + requested model; `host` is capability-gated.

const enabled = String(await host.getPreference({ key: "usage-pacer-enabled" }) ?? "false") === "true";
if (!enabled || !ctx.agent_id || !ctx.event || !ctx.event.model) return { kind: "none" };

const rawRules = await host.getPreference({ key: "usage-pacer-rules" });
let configuration;
try { configuration = JSON.parse(String(rawRules ?? "{}")); } catch (_error) { return { kind: "none" }; }
const rule = configuration?.agents?.[ctx.agent_id] ?? configuration?.global;
if (!rule || (!Array.isArray(rule.ladder) && !Array.isArray(rule.upgrade_ladder))) {
  return { kind: "none" };
}

const snapshot = await host.usage({ agent_id: ctx.agent_id });
if (!snapshot?.available || !Array.isArray(snapshot.windows)) return { kind: "none" };

const now = Date.now();
const selectedWindows = snapshot.windows.filter((window) => {
  const seconds = Number(window.window_seconds ?? 0);
  if (rule.windows === "session") return seconds > 0 && seconds <= 6 * 60 * 60;
  if (rule.windows === "weekly") return seconds >= 6 * 24 * 60 * 60 && seconds <= 8 * 24 * 60 * 60;
  return seconds > 0;
});
if (selectedWindows.length === 0) return { kind: "none" };

function percent(raw) {
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
}

function windowState(window) {
  const used = percent(window.used_percent);
  const seconds = Number(window.window_seconds);
  const reset = Date.parse(String(window.resets_at ?? ""));
  const minutesToReset = Number.isFinite(reset) ? Math.max(0, (reset - now) / 60000) : null;
  let deficit = 0;
  if (used !== null && Number.isFinite(seconds) && seconds > 0 && Number.isFinite(reset)) {
    const expected = Math.max(0, Math.min(100, 100 * (1 - (reset - now) / (seconds * 1000))));
    deficit = used - expected;
  }
  return {
    used,
    remaining: used === null ? null : 100 - used,
    minutesToReset,
    deficit,
  };
}

const states = selectedWindows.map(windowState);
const usedValues = states.filter((state) => state.used !== null).map((state) => state.used);
const resetValues = states
  .filter((state) => state.minutesToReset !== null)
  .map((state) => state.minutesToReset);
const used = usedValues.length > 0 ? Math.max(...usedValues) : 0;
const deficitValues = states.map((state) => state.deficit).filter(Number.isFinite);
const deficit = deficitValues.length > 0 ? Math.max(...deficitValues) : 0;
const mode = String(await host.getPreference({ key: "usage-pacer-mode" }) ?? "even");
const deficitLimit = Number(rule.pace_deficit ?? 15);
// Deficit raises the effective pressure only AFTER the configured tolerance. That
// means a 15-point deficit can trigger the next rung, but cannot jump every rung
// at once; spending still has to cross each ladder threshold.
const pressure = mode === "even" ? used + Math.max(0, deficit - deficitLimit) : used;

let selected = String(ctx.event.model);
const originalModel = selected;

function thresholdValue(step, names) {
  for (const name of names) {
    const value = Number(step[name]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function triggers(step) {
  const remainingLimit = thresholdValue(step, ["remaining", "remaining_percent"]);
  const minutesLimit = thresholdValue(step, ["within_minutes", "reset_within_minutes"]);
  const remainingTriggered = remainingLimit !== null
    && remainingLimit >= 0
    && remainingLimit <= 100
    && states.some((state) => state.remaining !== null && state.remaining <= remainingLimit);
  const resetTriggered = minutesLimit !== null
    && minutesLimit >= 0
    && resetValues.some((minutes) => minutes <= minutesLimit);
  return remainingTriggered || resetTriggered;
}

function configEntries(step) {
  if (!step.acp_config || typeof step.acp_config !== "object" || Array.isArray(step.acp_config)) {
    return [];
  }
  const agentId = String(ctx.agent_id).toLowerCase();
  function configId(key) {
    if (key !== "fast_mode") return key;
    if (agentId.includes("codex")) return "fast-mode";
    if (agentId.includes("claude")) return "fast";
    return key;
  }
  return Object.entries(step.acp_config)
    .filter(([key, value]) => key.trim() !== "" && value !== null && ["string", "number", "boolean"].includes(typeof value))
    .map(([key, value]) => [configId(key), String(value)]);
}

const upgradeSteps = (Array.isArray(rule.upgrade_ladder) ? rule.upgrade_ladder : [])
  .filter((step) => {
    if (!step || !triggers(step)) return false;
    const model = typeof step.model === "string" && step.model.trim() !== "";
    const effort = typeof step.effort === "string" && step.effort.trim() !== "";
    return model || effort || configEntries(step).length > 0;
  });
let selectedEffort;
const selectedAcpConfig = {};
let quotaEscalationApplied = false;
const appliedUpgradeSteps = new Set();

// Upgrade steps are the emergency policy at the end of a window. They are
// evaluated before the fallback ladder so an active escalation cannot be hidden
// by an ordinary cheaper-model rule in the same configuration.
for (let hop = 0; hop < upgradeSteps.length; hop += 1) {
  let progressed = false;
  for (const [index, step] of upgradeSteps.entries()) {
    if (appliedUpgradeSteps.has(index)) continue;
    const from = selected.toLowerCase();
    if (step.from && !from.includes(String(step.from).toLowerCase())) continue;
    appliedUpgradeSteps.add(index);

    let stepApplied = false;
    const target = typeof step.model === "string" ? step.model.trim() : "";
    if (target !== "") {
      stepApplied = true;
      if (target !== selected) {
        selected = target;
        progressed = true;
      }
    }
    if (typeof step.effort === "string" && step.effort.trim() !== "") {
      selectedEffort = step.effort.trim();
      progressed = true;
      stepApplied = true;
    }
    for (const [key, value] of configEntries(step)) {
      selectedAcpConfig[key] = value;
      progressed = true;
      stepApplied = true;
    }
    quotaEscalationApplied = quotaEscalationApplied || stepApplied;
  }
  if (!progressed) break;
}

if (!quotaEscalationApplied) {
  const downgradeLadder = (Array.isArray(rule.ladder) ? rule.ladder : [])
    .filter((step) => step && typeof step.model === "string" && Number.isFinite(Number(step.at)))
    .filter((step) => pressure >= Number(step.at));
  const visitedModels = new Set([selected.toLowerCase()]);
  for (let hop = 0; hop < downgradeLadder.length; hop += 1) {
    const from = selected.toLowerCase();
    const next = downgradeLadder
      .filter((step) => !step.from || from.includes(String(step.from).toLowerCase()))
      .sort((left, right) => Number(right.at) - Number(left.at))[0];
    const target = String(next?.model ?? "").trim();
    if (!next || target === "" || target === selected || visitedModels.has(target.toLowerCase())) break;
    selected = target;
    visitedModels.add(target.toLowerCase());
  }
}

if (
  selected === originalModel
  && !selectedEffort
  && Object.keys(selectedAcpConfig).length === 0
) {
  return { kind: "none" };
}

const reason = `${Math.round(used)}% used; ${deficit >= 0 ? `${Math.round(deficit)}% in deficit` : `${Math.round(-deficit)}% in reserve`}${quotaEscalationApplied ? "; quota escalation active" : ""}`;
const directive = { kind: "select_model", model: selected, reason };
if (selectedEffort) directive.effort = selectedEffort;
if (Object.keys(selectedAcpConfig).length > 0) directive.acp_config = selectedAcpConfig;
return directive;
