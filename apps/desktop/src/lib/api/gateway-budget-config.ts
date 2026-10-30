import type { RyuJsonValue } from "@ryu/app-host/rpc";
import type { BudgetChargeInclusion } from "@ryuhq/core-client/gateway.ts";
import type { GatewayProviderAccount } from "./gateway.ts";
import type {
	Evaluator,
	GatewayFirewallConfig,
	GatewayFirewallOverlay,
	GatewayFirewallView,
} from "./gateway-evaluators.ts";
import type {
	GatewayAccountStrategy,
	GatewayProvidersConfig,
} from "./gateway-provider-config.ts";
import type {
	GatewayAlertTier,
	GatewayRoutingConfig,
	ProviderPoolStrategy,
	SmartRoutingConfig,
} from "./gateway-routing-config.ts";

/**
 * What the gateway does when a budget is exhausted.
 * Values are lowercase strings matching the gateway's serde(rename_all = "lowercase").
 */
export type BudgetAction = "notify" | "downgrade" | "restrict" | "stop";

export const DEFAULT_BUDGET_INCLUSION: BudgetChargeInclusion = {
	model: true,
	media: true,
	tools: true,
};

/**
 * A single per-agent or per-user budget rule.
 * Field names are snake_case — the gateway config API passes these through
 * without camelCase normalization (unlike the status proxy).
 */
export interface BudgetRule {
	/** Action taken once the charged-cost cap is reached. */
	action: BudgetAction;
	/**
	 * Notification fan-out tier when this rule matches — orthogonal to `action`.
	 * Optional on the wire (`#[serde(default)]` in Rust); `undefined` = `silent`.
	 * Always write it through {@link buildBudgetRule}: a rule object assembled by
	 * hand from a form used to drop this field, which silently demoted an
	 * operator's `email` rule to `silent` on the next edit-and-save.
	 */
	alert?: GatewayAlertTier;
	/** Model to route to when action = downgrade. */
	downgrade_to?: string | null;
	/** Which charged work categories contribute to this cap. */
	include?: BudgetChargeInclusion;
	/** Lifetime charged-cost cap in micro-USD (1_000_000 = $1). 0 = unlimited. */
	limit: number;
	/** Max tokens cap when action = restrict. Defaults to 256 on the gateway. */
	restrict_max_tokens?: number;
}

/** Loose scalars a budget form holds, before {@link buildBudgetRule} tightens them. */
export interface BudgetRuleInput {
	action: BudgetAction;
	/** Omitted ⇒ `silent`, matching the Rust `#[serde(default)]`. */
	alert?: GatewayAlertTier;
	/** Raw model id; trimmed, and only kept when `action === "downgrade"`. */
	downgradeTo?: string | null;
	/** Charged work categories to include. */
	include?: BudgetChargeInclusion;
	limit: number;
	/**
	 * Raw cap, as typed. Only kept when `action === "restrict"` AND it parses to a
	 * positive integer — otherwise omitted so the gateway applies its own 256.
	 */
	restrictMaxTokens?: number | string | null;
}

/**
 * The ONE place a {@link BudgetRule} is assembled for the wire.
 *
 * It exists because the same object literal was being built in three places in
 * `GatewayDialog.tsx` (the add dialogs' `formToRule`, `BudgetScopeSection`'s
 * duplicate of it, and `SessionBudgetEditor.handleSave`), each carrying only
 * `limit`/`action`/`downgrade_to`/`restrict_max_tokens`. Since `PUT /v1/config`
 * REPLACES the whole `BudgetConfig`, every one of those was a wipe of any field
 * they did not name — which is how `alert` stayed pinned at `silent` no matter
 * what an operator configured. Constructing rules anywhere else re-opens that.
 *
 * `alert` is always emitted, even at `silent`: the value the card shows and the
 * value on the wire then agree, and `silent` is the Rust default anyway, so this
 * is not a behaviour change for pre-existing rules.
 *
 * Pure and total — no throwing. Bad numbers are dropped rather than rejected,
 * mirroring what the dialogs already did (the dialogs validate `limit`
 * themselves; this only refuses to put junk on the wire). `limit` is charged
 * micro-USD (1_000_000 = $1), not a token count.
 */
export function buildBudgetRule(input: BudgetRuleInput): BudgetRule {
	const rule: BudgetRule = {
		limit: input.limit,
		action: input.action,
		alert: input.alert ?? "silent",
	};
	if (input.include) {
		rule.include = {
			model: input.include.model,
			media: input.include.media,
			tools: input.include.tools,
		};
	}
	const downgradeTo = (input.downgradeTo ?? "").trim();
	if (input.action === "downgrade" && downgradeTo !== "") {
		rule.downgrade_to = downgradeTo;
	}
	if (input.action === "restrict" && input.restrictMaxTokens != null) {
		const raw = String(input.restrictMaxTokens).trim();
		if (raw !== "") {
			const cap = Number(raw);
			if (Number.isInteger(cap) && cap > 0) {
				rule.restrict_max_tokens = cap;
			}
		}
	}
	return rule;
}

/**
 * Read-modify-write helper for one agent rule. Gateway budget updates replace
 * the complete budget object, so callers must preserve users, other agents,
 * and the global session rule when saving or removing a single agent cap.
 */
export function withAgentBudget(
	budgets: GatewayBudgetConfig,
	agentId: string,
	rule: BudgetRule | null
): GatewayBudgetConfig {
	const agents = { ...budgets.agents };
	if (rule) {
		agents[agentId] = rule;
	} else {
		delete agents[agentId];
	}
	return {
		users: { ...budgets.users },
		agents,
		session: budgets.session ?? DEFAULT_SESSION_BUDGET,
	};
}

/**
 * Per-user and per-agent charged-cost budgets (mirrors gateway BudgetConfig).
 * Keys are user/agent ids; values are budget rules.
 */
export interface GatewayBudgetConfig {
	agents: Record<string, BudgetRule>;
	/**
	 * A single GLOBAL per-session charged-cost cap (#510). Unlike `users`/`agents`,
	 * this is not a map: session ids are ephemeral (Core mints a fresh
	 * conversation id per chat), so one rule applies to every session. The
	 * shape is identical to a per-user/per-agent rule. `limit: 0` = off; values
	 * are charged micro-USD.
	 */
	session: BudgetRule;
	users: Record<string, BudgetRule>;
}

/**
 * Default (off) per-session budget rule used when the gateway omits one.
 *
 * `alert: "silent"` matches `impl Default for SessionBudgetConfig`
 * (`crates/gateway/budget/src/lib.rs`), which initialises `AlertTier::default()`
 * — so this fallback cannot claim a tier the gateway would not have.
 */
export const DEFAULT_SESSION_BUDGET: BudgetRule = {
	include: { ...DEFAULT_BUDGET_INCLUSION },
	limit: 0,
	action: "notify",
	alert: "silent",
	downgrade_to: null,
	restrict_max_tokens: 256,
};

export interface GatewayEgressConfig {
	assignments: Record<string, string>;
	pools: Record<
		string,
		{
			include_direct: boolean;
			direct_fallback_only?: boolean;
			endpoints: {
				id: string;
				url: string;
				enabled: boolean;
				priority?: number;
				username_env: string | null;
				password_env: string | null;
			}[];
		}
	>;
}

/** Full redacted config returned by GET /v1/config (via Core proxy). */
export interface GatewayConfig {
	acp: GatewayAcpConfig;
	appliedProviderRevision?: string | null;
	auth: GatewayAuthConfig;
	budgets: GatewayBudgetConfig;
	/** Node-wide computer-use policy. */
	computer_use: GatewayComputerUseConfig;
	configRevision?: string | null;
	/** Static policy drift projection retained for older Gateway clients. */
	drift?: GatewayDriftWarning[];
	/** Explicit outbound proxy pools. Older Gateways omit this section. */
	egress?: GatewayEgressConfig;
	firewall: GatewayFirewallView;
	/**
	 * Gateway-local standalone-desktop per-agent firewall overlay store (the leaf
	 * scope of the node → org → agent cascade), keyed by agent id. `{}` on a fresh
	 * node and on the hosted path (there the overlays arrive on the resolve
	 * response, not `/v1/config`). Runtime-only on the gateway (not persisted).
	 */
	firewall_agent_overlays: Record<string, GatewayFirewallOverlay>;
	/**
	 * Gateway-local standalone-desktop per-org firewall overlay store (the mid
	 * scope of the cascade), keyed by org id. Same semantics as
	 * `firewall_agent_overlays`.
	 */
	firewall_org_overlays: Record<string, GatewayFirewallOverlay>;
	marketplace_recommendations?: {
		cadence: "daily" | "weekly" | "monthly";
		enabled: boolean;
	};
	/** Resolved pipeline stages currently running in the gateway process. */
	pipeline_stages?: string[];
	providerEpoch?: { boot: string; sequence: number } | null;
	providers: GatewayProvidersConfig;
	routing: GatewayRoutingConfig;
	/** Explicit strategy support; absent on older nodes, not equivalent to empty. */
	strategyCapabilities?: {
		chat: ProviderPoolStrategy[];
		web: ProviderPoolStrategy[];
	};
	/** Redacted tool-loop config returned by newer Gateways. */
	tools?: GatewayToolsConfig;
	webServiceSchema?: 1;
}

/** Persisted policy for computer-use providers attached to one node. */
export interface GatewayComputerUseConfig {
	/** Whether Ghost may request the platform's locked-session path. */
	locked_use: boolean;
	/**
	 * Stored permission for features that use a hardware security key connected
	 * to this node. No current feature reads it. Absent on Gateways that predate
	 * the field.
	 */
	security_key?: boolean;
}

// `security_key` stays absent: a Gateway that sends no `computer_use` section
// predates the field, and the settings row treats absence as unsupported.
export const DEFAULT_GATEWAY_COMPUTER_USE: GatewayComputerUseConfig = {
	locked_use: false,
};

/** Persisted ACP lifecycle controls plus Core's runtime-only status projection. */
export interface GatewayAcpConfig {
	/** Number of ACP processes currently admitted by Core. */
	active_agents?: number;
	/** Core's hardware-derived limit before a manual override. */
	auto_max_parallel_agents?: number;
	/** Core's chosen limit after applying Auto or the manual override. */
	effective_max_parallel_agents?: number;
	hardware?: {
		cpu_cores: number;
		physical_cores: number;
		total_ram_bytes: number;
	};
	/** Kill an inactive pooled ACP process after this many minutes. */
	idle_timeout_minutes: number;
	/** Keep the local computer awake while Core reports active ACP agents. */
	keep_computer_awake: boolean;
	/** `null` means Core calculates a conservative limit from CPU and RAM. */
	max_parallel_agents: number | null;
}

/** Only the persisted fields are writable; runtime status stays Core-owned. */
export type GatewayAcpSettings = Pick<
	GatewayAcpConfig,
	"idle_timeout_minutes" | "max_parallel_agents" | "keep_computer_awake"
>;

export const DEFAULT_GATEWAY_ACP: GatewayAcpConfig = {
	idle_timeout_minutes: 5,
	max_parallel_agents: null,
	keep_computer_awake: true,
};

export interface GatewayDriftWarning {
	code: string;
	message: string;
	severity: "high" | "medium" | string;
}

export type GatewayDoctorCategory =
	| "configuration"
	| "security"
	| "performance"
	| "connectivity"
	| "coverage";

export type GatewayDoctorSeverity = "info" | "warning" | "error";

export interface GatewayDoctorFinding {
	canAutoFix: boolean;
	category: GatewayDoctorCategory | string;
	checkId: string;
	detail: string;
	recommendedAction?: string;
	settingPath?: string;
	severity: GatewayDoctorSeverity;
	summary: string;
}

export interface GatewayDoctorReport {
	counts: { errors: number; warnings: number; info: number };
	error?: string;
	findings: GatewayDoctorFinding[];
	generatedAt?: number;
	posture?: string;
	profile?: string;
	reachable?: boolean;
	readOnly?: boolean;
	rulesetVersion?: string;
	schemaVersion?: string;
}

export interface GatewayDoctorFix {
	action: string;
	checkId: string;
	settingPath: string;
	summary: string;
}

export interface GatewayDoctorFixResult {
	appliedFixes: GatewayDoctorFix[];
	dryRun: boolean;
	plannedFixes: GatewayDoctorFix[];
	report: GatewayDoctorReport;
}

/** Gateway's config.rs ToolProfile serialization, including its defaulted lists. */
export interface GatewayToolProfile {
	allow: string[];
	deny: string[];
	unrestricted: boolean;
}

export interface GatewayToolsConfig {
	always_on: RyuJsonValue[];
	describe_top_n: number;
	enabled: boolean;
	max_rounds: number;
	/** Concurrent read-only tool calls per model step; absent on older Gateways. */
	parallel_reads?: number;
	profiles: Record<string, GatewayToolProfile>;
}

/**
 * A single gateway API key entry (as returned by GET /v1/config).
 * The `key` field is always `"***"` in GET responses; the real value is only
 * visible at creation time (returned by the generate helper, never by GET).
 */
export interface GatewayApiKey {
	allowed_operations?: GatewayClientOperation[];
	/** Always `"***"` in GET responses. */
	key: string;
	/** Human-readable label, e.g. "OpenClaw BYOA". */
	name: string;
	org_id?: string | null;
	/** Read-only metadata for a bootstrapped relay that cannot be revoked here. */
	system_relay?: boolean;
	team_id?: string | null;
	/** When true, the gateway honors `x-ryu-agent-id` for per-agent budgets. */
	trusted_forwarder: boolean;
}

export type GatewayClientOperation = "inference" | "web_search" | "web_fetch";

/** The auth section of the gateway config (read-only view). */
export interface GatewayAuthConfig {
	api_keys: GatewayApiKey[];
	require_auth: boolean;
}

/** Partial update body accepted by PUT /v1/config (firewall/budgets/auth/routing are writable). */
export interface GatewayConfigPatch {
	/** ACP lifecycle/resource controls for Core-owned subprocesses. */
	acp?: GatewayAcpSettings;
	/** When present, replaces the api_keys list. Must include ALL keys to keep. */
	auth?: { api_keys: GatewayApiKey[] };
	budgets?: GatewayBudgetConfig;
	/** Node-wide Ghost/computer-use policy. */
	computer_use?: GatewayComputerUseConfig;
	/**
	 * User-created ("create from scratch") evaluators that EXTEND the built-in
	 * catalog. Full-replacement: send the COMPLETE custom set every time (a
	 * field-omitting PUT is preserved by the gateway's clobber guard, but a
	 * partial array replaces). A custom entry whose `id` matches a built-in
	 * overrides that built-in. Takes effect after a gateway restart.
	 */
	custom_evaluators?: Evaluator[];
	/** Full replacement. Validated and applied after Gateway restarts. */
	egress?: GatewayEgressConfig;
	expectedRevision?: string;
	firewall?: Partial<GatewayFirewallConfig>;
	/**
	 * Full replacement of the gateway-local per-agent overlay store. Any agent id
	 * absent from this map is REMOVED, so always send the complete map (read from
	 * GET, mutate the one entry, send all).
	 */
	firewall_agent_overlays?: Record<string, GatewayFirewallOverlay>;
	/**
	 * Full replacement of the gateway-local per-org overlay store. Same
	 * full-replacement semantics as `firewall_agent_overlays`.
	 */
	firewall_org_overlays?: Record<string, GatewayFirewallOverlay>;
	marketplace_recommendations?: {
		cadence: "daily" | "weekly" | "monthly";
		enabled: boolean;
	};
	providerAccountDrainThresholds?: Record<string, number>;
	providerAccountPolicies?: Record<
		string,
		Record<string, Omit<GatewayProviderAccount, "id">>
	>;
	providerAccountStrategies?: Record<string, GatewayAccountStrategy>;
	/**
	 * Ryu's user-level routing config (persisted; takes effect after gateway restart).
	 * Runs before any upstream provider routing — this is the governance layer. PUT
	 * replaces the ENTIRE routing object, so always read-modify-write the full
	 * routing from GET before sending.
	 */
	routing?: GatewayRoutingConfig;
}

export const DEFAULT_SMART_ROUTING: SmartRoutingConfig = {
	enabled: false,
	router_type: "llm_classifier",
	strategy: "llm",
	classifier_model: "",
	embedding_model: "",
	similarity_threshold: 0.35,
	random_seed: null,
	stage_capable_model: "",
	stage_efficient_model: "",
	stage_picker: "capable_first",
	stage_confidence_threshold: 0.5,
	stage_recent_message_window: 3,
	escalation_weak_model: "",
	escalation_strong_model: "",
	escalation_judge_model: "",
	escalation_confirmations: 2,
	escalation_recent_message_window: 28,
	escalation_message_chars: 500,
	rules: [],
	default_model: null,
	cache_by_session: true,
	timeout_ms: 4000,
	allowed_models: [],
	allowed_providers: [],
	agent_pools: {},
	agent_routes: {},
};
