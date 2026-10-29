import type { ApiTarget as SharedApiTarget } from "@ryuhq/core-client/client.ts";
import {
	getPrimaryBot as getSelection,
	setPrimaryBot as setSelection,
} from "@ryuhq/core-client/primary-bot.ts";
import { getActiveUserId, listAccounts } from "@/lib/auth-client.ts";
import { useAppStore } from "@/src/store/useAppStore.ts";
import {
	type ApiTarget,
	apiUrl,
	requestHeaders,
	USER_JWT_HEADER,
} from "./client.ts";

/** The signed-in account a primary-bot read or write belongs to. */
export interface PrimaryBotIdentity {
	accountId: string | null;
	anonymous: boolean;
	oidcEmail: string | null;
}

export function capturePrimaryBotIdentity(): PrimaryBotIdentity {
	let accountId: string | null = null;
	let anonymous = false;
	try {
		accountId = getActiveUserId();
		const account = listAccounts().find((entry) => entry.userId === accountId);
		anonymous = account?.isAnonymous === true;
	} catch {
		/* Headless host without an account vault. */
	}
	return {
		accountId,
		anonymous,
		oidcEmail: useAppStore.getState().oidcUser?.email ?? null,
	};
}

function requireSameIdentity(expected: PrimaryBotIdentity) {
	const current = capturePrimaryBotIdentity();
	if (
		current.accountId !== expected.accountId ||
		current.anonymous !== expected.anonymous ||
		current.oidcEmail !== expected.oidcEmail
	) {
		throw new Error(
			"Your account changed. Reload the primary bot selection before trying again."
		);
	}
}

function headerRecord(init: RequestInit | undefined): Record<string, string> {
	const record: Record<string, string> = {};
	new Headers(init?.headers).forEach((value, name) => {
		record[name] = value;
	});
	return record;
}

/** Keep the canonical contract while using Desktop's protected verified-user headers. */
function authenticatedTarget(
	target: ApiTarget,
	identity: PrimaryBotIdentity
): SharedApiTarget {
	return {
		...target,
		fetch: async (input, init) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			requireSameIdentity(identity);
			const headers = await requestHeaders(target, headerRecord(init));
			requireSameIdentity(identity);
			// A signed-in human must never be read or written in the node
			// operator's scope because their identity token was unavailable.
			const signedIn =
				Boolean(identity.accountId && !identity.anonymous) ||
				Boolean(identity.oidcEmail);
			if (signedIn && !headers[USER_JWT_HEADER]) {
				throw new Error(
					"Reconnect your signed-in account before reading or changing the primary bot."
				);
			}
			const response = await fetch(
				apiUrl(target, `${url.pathname}${url.search}`),
				{ ...init, headers }
			);
			requireSameIdentity(identity);
			return response;
		},
	};
}

export function getPrimaryBot(
	target: ApiTarget,
	identity = capturePrimaryBotIdentity()
) {
	return getSelection(authenticatedTarget(target, identity));
}

export function setPrimaryBot(
	target: ApiTarget,
	input: { agentId: string | null; expectedRevision: number },
	identity = capturePrimaryBotIdentity()
) {
	return setSelection(authenticatedTarget(target, identity), input);
}
