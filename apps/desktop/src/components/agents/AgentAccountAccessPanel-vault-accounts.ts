import { z } from "zod";
import { type ApiTarget, request } from "@/src/lib/api/client.ts";

/** One of the agent's own website logins (PR #749 vault agent accounts). */
export interface VaultAgentAccount {
	email: string | null;
	hasTotp: boolean;
	host: string;
	id: string;
	label: string | null;
	site: string;
	/** Login URLs a session Box fill may submit the password to. */
	submitUrls: string[];
	username: string | null;
}

const vaultAgentAccountsResponseCodec = z
	.object({
		accounts: z
			.array(
				z
					.object({
						email: z.string().nullish(),
						has_totp: z.boolean().optional(),
						host: z.string(),
						id: z.string(),
						label: z.string().nullish(),
						site: z.string(),
						submit_urls: z.array(z.string()).catch(() => []),
						username: z.string().nullish(),
					})
					.passthrough()
			)
			.optional(),
	})
	.passthrough();

/** GET /api/vault/agent-accounts?agent_id= — metadata only, never a secret. */
export async function fetchVaultAgentAccounts(
	target: ApiTarget,
	agentId: string
): Promise<VaultAgentAccount[]> {
	const json = await request(
		target,
		`/api/vault/agent-accounts?agent_id=${encodeURIComponent(agentId)}`,
		undefined,
		vaultAgentAccountsResponseCodec
	);
	return (json.accounts ?? []).map((account) => ({
		email: account.email ?? null,
		hasTotp: account.has_totp ?? false,
		host: account.host,
		id: account.id,
		label: account.label ?? null,
		site: account.site,
		submitUrls: account.submit_urls ?? [],
		username: account.username ?? null,
	}));
}

const loginUrlsResponseCodec = z
	.object({
		account: z
			.object({ submit_urls: z.array(z.string()).catch(() => []) })
			.passthrough(),
	})
	.passthrough();

/** The login URLs in an editor's text: one per line, blank lines skipped. */
export function parseLoginUrlLines(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
}

/**
 * PUT /api/vault/agent-accounts/login-urls?agent_id= — replace the login URLs
 * of one of the agent's accounts. They decide where a session Box fill may
 * submit the account's password; Core validates them like create and audits
 * the change. Returns the stored URLs.
 */
export async function setVaultAgentAccountLoginUrls(
	target: ApiTarget,
	agentId: string,
	accountId: string,
	submitUrls: readonly string[]
): Promise<string[]> {
	const json = await request(
		target,
		`/api/vault/agent-accounts/login-urls?agent_id=${encodeURIComponent(agentId)}`,
		{
			method: "PUT",
			body: { account: accountId, submit_urls: submitUrls },
		},
		loginUrlsResponseCodec
	);
	return json.account.submit_urls;
}
