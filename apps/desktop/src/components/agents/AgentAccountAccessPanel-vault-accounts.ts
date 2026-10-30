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
		username: account.username ?? null,
	}));
}
