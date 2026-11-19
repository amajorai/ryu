// packages/core-client/src/vault/quotas.ts
//
// Request quotas (`/api/vault/sys/quotas`): part of the Secret Vault client.
// `../vault.ts` re-exports these names and documents the wire conventions.
// Every route needs `admin` on `sys/quotas`.
//
// Shapes follow `apps/core/src/vault/quotas.rs` (`QuotaRule` is internally
// tagged by `kind`; `Quota` flattens it) as rendered by
// `server/vault_tokens_api/lease_routes.rs`.

import { z } from "zod";
import { type ApiTarget, request } from "../client.ts";
import {
	vaultDate,
	vaultNumber,
	vaultReply,
	vaultText,
} from "./codecs-machine.ts";
import type { VaultTimestamp } from "./shared.ts";

/** A token bucket per client over vault routes under `path`. */
export interface VaultRateLimitRule {
	/** Once exceeded, refuse the client for this long. */
	blockIntervalSecs?: number | null;
	intervalSecs?: number;
	kind: "rate-limit";
	/** Prefix relative to `/api/vault/` (`auth/`) or absolute; empty is every route. */
	path?: string;
	/** Requests allowed per interval. */
	rate: number;
}

/** A cap on live dynamic-secret leases for roles matching a glob. */
export interface VaultLeaseCountRule {
	kind: "lease-count";
	maxLeases: number;
	/** Dynamic role glob (`*` is every role). */
	role: string;
}

export type VaultQuotaRule = VaultRateLimitRule | VaultLeaseCountRule;

interface VaultQuotaRecord {
	/** Built-in quotas come from configuration and cannot be edited. */
	builtin: boolean;
	createdAt: VaultTimestamp;
	name: string;
	updatedAt: VaultTimestamp;
}

export type VaultQuota =
	| (VaultQuotaRecord &
			Required<Omit<VaultRateLimitRule, "blockIntervalSecs">> & {
				blockIntervalSecs: number | null;
			})
	| (VaultQuotaRecord & VaultLeaseCountRule);

export interface VaultLeaseCounts {
	byRole: Record<string, number>;
	total: number;
}

const record = {
	name: vaultText,
	builtin: z.boolean(),
	createdAt: vaultDate,
	updatedAt: vaultDate,
};
const quotaFields = z.discriminatedUnion("kind", [
	z.object({
		...record,
		kind: z.literal("rate-limit"),
		path: vaultText,
		rate: vaultNumber,
		intervalSecs: vaultNumber,
		blockIntervalSecs: vaultNumber.nullable(),
	}),
	z.object({
		...record,
		kind: z.literal("lease-count"),
		role: vaultText,
		maxLeases: vaultNumber,
	}),
]);

const quotasReply = vaultReply<{
	leases: VaultLeaseCounts;
	quotas: VaultQuota[];
}>(
	z.object({
		quotas: z.array(quotaFields),
		leases: z.object({
			total: vaultNumber,
			byRole: z.record(z.string(), vaultNumber),
		}),
	})
);
const quotaReply = vaultReply<{ quota: VaultQuota }>(
	z.object({ quota: quotaFields })
);
const deletedReply = vaultReply<{ deleted: boolean }>(
	z.object({ deleted: z.boolean() })
);

function quotaPath(name: string): string {
	return `/api/vault/sys/quotas/${encodeURIComponent(name)}`;
}

/** Quotas (including the built-in `default-login`) and live lease counts. */
export function listVaultQuotas(
	target: ApiTarget
): Promise<{ leases: VaultLeaseCounts; quotas: VaultQuota[] }> {
	return request(target, "/api/vault/sys/quotas", {}, quotasReply);
}

/** Create or replace a quota. `default-login` cannot be replaced. */
export function putVaultQuota(
	target: ApiTarget,
	name: string,
	rule: VaultQuotaRule
): Promise<{ quota: VaultQuota }> {
	return request(
		target,
		quotaPath(name),
		{ method: "PUT", body: rule },
		quotaReply
	);
}

export function deleteVaultQuota(
	target: ApiTarget,
	name: string
): Promise<{ deleted: boolean }> {
	return request(target, quotaPath(name), { method: "DELETE" }, deletedReply);
}
