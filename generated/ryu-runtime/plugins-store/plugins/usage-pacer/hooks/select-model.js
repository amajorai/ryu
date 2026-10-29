// Turn-hook body for Usage Pacer. This is a fragment, not an ES module.
// `ctx` holds the resolved agent + requested model; `host` is capability-gated.

let enabledPreference;
try {
  enabledPreference = await host.getPreference({ key: "usage-pacer-enabled" });
} catch  {
  return { kind: "none" };
}
const enabled = String(enabledPreference ?? "false") === "true";
if (!enabled || !ctx.agent_id || !ctx.event || !ctx.event.model) return { kind: "none" };

let rawRules;
try {
  rawRules = await host.getPreference({ key: "usage-pacer-rules" });
} catch  {
  return { kind: "none" };
}
let configuration;
try { configuration = JSON.parse(String(rawRules ?? "{}")); } catch  { return { kind: "none" }; }
// `ctx.event.provider_id` is Core's prediction of the subscription provider the
// turn will spend (direct managed Pi only). Provider rules win over agent rules,
// which win over the global rule.
const providerId = nonEmptyText(ctx.event.provider_id);
const rule = (providerId ? configuration?.providers?.[providerId] : undefined)
  ?? configuration?.agents?.[ctx.agent_id]
  ?? configuration?.global;
if (!rule || (!Array.isArray(rule.ladder) && !Array.isArray(rule.upgrade_ladder))) {
  return { kind: "none" };
}

let modePreference;
try {
  modePreference = await host.getPreference({ key: "usage-pacer-mode" });
} catch  {
  return { kind: "none" };
}
const mode = String(modePreference ?? "even");
const deficitLimit = Number(rule.pace_deficit ?? 15);
const now = Date.now();

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

// Pacing pressure for one usage snapshot under this rule, or null when the
// snapshot has no readable window the rule selects.
function assess(snapshot) {
  if (!snapshot?.available || !Array.isArray(snapshot.windows)) return null;
  const selectedWindows = snapshot.windows.filter((window) => {
    const seconds = Number(window?.window_seconds ?? 0);
    if (rule.windows === "session") return seconds > 0 && seconds <= 6 * 60 * 60;
    if (rule.windows === "weekly") return seconds >= 6 * 24 * 60 * 60 && seconds <= 8 * 24 * 60 * 60;
    return seconds > 0;
  });
  if (selectedWindows.length === 0) return null;
  const windowStates = selectedWindows.map(windowState);
  const usedValues = windowStates.filter((state) => state.used !== null).map((state) => state.used);
  const usedPercent = usedValues.length > 0 ? Math.max(...usedValues) : 0;
  const deficitValues = windowStates.map((state) => state.deficit).filter(Number.isFinite);
  const deficitPercent = deficitValues.length > 0 ? Math.max(...deficitValues) : 0;
  // Deficit raises the effective pressure only AFTER the configured tolerance. That
  // means a 15-point deficit can trigger the next rung, but cannot jump every rung
  // at once; spending still has to cross each ladder threshold.
  const pacingPressure = mode === "even"
    ? usedPercent + Math.max(0, deficitPercent - deficitLimit)
    : usedPercent;
  return {
    states: windowStates,
    used: usedPercent,
    deficit: deficitPercent,
    pressure: pacingPressure,
  };
}

// Provider form: label-free, cache-only rows for every saved account. Returns
// null (so the caller falls back to the agent form) on a denial, an unknown
// provider, or when no usable account reading is cached yet.
async function providerAssessment() {
  if (!providerId) return null;
  let pool;
  try {
    pool = await host.usage({ provider_id: providerId });
  } catch {
    return null;
  }
  if (!pool || pool.error || !Array.isArray(pool.accounts) || pool.accounts.length === 0) return null;
  const readable = (account) => account && account.state === "ok" ? assess(account.usage) : null;
  const predictedAccount = nonEmptyText(ctx.event.account_id);
  if (predictedAccount) {
    return readable(pool.accounts.find((account) => account?.account_id === predictedAccount));
  }
  const strategy = nonEmptyText(pool.pool_strategy) ?? nonEmptyText(ctx.event.pool_strategy) ?? "manual";
  if (strategy === "manual") {
    return readable(pool.accounts.find((account) => account?.active === true));
  }
  // A pooled provider spends whichever eligible account the pool picks; pace
  // against the least-pressured one so a single drained account does not
  // downgrade turns the pool would route elsewhere.
  let best = null;
  for (const account of pool.accounts) {
    if (account?.eligible !== true) continue;
    const assessment = readable(account);
    if (assessment && (best === null || assessment.pressure < best.pressure)) best = assessment;
  }
  return best;
}

async function agentAssessment() {
  try {
    return assess(await host.usage({ agent_id: ctx.agent_id }));
  } catch {
    return null;
  }
}

const assessment = (await providerAssessment()) ?? (await agentAssessment());
if (!assessment) return { kind: "none" };
const { states, used, deficit, pressure } = assessment;
const resetValues = states
  .filter((state) => state.minutesToReset !== null)
  .map((state) => state.minutesToReset);

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

// The configuration above is decoded by native JSON.parse. This branch accepts
// only JSON record containers; arrays and scalar values are not ACP settings.
function configEntries(step) {
  if (!step.acp_config || Object(step.acp_config) !== step.acp_config || Array.isArray(step.acp_config)) {
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
    .filter(([key, value]) => key.trim() !== "" && value !== null && (parsePrimitiveText(value) !== undefined || parsePrimitiveNumber(value) !== undefined || value === true || value === false))
    .map(([key, value]) => [configId(key), String(value)]);
}

const upgradeSteps = (Array.isArray(rule.upgrade_ladder) ? rule.upgrade_ladder : [])
  .filter((step) => {
    if (!step || !triggers(step)) return false;
    const model = parsePrimitiveText(step.model) !== undefined && step.model.trim() !== "";
    const effort = parsePrimitiveText(step.effort) !== undefined && step.effort.trim() !== "";
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
    const target = parsePrimitiveText(step.model) !== undefined ? step.model.trim() : "";
    if (target !== "") {
      stepApplied = true;
      if (target !== selected) {
        selected = target;
        progressed = true;
      }
    }
    if (parsePrimitiveText(step.effort) !== undefined && step.effort.trim() !== "") {
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
    .filter((step) => step && parsePrimitiveText(step.model) !== undefined && Number.isFinite(Number(step.at)))
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

// Decode with the native String internal-slot check; boxed strings remain
// non-text inputs. This flat sandbox fragment needs no module imports.
function parsePrimitiveText(value) {
	try {
		const parsed = String.prototype.valueOf.call(value);
		return parsed === value ? parsed : undefined;
	} catch {
		return undefined;
	}
}

// Decode the native Number slot without coercing user-controlled objects.
function parsePrimitiveNumber(value) {
	try {
		const parsed = Number.prototype.valueOf.call(value);
		return Object.is(parsed, value) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

// Trimmed primitive text, or undefined for anything else.
function nonEmptyText(value) {
	const text = parsePrimitiveText(value);
	return text !== undefined && text.trim() !== "" ? text.trim() : undefined;
}
