// Which broker services name a vault value as their credential
// (`GET /api/vault/broker/usage?ref=secret:NAME`). Core lists only services
// the caller holds a capability on, by name; nothing here carries a value.

import { z } from "zod";
import { type ApiTarget, request } from "./client.ts";

const usageSchema = z
	.object({ services: z.array(z.string()).optional() })
	.passthrough();

/** Names of the broker services that use `secret:NAME`, sorted. */
export async function listVaultBrokerUsage(
	target: ApiTarget,
	name: string
): Promise<string[]> {
	const raw = await request(
		target,
		`/api/vault/broker/usage?ref=${encodeURIComponent(`secret:${name}`)}`,
		undefined,
		usageSchema
	);
	return [...(raw?.services ?? [])].sort();
}
