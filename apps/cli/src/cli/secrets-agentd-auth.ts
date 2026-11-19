// Auto-auth for `ryu secrets agent`: log in with the configured machine
// credential, keep the vault token renewed, log in again when it can no longer
// be renewed, and write it to the configured sinks so other processes on the
// host can use it without logging in themselves.

import { ApiError } from "@ryuhq/core-client/client";
import {
	type VaultAgentTarget,
	vaultAgentLookupSelf,
	vaultAgentRenewSelf,
	vaultAppRoleLogin,
	vaultJwtLogin,
} from "@ryuhq/core-client/vault";
import type { AgentAuth, AgentConfig } from "./secrets-agentd-config.ts";
import { readCredentialFile, writeIfChanged } from "./secrets-agentd-files.ts";
import { timestampMs } from "./secrets-agentd-schedule.ts";
import { machineTarget } from "./secrets-output.ts";
import { type CliContext, UsageError } from "./types.ts";

/** The parts of the CLI context the agent uses, so tests can drive it
 *  directly with a fake clock. */
export type AgentContext = Pick<CliContext, "env" | "io" | "spawn" | "target">;

export interface TokenState {
	expiresAtMs: number | null;
	renewable: boolean;
	token: string;
}

/** Whether `auth` can produce a new token once the current one ends. */
export function canLogInAgain(auth: AgentAuth): boolean {
	return auth.kind !== "env";
}

/** Log in (or read the token) with the configured method. */
async function obtainToken(
	ctx: AgentContext,
	auth: AgentAuth
): Promise<string> {
	if (auth.kind === "env") {
		const token = ctx.env.RYU_VAULT_TOKEN?.trim();
		if (!token) {
			throw new UsageError(
				'The agent config uses "method": "env", but RYU_VAULT_TOKEN is not set.'
			);
		}
		return token;
	}
	if (auth.kind === "token") {
		return await readCredentialFile(auth.tokenFile);
	}
	const target = machineTarget(ctx);
	if (auth.kind === "jwt") {
		const jwt = await readCredentialFile(auth.jwtFile);
		const { token } = await vaultJwtLogin(target, {
			identity: auth.identity,
			jwt,
		});
		return token.token;
	}
	const roleId =
		auth.roleId ?? (await readCredentialFile(auth.roleIdFile ?? ""));
	const secretId = await readCredentialFile(auth.secretIdFile);
	const { token } = await vaultAppRoleLogin(target, { roleId, secretId });
	return token.token;
}

export function agentTargetFor(
	ctx: AgentContext,
	token: string
): VaultAgentTarget {
	return { ...machineTarget(ctx), vaultToken: token };
}

/** Log in and read the new token's lifetime. */
export async function authenticate(
	ctx: AgentContext,
	auth: AgentAuth
): Promise<TokenState> {
	const token = await obtainToken(ctx, auth);
	const { token: info } = await vaultAgentLookupSelf(
		agentTargetFor(ctx, token)
	);
	return {
		token,
		renewable: info.renewable,
		expiresAtMs: timestampMs(info.expiresAt),
	};
}

export function refusedByCore(error: unknown): boolean {
	return (
		error instanceof ApiError && (error.status === 401 || error.status === 403)
	);
}

/**
 * Renew the token. Resolves the renewed state, or null when the token must be
 * replaced by a fresh login: it is not renewable, Core refused it, or the
 * renewal no longer extends it (it reached its maximum lifetime). Any other
 * failure (an outage) is thrown, so the caller retries.
 */
export async function renewToken(
	ctx: AgentContext,
	current: TokenState
): Promise<TokenState | null> {
	if (!current.renewable) {
		return null;
	}
	try {
		const { token: info } = await vaultAgentRenewSelf(
			agentTargetFor(ctx, current.token)
		);
		const expiresAtMs = timestampMs(info.expiresAt);
		if (
			expiresAtMs === null ||
			(current.expiresAtMs !== null && expiresAtMs <= current.expiresAtMs)
		) {
			return null;
		}
		return { token: current.token, renewable: info.renewable, expiresAtMs };
	} catch (error) {
		if (refusedByCore(error)) {
			return null;
		}
		throw error;
	}
}

/** Write the token to every sink whose content differs. */
export async function writeSinks(
	sinks: AgentConfig["sinks"],
	token: string
): Promise<void> {
	for (const sink of sinks) {
		await writeIfChanged(sink.path, token, sink.mode);
	}
}
