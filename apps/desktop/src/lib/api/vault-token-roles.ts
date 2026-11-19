// Token roles (`/api/vault/token-roles`): named templates a machine token is
// minted from. A role holds policy names and TTL limits, never a token.

import type {
	VaultTokenRole,
	VaultTokenRoleInput,
} from "@ryuhq/core-client/vault.ts";
import { z } from "zod";
import { type ApiTarget, request } from "./client.ts";

export type {
	VaultTokenRole,
	VaultTokenRoleInput,
} from "@ryuhq/core-client/vault.ts";

const timestamp = z.union([z.string(), z.number()]);

const roleSchema = z
	.object({
		allowedPolicies: z.array(z.string()),
		boundCidrs: z.array(z.string()).optional(),
		createdAt: timestamp,
		disallowedPolicies: z.array(z.string()),
		explicitMaxTtlSecs: z.number().optional(),
		maxTtlSecs: z.number().optional(),
		name: z.string(),
		numUses: z.number().optional(),
		orphan: z.boolean(),
		periodSecs: z.number().optional(),
		renewable: z.boolean().optional(),
		ttlSecs: z.number().optional(),
		updatedAt: timestamp,
	})
	.passthrough();

const rolesReply = z.object({ roles: z.array(roleSchema) });
const roleReply = z.object({ role: roleSchema });
const deletedReply = z.object({ deleted: z.boolean() });
const path = (name: string) =>
	`/api/vault/token-roles/${encodeURIComponent(name)}`;

export async function listVaultTokenRoles(
	target: ApiTarget
): Promise<VaultTokenRole[]> {
	const raw = await request(
		target,
		"/api/vault/token-roles",
		undefined,
		rolesReply
	);
	return raw.roles as VaultTokenRole[];
}

export async function putVaultTokenRole(
	target: ApiTarget,
	name: string,
	input: VaultTokenRoleInput
): Promise<VaultTokenRole> {
	const raw = await request(
		target,
		path(name),
		{ method: "PUT", body: input },
		roleReply
	);
	return raw.role as VaultTokenRole;
}

export async function deleteVaultTokenRole(
	target: ApiTarget,
	name: string
): Promise<boolean> {
	const raw = await request(
		target,
		path(name),
		{ method: "DELETE" },
		deletedReply
	);
	return raw.deleted;
}
