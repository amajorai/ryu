// packages/core-client/src/vault/policies.ts
//
// Policies and bindings: part of the Secret Vault client. `../vault.ts` re-
// exports these names and documents the wire conventions.

import { type ApiTarget, request } from "../client.ts";
import {
	vaultHumanBoundPolicy,
	vaultHumanDeleted,
	vaultHumanPolicies,
	vaultHumanPutPolicy,
	vaultHumanRemoved,
} from "./codecs-human.ts";
import type { VaultCapability, VaultTimestamp } from "./shared.ts";

export interface VaultPolicyRule {
	capabilities: VaultCapability[];
	deny?: boolean;
	/** Glob over `ENV/folder/NAME` or a `sys/…` key. */
	path: string;
}

export interface VaultPolicy {
	description: string;
	name: string;
	rules: VaultPolicyRule[];
}

export interface VaultPolicyBinding {
	expiresAt?: VaultTimestamp;
	id: string;
	policy: string;
	/** `user:<id>`, `team:<id>`, `role:<name>`, or `machine:<id>`. */
	subject: string;
}

export function listVaultPolicies(
	target: ApiTarget
): Promise<{ bindings: VaultPolicyBinding[]; policies: VaultPolicy[] }> {
	return request(target, "/api/vault/policies", {}, vaultHumanPolicies);
}

export function putVaultPolicy(
	target: ApiTarget,
	name: string,
	input: { description?: string; rules: VaultPolicyRule[] }
): Promise<{ ok: boolean; policy: VaultPolicy }> {
	return request(
		target,
		`/api/vault/policies/${encodeURIComponent(name)}`,
		{
			method: "PUT",
			body: input,
		},
		vaultHumanPutPolicy
	);
}

export function deleteVaultPolicy(
	target: ApiTarget,
	name: string
): Promise<{ deleted: boolean; ok: boolean }> {
	return request(
		target,
		`/api/vault/policies/${encodeURIComponent(name)}`,
		{
			method: "DELETE",
		},
		vaultHumanDeleted
	);
}

export function bindVaultPolicy(
	target: ApiTarget,
	input: { expiresAt?: string; policy: string; subject: string }
): Promise<{ binding: VaultPolicyBinding; ok: boolean }> {
	return request(
		target,
		"/api/vault/policy-bindings",
		{
			method: "POST",
			body: input,
		},
		vaultHumanBoundPolicy
	);
}

export function unbindVaultPolicy(
	target: ApiTarget,
	id: string
): Promise<{ ok: boolean; removed: boolean }> {
	return request(
		target,
		`/api/vault/policy-bindings/${encodeURIComponent(id)}`,
		{
			method: "DELETE",
		},
		vaultHumanRemoved
	);
}
