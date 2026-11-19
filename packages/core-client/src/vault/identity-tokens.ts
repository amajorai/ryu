// packages/core-client/src/vault/identity-tokens.ts
//
// Identity tokens (`/api/vault/identity/*`): part of the Secret Vault client.
// `../vault.ts` re-exports these names and documents the wire conventions.
// Core signs short-lived JWTs (ES256 by default, or RS256 or EdDSA through
// `signingAlgorithm`) for a role's audience (for example an AWS IAM OIDC
// provider), so a workload can federate into a cloud without a stored cloud
// key. `identity-token-verify.ts` checks a token against the public JWKS. Shapes follow `apps/core/src/vault/identity_tokens.rs`
// (`IdentityConfig`, `IdentityRole`, `IdentityToken`) as rendered by
// `server/vault_crypto_api.rs`.
//
// Configuration and roles need `admin` on `sys/identity/…`; minting needs
// `use` on the role. The OIDC discovery document and JWKS are public.

import { z } from "zod";
import { type ApiTarget, request } from "../client.ts";
import type { VaultAgentTarget, VaultMachineTarget } from "./agent-routes.ts";
import {
	vaultDate,
	vaultNumber,
	vaultReply,
	vaultText,
} from "./codecs-machine.ts";
import { agentRequest, machineRequest } from "./internal.ts";
import type { VaultTimestamp } from "./shared.ts";

/** Algorithms Core signs identity tokens with. */
export const VAULT_IDENTITY_SIGNING_ALGORITHMS = [
	"ES256",
	"RS256",
	"EdDSA",
] as const;

export type VaultIdentitySigningAlgorithm =
	(typeof VAULT_IDENTITY_SIGNING_ALGORITHMS)[number];

export interface VaultIdentityConfig {
	/** The `iss` claim; null until configured (or `RYU_VAULT_IDENTITY_ISSUER`). */
	issuer: string | null;
	rotationPeriodSecs: number;
	/** Algorithm of new signing keys. Changing it rotates the key. */
	signingAlgorithm?: VaultIdentitySigningAlgorithm;
}

export interface VaultIdentityRole {
	/** The `aud` claim. */
	audience: string;
	name: string;
	/** Extra claims as a JSON object template (`{{identity.id}}`, …). */
	template?: string | null;
	ttlSecs: number;
}

export type VaultIdentityRoleInput = Omit<
	VaultIdentityRole,
	"name" | "ttlSecs"
> & {
	ttlSecs?: number;
};

/** A signed identity JWT. `token` is a bearer credential for the audience. */
export interface VaultIdentityToken {
	/** RFC 3339 after rendering, or a raw epoch-millisecond fallback. */
	expiresAt: VaultTimestamp;
	role: string;
	token: string;
	ttlSecs: number;
}

const configFields = z.object({
	issuer: vaultText.nullable(),
	rotationPeriodSecs: vaultNumber,
	signingAlgorithm: z.enum(VAULT_IDENTITY_SIGNING_ALGORITHMS).optional(),
});
const roleFields = z.object({
	name: vaultText,
	audience: vaultText,
	ttlSecs: vaultNumber,
	template: vaultText.nullable().optional(),
});
const tokenFields = z.object({
	token: vaultText,
	role: vaultText,
	ttlSecs: vaultNumber,
	expiresAt: vaultDate,
});

const configReply = vaultReply<{ config: VaultIdentityConfig }>(
	z.object({ config: configFields })
);
const rolesReply = vaultReply<{ roles: VaultIdentityRole[] }>(
	z.object({ roles: z.array(roleFields) })
);
const roleReply = vaultReply<{ role: VaultIdentityRole }>(
	z.object({ role: roleFields })
);
const deletedReply = vaultReply<{ deleted: boolean }>(
	z.object({ deleted: z.boolean() })
);
const kidReply = vaultReply<{ kid: string }>(z.object({ kid: vaultText }));
const tokenReply = vaultReply<{ token: VaultIdentityToken }>(
	z.object({ token: tokenFields })
);
const documentReply = z.record(z.string(), z.unknown());

const IDENTITY = "/api/vault/identity";

function rolePath(name: string): string {
	return `${IDENTITY}/roles/${encodeURIComponent(name)}`;
}

export function getVaultIdentityConfig(
	target: ApiTarget
): Promise<{ config: VaultIdentityConfig }> {
	return request(target, `${IDENTITY}/config`, {}, configReply);
}

/**
 * Core replaces the whole config: an omitted `issuer` clears it and an
 * omitted `rotationPeriodSecs` resets it. Send every field to keep it; an
 * omitted `signingAlgorithm` keeps the stored one.
 */
export function setVaultIdentityConfig(
	target: ApiTarget,
	config: {
		issuer?: string | null;
		rotationPeriodSecs?: number;
		signingAlgorithm?: VaultIdentitySigningAlgorithm;
	}
): Promise<{ config: VaultIdentityConfig }> {
	return request(
		target,
		`${IDENTITY}/config`,
		{ method: "PUT", body: config },
		configReply
	);
}

/** Retire the active signing key and create a new one; returns its `kid`. */
export function rotateVaultIdentityKey(
	target: ApiTarget
): Promise<{ kid: string }> {
	return request(
		target,
		`${IDENTITY}/keys/rotate`,
		{ method: "POST" },
		kidReply
	);
}

/** Roles the caller holds any capability on. */
export function listVaultIdentityRoles(
	target: ApiTarget
): Promise<{ roles: VaultIdentityRole[] }> {
	return request(target, `${IDENTITY}/roles`, {}, rolesReply);
}

export function putVaultIdentityRole(
	target: ApiTarget,
	name: string,
	input: VaultIdentityRoleInput
): Promise<{ role: VaultIdentityRole }> {
	return request(
		target,
		rolePath(name),
		{ method: "PUT", body: input },
		roleReply
	);
}

export function deleteVaultIdentityRole(
	target: ApiTarget,
	name: string
): Promise<{ deleted: boolean }> {
	return request(target, rolePath(name), { method: "DELETE" }, deletedReply);
}

/** Mint an identity token for `role` as the signed-in user. */
export function mintVaultIdentityToken(
	target: ApiTarget,
	role: string
): Promise<{ token: VaultIdentityToken }> {
	return request(
		target,
		`${IDENTITY}/token/${encodeURIComponent(role)}`,
		{ method: "POST" },
		tokenReply
	);
}

/** Mint an identity token for `role` with a machine token (no node bearer). */
export function vaultAgentIdentityToken(
	target: VaultAgentTarget,
	role: string
): Promise<{ token: VaultIdentityToken }> {
	return agentRequest(
		tokenReply,
		target,
		`/api/vault/agent/identity/token/${encodeURIComponent(role)}`,
		{ method: "POST" }
	);
}

/** The public OIDC discovery document relying parties read. */
export function getVaultIdentityDiscovery(
	target: VaultMachineTarget
): Promise<Record<string, unknown>> {
	return machineRequest(
		documentReply,
		target,
		`${IDENTITY}/.well-known/openid-configuration`
	);
}

/** The public JWKS that verifies identity tokens. */
export function getVaultIdentityJwks(
	target: VaultMachineTarget
): Promise<Record<string, unknown>> {
	return machineRequest(documentReply, target, `${IDENTITY}/.well-known/keys`);
}
