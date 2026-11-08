// Agent-side credential broker access with a broker session.
//
// An agent Ryu starts through the broker holds an `rvb_` session in its proxy
// variables (`HTTPS_PROXY=http://rvb:<session>@127.0.0.1:<port>`). The agent
// routes (`/api/vault/agent/broker/discover` and `/proposals`) accept that
// session as `Authorization: Bearer rvb_…`, so the agent can list what it may
// reach and ask a person for a missing host or credential without a vault
// token. The session never returns a credential value.
//
// `brokerSessionTarget` adapts a session into the `VaultAgentTarget` the
// `vaultAgentBroker*` functions in `./vault.ts` take: it sends no vault token
// and adds the session as the bearer on each request.

import { fetchForTarget, type RyuFetch } from "./client.ts";
import type { VaultAgentTarget, VaultMachineTarget } from "./vault.ts";

/** Set to an `rvb_` session to use it outside the proxy variables. */
export const BROKER_SESSION_ENV = "RYU_VAULT_BROKER_SESSION";

const SESSION_PREFIX = "rvb_";
const PROXY_VARIABLES = [
	"HTTPS_PROXY",
	"https_proxy",
	"HTTP_PROXY",
	"http_proxy",
];

function sessionToken(value: string | undefined): string | null {
	const token = value?.trim() ?? "";
	return token.startsWith(SESSION_PREFIX) &&
		token.length > SESSION_PREFIX.length
		? token
		: null;
}

function sessionInProxyUrl(value: string | undefined): string | null {
	if (!value) {
		return null;
	}
	try {
		return sessionToken(decodeURIComponent(new URL(value).password));
	} catch {
		return null;
	}
}

/**
 * The broker session this process runs under: `RYU_VAULT_BROKER_SESSION`,
 * else the `rvb_` password in a proxy variable. Null when there is none.
 */
export function brokerSessionFromEnv(
	env: Record<string, string | undefined>
): string | null {
	const explicit = sessionToken(env[BROKER_SESSION_ENV]);
	if (explicit) {
		return explicit;
	}
	for (const name of PROXY_VARIABLES) {
		const session = sessionInProxyUrl(env[name]);
		if (session) {
			return session;
		}
	}
	return null;
}

/** An agent target that authenticates with a broker session. */
export function brokerSessionTarget(
	target: VaultMachineTarget,
	session: string
): VaultAgentTarget {
	const base = fetchForTarget(target);
	const fetch: RyuFetch = (input, init) => {
		const headers = new Headers(init?.headers);
		headers.set("Authorization", `Bearer ${session}`);
		return base(input, { ...init, headers });
	};
	// An empty vault token sends no `x-ryu-vault-token`, so Core reads the
	// session from `Authorization`.
	return { url: target.url, vaultToken: "", fetch };
}
