// The named-policy view model shared by the web console and the desktop
// Gateway dialog (managed guardrails spec 06.7).
//
// These types mirror the control-plane wire shape of
// `/api/control-plane/orgs/:orgId/guardrail-*` (see
// `packages/db/src/models/guardrail-policy.model.ts`). They are copied rather
// than imported so this package never pulls in Mongoose; each surface's API
// client decodes the wire into these shapes.

import { GUARDRAIL_ACTION_LABELS } from "./copy.ts";
import type {
	GuardrailFirewallAction,
	GuardrailFirewallOverlay,
	GuardrailPattern,
	GuardrailScopeCtx,
} from "./types.ts";

/** The tenant-facing ladder below the Ryu platform policy, broadest first. */
export const POLICY_SCOPE_KINDS = [
	"org",
	"team",
	"member",
	"key",
	"agent",
] as const;
export type PolicyScopeKind = (typeof POLICY_SCOPE_KINDS)[number];

export const POLICY_PERMISSION_ACTIONS = [
	"tool.call",
	"mcp.use",
	"model.use",
] as const;
export type PolicyPermissionAction = (typeof POLICY_PERMISSION_ACTIONS)[number];

export const POLICY_PERMISSION_EFFECTS = ["allow", "ask", "deny"] as const;
export type PolicyPermissionEffect = (typeof POLICY_PERMISSION_EFFECTS)[number];

export const POLICY_LOCKABLE_FIELDS = [
	"approvedModels",
	"approvedProviders",
	"allowedRegions",
	"allowedTools",
	"deniedTools",
	"allowedMcpServers",
] as const;
export type PolicyLockableField = (typeof POLICY_LOCKABLE_FIELDS)[number];

export const POLICY_BUDGET_WINDOWS = [
	"daily",
	"weekly",
	"monthly",
	"lifetime",
] as const;
export type PolicyBudgetWindow = (typeof POLICY_BUDGET_WINDOWS)[number];

/** Copy for every surface that lists a policy with no assignment. */
export const UNASSIGNED_POLICY_COPY = "Unassigned policies enforce nothing";
/** Label for rows the platform floor sets. */
export const PLATFORM_POLICY_LABEL = "Ryu platform policy (managed by Ryu)";
/** The ladder, in words, for captions. */
export const POLICY_LADDER_COPY =
	"Ryu platform, then organization, team, member, key and agent. Each scope can only tighten what the scopes above it set.";

export interface PolicyPermission {
	action: PolicyPermissionAction;
	effect: PolicyPermissionEffect;
	resource: string;
}

/** Firewall switches a policy can only turn on; absent inherits. */
export interface PolicyFirewallRules {
	custom_patterns?: GuardrailPattern[];
	enabled?: true;
	log_detections?: true;
	policy?: GuardrailFirewallAction;
	redact_pii?: true;
	redact_secrets?: true;
	scan_inbound?: true;
	scan_outbound?: true;
}

export interface PolicyRules {
	allowedRegions: string[];
	approvedModels: string[];
	approvedProviders: string[];
	budgets: Array<{ usdMicro: number; window: PolicyBudgetWindow }>;
	evaluators: Array<{ id: string; inlineAction?: GuardrailFirewallAction }>;
	firewall: PolicyFirewallRules;
	permissions: PolicyPermission[];
	zeroDataRetention: boolean | null;
}

export interface PolicyScopeRef {
	id: string;
	kind: PolicyScopeKind;
}

export interface PolicyAssignmentView {
	id: string;
	policyId: string;
	scope: PolicyScopeRef;
}

export interface PolicyView {
	assignments: PolicyAssignmentView[];
	description: string;
	id: string;
	locked: PolicyLockableField[];
	name: string;
	rules: PolicyRules;
	version: number;
}

function sameScope(left: PolicyScopeRef, right: PolicyScopeRef): boolean {
	return left.kind === right.kind && left.id === right.id;
}

/**
 * The list after an assignment the server stored: a scope holds one policy,
 * so whatever held that scope (or that assignment id, on a replace) loses it
 * and the assigned policy gains it. Lets every view show a write at once
 * instead of waiting for the next list to arrive.
 */
export function policiesWithAssignment(
	policies: readonly PolicyView[],
	stored: PolicyAssignmentView
): PolicyView[] {
	const assignment: PolicyAssignmentView = {
		id: stored.id,
		policyId: stored.policyId,
		scope: { id: stored.scope.id, kind: stored.scope.kind },
	};
	return policies.map((policy) => {
		const kept = policy.assignments.filter(
			(entry) =>
				entry.id !== assignment.id && !sameScope(entry.scope, assignment.scope)
		);
		return {
			...policy,
			assignments:
				policy.id === assignment.policyId ? [...kept, assignment] : kept,
		};
	});
}

/** The list after the server deleted one assignment. */
export function policiesWithoutAssignment(
	policies: readonly PolicyView[],
	assignmentId: string
): PolicyView[] {
	return policies.map((policy) =>
		policy.assignments.some((entry) => entry.id === assignmentId)
			? {
					...policy,
					assignments: policy.assignments.filter(
						(entry) => entry.id !== assignmentId
					),
				}
			: policy
	);
}

export type PolicyPreviewLayer =
	| "platform"
	| "org"
	| "team"
	| "project"
	| "member"
	| "key"
	| "agent";

export interface PolicyPreviewSource {
	layer: PolicyPreviewLayer;
	locked: boolean;
	origin: string;
	policyId?: string;
	policyName?: string;
	policyVersion?: number;
	value: unknown;
}

export interface PolicyPreviewView {
	eligible: {
		models: { allowed: string[]; restricted: boolean };
		providers: { allowed: string[]; restricted: boolean };
	};
	fields: Array<{
		field: string;
		sources: PolicyPreviewSource[];
		value: unknown;
	}>;
	notes: string[];
	warnings: string[];
	zeroDataRetention: { required: boolean; sources: PolicyPreviewSource[] };
}

/** A scope choice the host can offer, with a human label. */
export interface PolicyScopeOption {
	id: string;
	label: string;
}

/** Per-kind choices for the scope picker. `org` takes the org itself. */
export interface PolicyScopeOptions {
	agent: PolicyScopeOption[];
	key: PolicyScopeOption[];
	member: PolicyScopeOption[];
	org: PolicyScopeOption[];
	team: PolicyScopeOption[];
}

export const POLICY_SCOPE_KIND_LABELS = {
	org: "Organization",
	team: "Team",
	member: "Member",
	key: "Key",
	agent: "Agent",
} satisfies Record<PolicyScopeKind, string>;

export const POLICY_LAYER_LABELS = {
	platform: "Ryu platform",
	org: "Organization",
	team: "Team",
	project: "Project",
	member: "Member",
	key: "Key",
	agent: "Agent",
} satisfies Record<PolicyPreviewLayer, string>;

export const POLICY_PERMISSION_ACTION_LABELS = {
	"tool.call": "Tool call",
	"mcp.use": "MCP server",
	"model.use": "Model",
} satisfies Record<PolicyPermissionAction, string>;

export const POLICY_PERMISSION_EFFECT_LABELS = {
	allow: "Allow",
	ask: "Ask",
	deny: "Deny",
} satisfies Record<PolicyPermissionEffect, string>;

export const POLICY_BUDGET_WINDOW_LABELS = {
	daily: "Per day",
	weekly: "Per week",
	monthly: "Per month",
	lifetime: "Lifetime",
} satisfies Record<PolicyBudgetWindow, string>;

export const POLICY_LOCKABLE_FIELD_LABELS = {
	approvedModels: "Approved models",
	approvedProviders: "Approved providers",
	allowedRegions: "Allowed regions",
	allowedTools: "Allowed tools",
	deniedTools: "Denied tools",
	allowedMcpServers: "Allowed MCP servers",
} satisfies Record<PolicyLockableField, string>;

/** Readable names for preview fields; unknown fields fall back to the key. */
const PREVIEW_FIELD_LABELS: Record<string, string> = {
	...POLICY_LOCKABLE_FIELD_LABELS,
	allowedFeatures: "Allowed features",
	budget: "Spend cap",
	budgets: "Spend cap",
	evaluators: "Evaluators",
	lockedGuardrails: "Locked guardrails",
	zeroDataRetention: "Zero data retention",
	"firewall.enabled": "Firewall enabled",
	"firewall.scan_inbound": "Scan inbound",
	"firewall.scan_outbound": "Scan outbound",
	"firewall.log_detections": "Log detections",
	"firewall.redact_pii": "Redact PII",
	"firewall.redact_secrets": "Redact secrets",
	"firewall.policy": "Firewall action",
	"firewall.custom_patterns": "Custom patterns",
};

export function previewFieldLabel(field: string): string {
	if (field.startsWith("evaluators.")) {
		return `Evaluator: ${field.slice("evaluators.".length)}`;
	}
	return PREVIEW_FIELD_LABELS[field] ?? field;
}

const PREVIEW_WARNINGS: Record<string, string> = {
	no_models_eligible:
		"No model is eligible at this scope. The allowlists above and the Ryu platform policy leave nothing in common, so every request would be refused.",
	no_providers_eligible:
		"No provider is eligible at this scope. The allowlists above and the Ryu platform policy leave nothing in common.",
	platform_floor_unavailable:
		"The Ryu platform policy could not be read, so this preview leaves it out.",
};

/** A sentence for a preview warning code; unknown codes show as sent. */
export function previewWarningText(code: string): string {
	return PREVIEW_WARNINGS[code] ?? code;
}

function actionLabelFor(value: string): string | undefined {
	return Object.entries(GUARDRAIL_ACTION_LABELS).find(
		([action]) => action === value
	)?.[1];
}

export function emptyPolicyRules(): PolicyRules {
	return {
		allowedRegions: [],
		approvedModels: [],
		approvedProviders: [],
		budgets: [],
		evaluators: [],
		firewall: {},
		permissions: [],
		zeroDataRetention: null,
	};
}

/** Split a comma or newline separated list into trimmed, unique entries. */
export function parsePolicyList(text: string): string[] {
	const entries = text
		.split(/[,\n]/)
		.map((entry) => entry.trim())
		.filter(Boolean);
	return [...new Set(entries)];
}

export function formatPolicyList(entries: readonly string[]): string {
	return entries.join(", ");
}

/** True when the policy rules would tighten nothing. */
export function policyRulesAreEmpty(rules: PolicyRules): boolean {
	const firewallKeys = Object.keys(rules.firewall).filter(
		(key) =>
			!(
				key === "custom_patterns" &&
				(rules.firewall.custom_patterns ?? []).length === 0
			)
	);
	return (
		rules.allowedRegions.length === 0 &&
		rules.approvedModels.length === 0 &&
		rules.approvedProviders.length === 0 &&
		rules.budgets.length === 0 &&
		rules.evaluators.length === 0 &&
		rules.permissions.length === 0 &&
		rules.zeroDataRetention !== true &&
		firewallKeys.length === 0
	);
}

/**
 * Rule fields an agent assignment cannot carry (the API answers
 * `agent_scope_unsupported`): an agent assignment holds firewall settings and
 * evaluators only.
 */
export function agentUnsupportedFields(
	rules: PolicyRules,
	locked: readonly PolicyLockableField[]
): string[] {
	const fields: string[] = [];
	if (rules.approvedModels.length > 0) {
		fields.push("approved models");
	}
	if (rules.approvedProviders.length > 0) {
		fields.push("approved providers");
	}
	if (rules.allowedRegions.length > 0) {
		fields.push("regions");
	}
	if (rules.permissions.length > 0) {
		fields.push("permissions");
	}
	if (rules.budgets.length > 0) {
		fields.push("spend cap");
	}
	if (rules.zeroDataRetention === true) {
		fields.push("zero data retention");
	}
	if (locked.length > 0) {
		fields.push("locked fields");
	}
	return fields;
}

/** Microdollars to a plain dollar string for an input. */
export function usdFromMicro(usdMicro: number): string {
	return String(usdMicro / 1_000_000);
}

/** A dollar input to whole microdollars, or `null` when it is not a number. */
export function microFromUsd(text: string): number | null {
	const trimmed = text.trim();
	if (trimmed === "") {
		return null;
	}
	const value = Number(trimmed);
	if (!Number.isFinite(value) || value < 0) {
		return null;
	}
	return Math.round(value * 1_000_000);
}

const BOOL_FIREWALL_FIELDS = [
	"enabled",
	"scan_inbound",
	"scan_outbound",
	"log_detections",
	"redact_pii",
	"redact_secrets",
] as const;

/**
 * Apply an editor patch to a policy's firewall rules. Switches survive only
 * when turned on (a policy cannot turn a protection off), `null` removes a
 * field so it inherits, and empty pattern lists are dropped.
 */
export function applyPolicyFirewallPatch(
	current: PolicyFirewallRules,
	patch: Partial<GuardrailFirewallOverlay>
): PolicyFirewallRules {
	const base: GuardrailFirewallOverlay = current;
	const pick = <K extends keyof GuardrailFirewallOverlay>(key: K) =>
		key in patch ? patch[key] : base[key];
	const next: PolicyFirewallRules = {};
	for (const field of BOOL_FIREWALL_FIELDS) {
		if (pick(field) === true) {
			next[field] = true;
		}
	}
	const policy = pick("policy");
	if (policy) {
		next.policy = policy;
	}
	const patterns = pick("custom_patterns") ?? [];
	if (patterns.length > 0) {
		next.custom_patterns = patterns;
	}
	return next;
}

/**
 * The shared firewall editor context for a named policy: an add-only
 * overlay whose inherited value is unknown, because the policy can be
 * assigned at any scope.
 */
export function policyFirewallCtx(input: {
	disabled: boolean;
	firewall: PolicyFirewallRules;
	onChange: (next: PolicyFirewallRules) => void;
	policyKey: string;
}): GuardrailScopeCtx {
	return {
		addOnly: true,
		broaderLocked: new Set(),
		disabled: input.disabled,
		inheritedUnknown: true,
		isOverlay: true,
		lockedHere: new Set(),
		node: {},
		overlay: input.firewall,
		overlayId: input.policyKey,
		overlayReady: true,
		scope: "policy",
		setNodeField: () => undefined,
		setOverlayField: (patch) =>
			input.onChange(applyPolicyFirewallPatch(input.firewall, patch)),
		toggleLock: () => undefined,
	};
}

/** `POLICY_DENY_ALL` in `packages/db/src/models/control-plane.model.ts`. */
const POLICY_DENY_ALL_MARKER = "<deny-all>";

/** One line describing a preview value. */
export function formatPreviewValue(value: unknown): string {
	if (value === null || value === undefined) {
		return "Not set";
	}
	if (typeof value === "boolean") {
		return value ? "On" : "Off";
	}
	if (typeof value === "string") {
		return actionLabelFor(value) ?? value;
	}
	if (typeof value === "number") {
		return String(value);
	}
	if (Array.isArray(value)) {
		if (value.length === 0) {
			return "No restriction";
		}
		// The control plane's marker for an allowlist that intersected to empty.
		if (value.includes(POLICY_DENY_ALL_MARKER)) {
			return "Nothing allowed";
		}
		return value.map((entry) => formatPreviewValue(entry)).join(", ");
	}
	if (typeof value === "object") {
		const record: Record<string, unknown> = Object.fromEntries(
			Object.entries(value)
		);
		if (typeof record.usdMicro === "number") {
			const window =
				typeof record.window === "string" ? ` ${record.window}` : "";
			return `$${usdFromMicro(record.usdMicro)}${window}`;
		}
		if (typeof record.name === "string") {
			return record.name;
		}
		if (typeof record.id === "string") {
			const enabled = record.enabled === false ? " (off)" : "";
			const action =
				typeof record.inlineAction === "string"
					? `: ${actionLabelFor(record.inlineAction) ?? record.inlineAction}`
					: "";
			return `${record.id}${action}${enabled}`;
		}
		return JSON.stringify(value);
	}
	return String(value);
}

/** "Team: Platform" style label for an assignment chip. */
export function scopeChipLabel(
	scope: PolicyScopeRef,
	options: PolicyScopeOptions | null
): string {
	const kindLabel = POLICY_SCOPE_KIND_LABELS[scope.kind];
	if (scope.kind === "org") {
		return kindLabel;
	}
	const match = options?.[scope.kind].find((option) => option.id === scope.id);
	return `${kindLabel}: ${match?.label ?? scope.id}`;
}

/**
 * A short sentence for a refusal code the policy API returns, or `null` to
 * show the server's own message.
 */
export function policyErrorHint(code: string | null): string | null {
	switch (code) {
		case "version_conflict":
			return "Someone else saved this policy first. Reload it to see their changes, then reapply yours.";
		case "policy_assigned":
			return "Remove every assignment of this policy before archiving it.";
		case "scope_already_assigned":
			return "That scope already has a policy. Replace it or remove it first.";
		case "invalid_regex_pattern":
			return "A custom pattern is not allowed. Patterns cannot use lookarounds, backreferences or a repeated group that already repeats.";
		case "invalid_permission_pattern":
			return "Permission resources may use only * and ? as wildcards.";
		case "glob_not_supported":
			return "Model permissions take an exact model id or *.";
		case "agent_scope_unsupported":
			return "An agent assignment carries firewall settings and evaluators only.";
		case "scope_not_found":
			return "That scope was not found in this organization.";
		default:
			return null;
	}
}
