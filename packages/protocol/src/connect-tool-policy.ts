/**
 * Connect tool policy (Treg parity B10): lifecycle states, team pins and
 * URL-level deny rules. Ryu's control plane authors the policy and publishes
 * it as one pulled feed (`connect.policy`); hosted Connect enforces it on
 * execute and hides what it refuses from search and describe.
 *
 * - **Lifecycle** is Ryu's, per tool id: `preview`, `stable` (the default for
 *   a tool with no entry), `deprecated` (still callable, announced with an
 *   optional successor and sunset date) and `retired` (refused and hidden).
 *   A `preview` tool is hidden and refused unless the caller's team or
 *   organization pins it.
 * - **Pins** are an organization's, optionally per team: a pin opts into a
 *   preview tool and, with a `version`, refuses the call when Connect serves
 *   any other version, so a team never runs a version it did not choose.
 * - **Deny rules** are an organization's, optionally per team. A `tool` rule
 *   matches tool ids (exact, or a prefix ending in `*`): the tool is hidden and
 *   refused before any credit is held. A URL rule matches the upstream request
 *   a call makes (host, optional path glob, optional methods): Connect refuses
 *   it before the request leaves, on every lane whose upstream URL it builds.
 *
 * Connect keeps a port of this module (`apps/connect/src/tool-policy.ts`);
 * both are held to `fixtures/connect-tool-policy-cases-v1.json`.
 */

import { z } from "zod";
import { tagBudgetsProblem, tenantTagBudgetsSchema } from "./spend-tags.ts";

export const CONNECT_TOOL_POLICY_CONTRACT_VERSION = 1;
export const CONNECT_POLICY_FEED_TYPE = "connect.policy";

/**
 * The header a Connect sends on its feed request to name the optional tenant
 * fields it understands. A tenant row is a strict object, so a Connect that
 * does not send `tag_budgets` gets a feed without `tagBudgets` (Treg parity
 * C6) instead of one it would refuse whole.
 */
export const CONNECT_POLICY_FEATURES_HEADER = "x-ryu-policy-features";
export const CONNECT_POLICY_FEATURE_TAG_BUDGETS = "tag_budgets";

export const LIFECYCLE_STATES = [
	"preview",
	"stable",
	"deprecated",
	"retired",
] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export const POLICY_METHODS = [
	"GET",
	"HEAD",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"OPTIONS",
] as const;
export type PolicyMethod = (typeof POLICY_METHODS)[number];

export const MAX_PINS_PER_TENANT = 200;
export const MAX_DENY_RULES_PER_TENANT = 200;
export const MAX_LIFECYCLE_ENTRIES = 5000;
export const MAX_POLICY_TENANTS = 100_000;

const TOOL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u;
const TOOL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{1,198}\*?$/u;
const TEAM_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const TENANT_ID = /^org_[A-Za-z0-9_-]{1,128}$/u;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,63}$/u;
const RULE_ID = /^dny_[A-Za-z0-9]{8,64}$/u;
const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST_PATTERN = new RegExp(
	`^(?:\\*\\.)?(?:${HOST_LABEL}\\.)+${HOST_LABEL}$`,
	"u"
);
const PATH_GLOB = /^\/[\x21-\x7e]{0,511}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const NOTE_MAX = 280;

const note = z.string().trim().min(1).max(NOTE_MAX).nullable();

export const lifecycleEntrySchema = z.strictObject({
	note,
	state: z.enum(LIFECYCLE_STATES),
	successor: z.string().regex(TOOL_ID).nullable(),
	sunsetAt: z.string().regex(DATE).nullable(),
	tool: z.string().regex(TOOL_ID),
});
export type LifecycleEntry = z.output<typeof lifecycleEntrySchema>;

export const toolPinSchema = z.strictObject({
	teamId: z.string().regex(TEAM_ID).nullable(),
	tool: z.string().regex(TOOL_ID),
	version: z.string().regex(VERSION).nullable(),
});
export type ToolPin = z.output<typeof toolPinSchema>;

export const denyRuleSchema = z.strictObject({
	host: z.string().max(253).regex(HOST_PATTERN).nullable(),
	id: z.string().regex(RULE_ID),
	methods: z.array(z.enum(POLICY_METHODS)).max(POLICY_METHODS.length),
	path: z.string().regex(PATH_GLOB).nullable(),
	reason: note,
	teamId: z.string().regex(TEAM_ID).nullable(),
	tool: z.string().regex(TOOL_PATTERN).nullable(),
});
export type DenyRule = z.output<typeof denyRuleSchema>;

export const tenantPolicySchema = z.strictObject({
	deny: z.array(denyRuleSchema).max(MAX_DENY_RULES_PER_TENANT),
	pins: z.array(toolPinSchema).max(MAX_PINS_PER_TENANT),
	/**
	 * Per-tag budgets with the control plane's spend snapshot (Treg parity
	 * C6, `./spend-tags.ts`). Absent when the organization has none, so a
	 * feed without budgets keeps its earlier shape.
	 */
	tagBudgets: tenantTagBudgetsSchema.optional(),
	tenantId: z.string().regex(TENANT_ID),
});
export type TenantPolicy = z.output<typeof tenantPolicySchema>;

export const policyFeedSchema = z.strictObject({
	generatedAt: z.iso.datetime({ offset: true }),
	lifecycle: z.array(lifecycleEntrySchema).max(MAX_LIFECYCLE_ENTRIES),
	tenants: z.array(tenantPolicySchema).max(MAX_POLICY_TENANTS),
	ttlSeconds: z.number().int().positive(),
	type: z.literal(CONNECT_POLICY_FEED_TYPE),
	version: z.string().regex(/^[0-9a-f]{64}$/u),
});
export type PolicyFeed = z.output<typeof policyFeedSchema>;

/** Why a lifecycle list or a tenant policy is not valid, or null. */
export type PolicyProblem = string | null;

/**
 * Rules a lifecycle list must keep beyond its shape: one entry per tool; a
 * successor only on a deprecated or retired tool, never itself and never a
 * retired tool; a sunset date only on a deprecated tool.
 */
export function lifecycleProblem(
	entries: readonly LifecycleEntry[]
): PolicyProblem {
	const byTool = new Map<string, LifecycleEntry>();
	for (const entry of entries) {
		if (byTool.has(entry.tool)) {
			return `duplicate lifecycle entry for ${entry.tool}`;
		}
		byTool.set(entry.tool, entry);
	}
	for (const entry of entries) {
		if (entry.successor !== null) {
			if (!(entry.state === "deprecated" || entry.state === "retired")) {
				return `${entry.tool}: only a deprecated or retired tool names a successor`;
			}
			if (entry.successor === entry.tool) {
				return `${entry.tool}: a tool cannot succeed itself`;
			}
			if (byTool.get(entry.successor)?.state === "retired") {
				return `${entry.tool}: successor ${entry.successor} is retired`;
			}
		}
		if (entry.sunsetAt !== null && entry.state !== "deprecated") {
			return `${entry.tool}: only a deprecated tool has a sunset date`;
		}
	}
	return null;
}

/**
 * Rules a tenant policy must keep beyond its shape: unique rule ids; each
 * rule names a tool pattern or a host, not both; a path or methods only with
 * a host; unique methods; one pin per team (or organization) and tool.
 */
export function tenantPolicyProblem(policy: TenantPolicy): PolicyProblem {
	const ids = new Set<string>();
	for (const rule of policy.deny) {
		if (ids.has(rule.id)) {
			return `duplicate deny rule ${rule.id}`;
		}
		ids.add(rule.id);
		if ((rule.tool === null) === (rule.host === null)) {
			return `${rule.id}: a deny rule names exactly one of tool or host`;
		}
		if (rule.host === null && (rule.path !== null || rule.methods.length > 0)) {
			return `${rule.id}: path and methods need a host`;
		}
		if (new Set(rule.methods).size !== rule.methods.length) {
			return `${rule.id}: duplicate method`;
		}
	}
	const pins = new Set<string>();
	for (const pin of policy.pins) {
		const key = `${pin.teamId ?? ""}\u0000${pin.tool}`;
		if (pins.has(key)) {
			return `duplicate pin for ${pin.tool}${pin.teamId ? ` in team ${pin.teamId}` : ""}`;
		}
		pins.add(key);
	}
	return policy.tagBudgets
		? tagBudgetsProblem(policy.tagBudgets.budgets)
		: null;
}

/** Whether a tool id matches a deny rule's tool pattern. */
export function toolPatternMatches(pattern: string, tool: string): boolean {
	return pattern.endsWith("*")
		? tool.startsWith(pattern.slice(0, -1))
		: tool === pattern;
}

/** Whether a hostname matches a rule host (`*.example.com` is subdomains only). */
export function hostPatternMatches(pattern: string, hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/u, "");
	if (pattern.startsWith("*.")) {
		return host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1;
	}
	return host === pattern;
}

/** Whether a URL path matches a path glob (`*` matches any run, `/` included). */
export function pathGlobMatches(glob: string, path: string): boolean {
	const parts = glob.split("*");
	const first = parts[0] ?? "";
	const last = parts.at(-1) ?? "";
	if (parts.length === 1) {
		return path === glob;
	}
	if (!(path.startsWith(first) && path.length >= first.length + last.length)) {
		return false;
	}
	let cursor = first.length;
	for (const middle of parts.slice(1, -1)) {
		const found = path.indexOf(middle, cursor);
		if (found < 0) {
			return false;
		}
		cursor = found + middle.length;
	}
	return path.length - last.length >= cursor && path.endsWith(last);
}

function appliesTo(teamId: string | null, callerTeam: string | null): boolean {
	return teamId === null || teamId === callerTeam;
}

/** Why a call is refused. */
export type PolicyRefusal =
	| "tool_retired"
	| "tool_denied_by_policy"
	| "tool_preview_not_pinned"
	| "tool_version_mismatch"
	| "url_denied_by_policy";

/** The HTTP status Connect answers for each refusal. */
export const POLICY_REFUSAL_STATUS: Record<PolicyRefusal, number> = {
	tool_denied_by_policy: 403,
	tool_preview_not_pinned: 403,
	tool_retired: 410,
	tool_version_mismatch: 409,
	url_denied_by_policy: 403,
};

export interface ToolDecisionInput {
	lifecycle: LifecycleEntry | undefined;
	policy: TenantPolicy | undefined;
	/** The caller's verified team, when its credential carries one. */
	teamId: string | null;
	tool: string;
	/** The version Connect serves for this tool, when it knows one. */
	version: string | null;
}

export interface ToolDecision {
	lifecycle: {
		note: string | null;
		state: LifecycleState;
		successor: string | null;
		sunsetAt: string | null;
	};
	/** Whether search and describe show the tool. */
	listed: boolean;
	pin: {
		scope: "org" | "team";
		version: string | null;
		/** False when the pinned version is not the one Connect serves. */
		satisfied: boolean;
	} | null;
	refusal: PolicyRefusal | null;
	/** The deny rule that refused the call, when one did. */
	rule: string | null;
}

/**
 * Decide one tool for one caller. Refusals in order: retired, denied by a
 * tool rule, preview without a pin, pinned to a version Connect does not
 * serve. Only the last keeps the tool listed (the pin is shown unsatisfied).
 */
export function decideTool(input: ToolDecisionInput): ToolDecision {
	const lifecycle = {
		note: input.lifecycle?.note ?? null,
		state: input.lifecycle?.state ?? "stable",
		successor: input.lifecycle?.successor ?? null,
		sunsetAt: input.lifecycle?.sunsetAt ?? null,
	};
	const pins = (input.policy?.pins ?? []).filter(
		(pin) => pin.tool === input.tool && appliesTo(pin.teamId, input.teamId)
	);
	const chosen =
		pins.find((pin) => pin.teamId !== null) ?? pins.find(() => true);
	const pin = chosen
		? {
				satisfied:
					chosen.version === null ||
					(input.version !== null && chosen.version === input.version),
				scope: chosen.teamId === null ? ("org" as const) : ("team" as const),
				version: chosen.version,
			}
		: null;
	const refused = (
		refusal: PolicyRefusal,
		rule: string | null = null
	): ToolDecision => ({
		listed: refusal === "tool_version_mismatch",
		lifecycle,
		pin,
		refusal,
		rule,
	});
	if (lifecycle.state === "retired") {
		return refused("tool_retired");
	}
	const denied = (input.policy?.deny ?? []).find(
		(rule) =>
			rule.tool !== null &&
			appliesTo(rule.teamId, input.teamId) &&
			toolPatternMatches(rule.tool, input.tool)
	);
	if (denied) {
		return refused("tool_denied_by_policy", denied.id);
	}
	if (lifecycle.state === "preview" && pin === null) {
		return refused("tool_preview_not_pinned");
	}
	if (pin && !pin.satisfied) {
		return refused("tool_version_mismatch");
	}
	return { listed: true, lifecycle, pin, refusal: null, rule: null };
}

/** The path as sent and, when it decodes, percent-decoded. */
function pathForms(pathname: string): string[] {
	try {
		const decoded = decodeURIComponent(pathname);
		return decoded === pathname ? [pathname] : [pathname, decoded];
	} catch {
		return [pathname];
	}
}

/**
 * Upstream hosts that resolve request paths case-insensitively (GitHub's
 * owner and repository names), so a deny rule there matches any casing.
 */
export const CASE_INSENSITIVE_PATH_HOSTS: ReadonlySet<string> = new Set([
	"api.github.com",
]);

/**
 * The first URL deny rule that matches an upstream request, or null. A path
 * glob is matched against the path as sent and percent-decoded, so an encoded
 * spelling of a denied path is denied too; on a host in
 * `CASE_INSENSITIVE_PATH_HOSTS` both sides are lower-cased first. Rules match
 * spellings, not resources: a vendor alias (such as GitHub's
 * `/repositories/<id>`) needs its own rule.
 */
export function deniedUrlRule(
	policy: TenantPolicy | undefined,
	teamId: string | null,
	method: string,
	url: URL
): DenyRule | null {
	const verb = method.toUpperCase();
	const folded = CASE_INSENSITIVE_PATH_HOSTS.has(url.hostname.toLowerCase());
	const fold = (value: string) => (folded ? value.toLowerCase() : value);
	const paths = pathForms(url.pathname).map(fold);
	return (
		(policy?.deny ?? []).find(
			(rule) =>
				rule.host !== null &&
				appliesTo(rule.teamId, teamId) &&
				hostPatternMatches(rule.host, url.hostname) &&
				(rule.path === null ||
					paths.some((path) => pathGlobMatches(fold(rule.path ?? ""), path))) &&
				(rule.methods.length === 0 ||
					rule.methods.some((allowed) => allowed === verb))
		) ?? null
	);
}
