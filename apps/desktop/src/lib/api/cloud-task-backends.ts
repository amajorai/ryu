// apps/desktop/src/lib/api/cloud-task-backends.ts
//
// Typed client for where a cloud task runs (`/api/cloud-task-backends`): the Ryu Box
// (Ryu credits) or the node owner's own Claude or ChatGPT plan, through the Claude
// Code or Codex CLI they signed in on the node themselves: in the provider's cloud
// (`claude --cloud`, `codex cloud exec`) or on the node itself (`claude -p`, the
// runtime the Claude Agent SDK drives, or `codex exec`, the runtime the Codex SDK
// drives).
//
// The desktop never sees a plan credential. Core reads only each CLI's status
// command, and "Sign in" asks Core to start the CLI's own sign-in, which opens the
// provider's page in the browser. See docs/subscription-cloud-sessions.md.

import { ApiError, type ApiTarget, request } from "./client.ts";
import {
	bool,
	invalid,
	num,
	oneOf,
	optNum,
	optStr,
	PLAN_PROVIDERS,
	type PlanProvider,
	providerLink,
	record,
	str,
} from "./cloud-task-wire.ts";
import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";

export {
	addPlanAccount,
	clearPlanAccountCooldown,
	fetchPlanAccounts,
	fetchPlanSessions,
	type PlanAccountView,
	type PlanSession,
	parseAccounts,
	parseSessions,
	removePlanAccount,
	signInPlanAccount,
} from "./cloud-task-plan-accounts.ts";
export { PLAN_PROVIDERS, type PlanProvider } from "./cloud-task-wire.ts";

export type CloudTaskBackendId =
	| "ryu-box"
	| "anthropic-subscription-cli"
	| "anthropic-subscription-sdk"
	| "openai-subscription-cli"
	| "openai-subscription-sdk";

export const CLOUD_TASK_BACKEND_IDS: readonly CloudTaskBackendId[] = [
	"ryu-box",
	"anthropic-subscription-cli",
	"anthropic-subscription-sdk",
	"openai-subscription-cli",
	"openai-subscription-sdk",
];

export const CLOUD_TASK_BACKEND_LABELS: Record<CloudTaskBackendId, string> = {
	"ryu-box": "Ryu Box",
	"anthropic-subscription-cli": "Your Claude plan (Claude cloud)",
	"anthropic-subscription-sdk": "Your Claude plan (on this computer)",
	"openai-subscription-cli": "Your ChatGPT plan (Codex cloud)",
	"openai-subscription-sdk": "Your ChatGPT plan (on this computer)",
};

/** The agent each plan backend can run. The Ryu Box runs every agent. */
export const PLAN_BACKEND_EXECUTOR: Record<
	Exclude<CloudTaskBackendId, "ryu-box">,
	"claude-code" | "codex"
> = {
	"anthropic-subscription-cli": "claude-code",
	"anthropic-subscription-sdk": "claude-code",
	"openai-subscription-cli": "codex",
	"openai-subscription-sdk": "codex",
};

export type CloudTaskSignIn = "subscription" | "other_method" | "signed_out";

/** Which session features a backend supports, so the UI can say what is missing. */
export interface CloudTaskBackendFeatures {
	diffInRyu: boolean;
	followUp: boolean;
	liveScreen: boolean;
	liveStatus: boolean;
	pullRequestInRyu: boolean;
	runLog: boolean;
	ryuCredits: boolean;
	stopFromRyu: boolean;
}

export interface CloudTaskBackendView {
	backend: CloudTaskBackendId;
	billing: "ryu-credits" | "user-plan";
	cooldownSecondsRemaining: number | null;
	features: CloudTaskBackendFeatures;
	installed: boolean;
	signIn: CloudTaskSignIn | null;
	signInCommand: string | null;
}

export interface CloudTaskEnvironmentLink {
	claudeCheckout?: string;
	codexEnvironmentId?: string;
}

/** The CLI's own default sign-in on the node, which Ryu cannot remove. */
export const DEFAULT_ACCOUNT_ID = "default";

/** The provider whose plan a backend uses. */
export const BACKEND_PROVIDER: Record<
	Exclude<CloudTaskBackendId, "ryu-box">,
	PlanProvider
> = {
	"anthropic-subscription-cli": "anthropic",
	"anthropic-subscription-sdk": "anthropic",
	"openai-subscription-cli": "openai",
	"openai-subscription-sdk": "openai",
};

export interface CloudTaskRoutingSettings {
	/** Accounts tried, in order, only after the chosen account hits its limit. */
	accountFallbacks: Partial<Record<PlanProvider, string[]>>;
	/** Per-agent account, by agent id then provider. */
	agentAccounts: Record<string, Partial<Record<PlanProvider, string>>>;
	agentOverrides: Record<string, CloudTaskBackendId[]>;
	/** The account each provider uses unless the session or agent picks one. */
	defaultAccounts: Partial<Record<PlanProvider, string>>;
	defaultOrder: CloudTaskBackendId[];
	enabled: boolean;
	environments: Record<string, CloudTaskEnvironmentLink>;
}

export interface CloudTaskBackendsView {
	backends: CloudTaskBackendView[];
	/** Whether this caller is the node owner (only they may use its plans). */
	owner: boolean;
	rollout: boolean;
	settings: CloudTaskRoutingSettings | null;
}

/** Why a preferred plan was skipped for a task. */
export interface CloudTaskNotice {
	/** The account it is about, when it is about one. */
	accountId: string | null;
	backend: CloudTaskBackendId;
	code: string;
	/** The sentence as a Core message (`{ message, args }`); null from an older Core. */
	i18n: unknown;
	/** The English sentence. */
	message: string;
}

/** A cloud task that runs on the owner's plan. */
export interface SubscriptionRun {
	/** The account that started the run; it never moves to another. */
	accountId: string;
	backend: CloudTaskBackendId;
	/** The run's branch in the owner's checkout (runs on this computer). */
	branch: string | null;
	conversationId: string;
	createdAt: number;
	environmentId: string;
	executor: string;
	externalId: string | null;
	features: CloudTaskBackendFeatures;
	lastError: string | null;
	/** The run's own words so far, redacted (runs on this computer). */
	outputTail: string | null;
	status: string;
	summary: string | null;
	updatedAt: number;
	url: string | null;
}

/** What a run on this computer changed in its worktree. */
export interface SubscriptionRunDiff {
	branch: string | null;
	files: string[];
	patch: string;
	truncated: boolean;
}

export function parseBackendId(value: unknown): CloudTaskBackendId {
	return oneOf(value, CLOUD_TASK_BACKEND_IDS);
}

function parseFeatures(value: unknown): CloudTaskBackendFeatures {
	const raw = record(value);
	return {
		diffInRyu: bool(raw.diffInRyu),
		followUp: bool(raw.followUp),
		liveScreen: bool(raw.liveScreen),
		liveStatus: bool(raw.liveStatus),
		pullRequestInRyu: bool(raw.pullRequestInRyu),
		runLog: bool(raw.runLog),
		ryuCredits: bool(raw.ryuCredits),
		stopFromRyu: bool(raw.stopFromRyu),
	};
}

function parseOrder(value: unknown): CloudTaskBackendId[] {
	return Array.isArray(value) ? value.map(parseBackendId) : invalid();
}

export function parseRoutingSettings(value: unknown): CloudTaskRoutingSettings {
	const raw = record(value);
	const agentOverrides: Record<string, CloudTaskBackendId[]> = {};
	for (const [agent, order] of Object.entries(
		record(raw.agentOverrides ?? {})
	)) {
		agentOverrides[agent] = parseOrder(order);
	}
	const environments: Record<string, CloudTaskEnvironmentLink> = {};
	for (const [id, link] of Object.entries(record(raw.environments ?? {}))) {
		const entry = record(link);
		environments[id] = {
			claudeCheckout: optStr(entry.claudeCheckout) ?? undefined,
			codexEnvironmentId: optStr(entry.codexEnvironmentId) ?? undefined,
		};
	}
	const provider = (value: unknown): PlanProvider =>
		oneOf(value, PLAN_PROVIDERS);
	const byProvider = (
		value: unknown
	): Partial<Record<PlanProvider, string>> => {
		const out: Partial<Record<PlanProvider, string>> = {};
		for (const [key, id] of Object.entries(record(value ?? {}))) {
			out[provider(key)] = str(id);
		}
		return out;
	};
	const agentAccounts: Record<
		string,
		Partial<Record<PlanProvider, string>>
	> = {};
	for (const [agent, choice] of Object.entries(
		record(raw.agentAccounts ?? {})
	)) {
		agentAccounts[agent] = byProvider(choice);
	}
	const accountFallbacks: Partial<Record<PlanProvider, string[]>> = {};
	for (const [key, order] of Object.entries(
		record(raw.accountFallbacks ?? {})
	)) {
		accountFallbacks[provider(key)] = Array.isArray(order)
			? order.map(str)
			: invalid();
	}
	return {
		accountFallbacks,
		agentAccounts,
		agentOverrides,
		defaultAccounts: byProvider(raw.defaultAccounts),
		defaultOrder: parseOrder(raw.defaultOrder),
		enabled: bool(raw.enabled),
		environments,
	};
}

export function parseBackendsView(value: unknown): CloudTaskBackendsView {
	const raw = record(value);
	const backends = Array.isArray(raw.backends) ? raw.backends : invalid();
	return {
		backends: backends.map((entry) => {
			const backend = record(entry);
			return {
				backend: parseBackendId(backend.backend),
				billing: oneOf(backend.billing, ["ryu-credits", "user-plan"] as const),
				cooldownSecondsRemaining: optNum(backend.cooldownSecondsRemaining),
				features: parseFeatures(backend.features),
				installed: bool(backend.installed),
				signIn:
					backend.signIn === null || backend.signIn === undefined
						? null
						: oneOf(backend.signIn, [
								"subscription",
								"other_method",
								"signed_out",
							] as const),
				signInCommand: optStr(backend.signInCommand),
			};
		}),
		owner: bool(raw.owner),
		rollout: bool(raw.rollout),
		settings:
			raw.settings === null || raw.settings === undefined
				? null
				: parseRoutingSettings(raw.settings),
	};
}

export function parseNotices(value: unknown): CloudTaskNotice[] {
	if (value === undefined || value === null) {
		return [];
	}
	return Array.isArray(value)
		? value.map((entry) => {
				const notice = record(entry);
				return {
					accountId: optStr(notice.accountId),
					backend: parseBackendId(notice.backend),
					code: str(notice.code),
					i18n: notice.i18n ?? null,
					message: str(notice.message),
				};
			})
		: invalid();
}

export function parseSubscriptionRun(value: unknown): SubscriptionRun {
	const raw = record(value);
	return {
		accountId: optStr(raw.accountId) ?? DEFAULT_ACCOUNT_ID,
		backend: parseBackendId(raw.backend),
		branch: optStr(raw.branch),
		conversationId: str(raw.conversationId),
		createdAt: num(raw.createdAt),
		environmentId: str(raw.environmentId),
		executor: str(raw.executor),
		externalId: optStr(raw.externalId),
		features: parseFeatures(raw.features),
		lastError: optStr(raw.lastError),
		outputTail: optStr(raw.outputTail),
		status: str(raw.status),
		summary: optStr(raw.summary),
		updatedAt: num(raw.updatedAt),
		url: providerLink(raw.url),
	};
}

const BASE = "/api/cloud-task-backends";

/** The backends this node offers this caller. Null on an older Core without the route. */
export async function fetchCloudTaskBackends(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<CloudTaskBackendsView | null> {
	try {
		const raw = await request<unknown>(
			target,
			BASE,
			{ signal },
			gatewayJsonValueSchema
		);
		return parseBackendsView(raw);
	} catch (error) {
		if (error instanceof ApiError && error.status === 404) {
			return null;
		}
		throw error;
	}
}

export async function saveCloudTaskRouting(
	target: ApiTarget,
	settings: CloudTaskRoutingSettings
): Promise<CloudTaskRoutingSettings> {
	const raw = await request<unknown>(
		target,
		`${BASE}/routing`,
		{ method: "PUT", body: settings },
		gatewayJsonValueSchema
	);
	return parseRoutingSettings(raw);
}

/** Start the provider CLI's own sign-in on the node. Ryu never receives the credential. */
export async function startCloudTaskBackendSignIn(
	target: ApiTarget,
	backend: Exclude<CloudTaskBackendId, "ryu-box">
): Promise<void> {
	await request<unknown>(
		target,
		`${BASE}/${encodeURIComponent(backend)}/sign-in`,
		{ method: "POST" },
		gatewayJsonValueSchema
	);
}

export async function clearCloudTaskBackendCooldown(
	target: ApiTarget,
	backend: Exclude<CloudTaskBackendId, "ryu-box">
): Promise<void> {
	await request<unknown>(
		target,
		`${BASE}/${encodeURIComponent(backend)}/cooldown`,
		{ method: "DELETE" },
		gatewayJsonValueSchema
	);
}

/** The conversation's run on the owner's plan, or null when it runs elsewhere. */
export async function fetchSubscriptionRun(
	target: ApiTarget,
	conversationId: string,
	signal?: AbortSignal
): Promise<SubscriptionRun | null> {
	try {
		const raw = await request<unknown>(
			target,
			`/api/cloud-tasks/${encodeURIComponent(conversationId)}/subscription-run`,
			{ signal },
			gatewayJsonValueSchema
		);
		return parseSubscriptionRun(raw);
	} catch (error) {
		if (error instanceof ApiError && error.status === 404) {
			return null;
		}
		throw error;
	}
}

export function parseSubscriptionRunDiff(value: unknown): SubscriptionRunDiff {
	const raw = record(value);
	const files = Array.isArray(raw.files) ? raw.files.map(str) : invalid();
	return {
		branch: optStr(raw.branch),
		files,
		patch: str(raw.patch),
		truncated: bool(raw.truncated),
	};
}

const runPath = (conversationId: string, suffix: string) =>
	`/api/cloud-tasks/${encodeURIComponent(conversationId)}/subscription-run/${suffix}`;

/** Stop the conversation's run on this computer. Its worktree and branch are kept. */
export async function stopSubscriptionRun(
	target: ApiTarget,
	conversationId: string
): Promise<void> {
	await request<unknown>(
		target,
		runPath(conversationId, "stop"),
		{ method: "POST" },
		gatewayJsonValueSchema
	);
}

export async function fetchSubscriptionRunDiff(
	target: ApiTarget,
	conversationId: string,
	signal?: AbortSignal
): Promise<SubscriptionRunDiff> {
	const raw = await request<unknown>(
		target,
		runPath(conversationId, "diff"),
		{ signal },
		gatewayJsonValueSchema
	);
	return parseSubscriptionRunDiff(raw);
}
