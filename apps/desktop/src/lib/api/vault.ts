// Typed client for the user-managed Core Vault surface.
//
// Core returns only metadata. Values are write-only from the Desktop point of
// view and are never represented in these response types.

import { type ApiTarget, request } from "./client.ts";

export type VaultScope = "user" | "node" | "team" | "org";

export interface VaultSecretBinding {
	id: string;
	kind: "mcp";
}

export interface VaultSecret {
	binding?: VaultSecretBinding;
	name: string;
	scope: VaultScope;
	scopeId: string;
	updatedAt: string;
}

export interface VaultNodeContext {
	id: string;
	orgId: string | null;
	ownerUserId: string | null;
	scope: "local" | "org" | "team" | "personal";
	teamId: string | null;
}

export interface VaultCallerContext {
	orgId: string | null;
	role: "owner" | "admin" | "member" | "viewer";
	teamIds: string[];
	userId: string;
}

export interface VaultState {
	caller: VaultCallerContext | null;
	canManageShared: boolean;
	node: VaultNodeContext;
	secrets: VaultSecret[];
}

export interface SetVaultSecretInput {
	binding?: VaultSecretBinding;
	scope: VaultScope;
	scopeId?: string;
	value: string;
}

export async function listVaultSecrets(target: ApiTarget): Promise<VaultState> {
	return await request<VaultState>(target, "/api/vault/secrets");
}

export async function setVaultSecret(
	target: ApiTarget,
	name: string,
	input: SetVaultSecretInput
): Promise<void> {
	await request(target, `/api/vault/secrets/${encodeURIComponent(name)}`, {
		body: input,
		method: "PUT",
	});
}

export async function deleteVaultSecret(
	target: ApiTarget,
	name: string,
	input: Omit<SetVaultSecretInput, "value">
): Promise<void> {
	await request(target, `/api/vault/secrets/${encodeURIComponent(name)}`, {
		body: input,
		method: "DELETE",
	});
}
