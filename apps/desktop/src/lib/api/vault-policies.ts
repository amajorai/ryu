// Vault policies (`/api/vault/policies`): named rule sets granted to users,
// teams, roles and machines through bindings. Rules keep every field Core
// returns (parameter constraints, control groups, value rules, wrapping
// TTLs), so an edit never drops one the editor does not show.

import { z } from "zod";
import { type ApiTarget, request } from "./client.ts";

const ruleSchema = z.record(z.string(), z.unknown());

const policySchema = z
	.object({
		description: z.string(),
		name: z.string(),
		rules: z.array(ruleSchema),
	})
	.passthrough();

const bindingSchema = z
	.object({
		id: z.string(),
		policy: z.string(),
		subject: z.string(),
	})
	.passthrough();

const listReply = z.object({
	bindings: z.array(bindingSchema).catch(() => []),
	policies: z.array(policySchema),
});
const putReply = z.object({ policy: policySchema });
const deletedReply = z.object({ deleted: z.boolean() });

export type VaultPolicyDocument = z.infer<typeof policySchema>;
export type VaultPolicyBindingRow = z.infer<typeof bindingSchema>;

/** The body Core takes for a policy: its description and rules. */
export interface VaultPolicyInput {
	description: string;
	rules: Record<string, unknown>[];
}

const path = (name: string) =>
	`/api/vault/policies/${encodeURIComponent(name)}`;

export async function listVaultPolicyDocuments(target: ApiTarget): Promise<{
	bindings: VaultPolicyBindingRow[];
	policies: VaultPolicyDocument[];
}> {
	return await request(target, "/api/vault/policies", undefined, listReply);
}

/** Save a policy. `createOnly` makes Core refuse (409) a name that exists
 *  instead of replacing that policy. */
export async function putVaultPolicyDocument(
	target: ApiTarget,
	name: string,
	input: VaultPolicyInput,
	options: { createOnly?: boolean } = {}
): Promise<VaultPolicyDocument> {
	const body = options.createOnly ? { ...input, createOnly: true } : input;
	const raw = await request(
		target,
		path(name),
		{ method: "PUT", body },
		putReply
	);
	return raw.policy;
}

export async function deleteVaultPolicyDocument(
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
