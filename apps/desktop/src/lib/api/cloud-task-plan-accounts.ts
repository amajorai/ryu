// apps/desktop/src/lib/api/cloud-task-plan-accounts.ts
//
// The owner's plan accounts (`/api/cloud-task-backends/accounts`) and the
// combined session list across them. Re-exported from `cloud-task-backends.ts`.

import { ApiError, type ApiTarget, request } from "./client.ts";
import type { CloudTaskSignIn } from "./cloud-task-backends.ts";
import {
	bool,
	invalid,
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

/** A plan account: the CLI's own sign-in, or a linked account with its own folder. */
export interface PlanAccountView {
	builtin: boolean;
	cooldownSecondsRemaining: number | null;
	createdAt: number | null;
	id: string;
	installed: boolean;
	isDefault: boolean;
	label: string;
	provider: PlanProvider;
	signIn: CloudTaskSignIn | null;
	/** "Claude · work". */
	tag: string;
}

/** A session in the combined list across accounts. */
export interface PlanSession {
	accountId: string;
	conversationId: string | null;
	externalId: string | null;
	provider: PlanProvider;
	status: string | null;
	tag: string;
	title: string | null;
	updatedAt: number | null;
	url: string | null;
}

export function parseAccounts(value: unknown): PlanAccountView[] {
	const list = record(value).accounts;
	if (!Array.isArray(list)) {
		invalid();
	}
	return list.map((entry) => {
		const raw = record(entry);
		return {
			builtin: bool(raw.builtin),
			cooldownSecondsRemaining: optNum(raw.cooldownSecondsRemaining),
			createdAt: optNum(raw.createdAt),
			id: str(raw.id),
			installed: bool(raw.installed),
			isDefault: bool(raw.isDefault),
			label: str(raw.label),
			provider: oneOf(raw.provider, PLAN_PROVIDERS),
			signIn:
				raw.signIn === null || raw.signIn === undefined
					? null
					: oneOf(raw.signIn, [
							"subscription",
							"other_method",
							"signed_out",
						] as const),
			tag: str(raw.tag),
		};
	});
}

export function parseSessions(value: unknown): PlanSession[] {
	const list = record(value).sessions;
	if (!Array.isArray(list)) {
		invalid();
	}
	return list.map((entry) => {
		const raw = record(entry);
		return {
			accountId: str(raw.accountId),
			conversationId: optStr(raw.conversationId),
			externalId: optStr(raw.externalId),
			provider: oneOf(raw.provider, PLAN_PROVIDERS),
			status: optStr(raw.status),
			tag: str(raw.tag),
			title: optStr(raw.title),
			updatedAt: optNum(raw.updatedAt),
			url: providerLink(raw.url),
		};
	});
}

const ACCOUNTS = "/api/cloud-task-backends/accounts";

const accountPath = (provider: PlanProvider, id: string, suffix = "") =>
	`${ACCOUNTS}/${provider}/${encodeURIComponent(id)}${suffix}`;

/** The owner's plan accounts. Null on an older Core without the route. */
export async function fetchPlanAccounts(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<PlanAccountView[] | null> {
	try {
		const raw = await request<unknown>(
			target,
			ACCOUNTS,
			{ signal },
			gatewayJsonValueSchema
		);
		return parseAccounts(raw);
	} catch (error) {
		if (error instanceof ApiError && error.status === 404) {
			return null;
		}
		throw error;
	}
}

/** Link another account: Core makes its folder and starts the CLI's own sign-in. */
export async function addPlanAccount(
	target: ApiTarget,
	provider: PlanProvider,
	label: string
): Promise<void> {
	await request<unknown>(
		target,
		ACCOUNTS,
		{ method: "POST", body: { provider, label } },
		gatewayJsonValueSchema
	);
}

export async function signInPlanAccount(
	target: ApiTarget,
	provider: PlanProvider,
	id: string
): Promise<void> {
	await request<unknown>(
		target,
		accountPath(provider, id, "/sign-in"),
		{ method: "POST" },
		gatewayJsonValueSchema
	);
}

/** Unlink an account. Deletes its folder and the CLI's sign-in in it. */
export async function removePlanAccount(
	target: ApiTarget,
	provider: PlanProvider,
	id: string
): Promise<void> {
	await request<unknown>(
		target,
		accountPath(provider, id),
		{ method: "DELETE", body: { confirm: true } },
		gatewayJsonValueSchema
	);
}

export async function clearPlanAccountCooldown(
	target: ApiTarget,
	provider: PlanProvider,
	id: string
): Promise<void> {
	await request<unknown>(
		target,
		accountPath(provider, id, "/cooldown"),
		{ method: "DELETE" },
		gatewayJsonValueSchema
	);
}

/** Every plan session across the owner's accounts, tagged by account. */
export async function fetchPlanSessions(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<PlanSession[]> {
	const raw = await request<unknown>(
		target,
		"/api/cloud-task-backends/sessions",
		{ signal },
		gatewayJsonValueSchema
	);
	return parseSessions(raw);
}
