// packages/core-client/src/vault/totp.ts
//
// TOTP and password policies: part of the Secret Vault client. `../vault.ts`
// re-exports these names and documents the wire conventions.

import { type ApiTarget, request } from "../client.ts";
import type { VaultAgentTarget } from "./agent-routes.ts";
import { vaultDeletedReply } from "./codecs-machine.ts";
import {
	vaultPasswordPoliciesReply,
	vaultPasswordPolicyReply,
	vaultPasswordReply,
	vaultTotpCodeReply,
	vaultTotpCreatedReply,
	vaultTotpKeyReply,
	vaultTotpKeysReply,
	vaultValidReply,
} from "./codecs-reply.ts";
import { agentRequest } from "./internal.ts";
import type { VaultTimestamp } from "./shared.ts";

export type VaultTotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export interface VaultTotpKey {
	account: string;
	algorithm: VaultTotpAlgorithm;
	createdAt: VaultTimestamp;
	digits: number;
	generated: boolean;
	issuer: string;
	name: string;
	period: number;
	skew: number;
}

/** Exactly one of `generate`, `url` (otpauth://totp/…), or `secret` (Base32). */
export interface VaultTotpCreateInput {
	account?: string;
	algorithm?: VaultTotpAlgorithm;
	digits?: number;
	exported?: boolean;
	generate?: boolean;
	issuer?: string;
	keySize?: number;
	name: string;
	period?: number;
	qrFormat?: "svg" | "png";
	qrScale?: number;
	secret?: string;
	skew?: number;
	url?: string;
}

/** A created key; a generated key returns its otpauth URL (and QR) once. */
export interface VaultTotpCreated {
	key: VaultTotpKey;
	qr?: string;
	qrFormat?: "svg" | "png";
	url?: string;
}

export interface VaultTotpCode {
	code: string;
	period: number;
	remainingSecs: number;
}

export interface VaultPasswordPolicyRule {
	charset: string;
	minChars?: number;
}

export interface VaultPasswordPolicy {
	createdAt: VaultTimestamp;
	description: string;
	length: number;
	name: string;
	rules: VaultPasswordPolicyRule[];
	updatedAt: VaultTimestamp;
}

function totpPath(kind: "keys" | "code" | "validate", name?: string): string {
	return `/api/vault/totp/${kind}${name === undefined ? "" : `/${encodeURIComponent(name)}`}`;
}

export function listVaultTotpKeys(
	target: ApiTarget
): Promise<{ keys: VaultTotpKey[] }> {
	return request(target, totpPath("keys"), {}, vaultTotpKeysReply);
}

export function createVaultTotpKey(
	target: ApiTarget,
	input: VaultTotpCreateInput
): Promise<VaultTotpCreated> {
	return request(
		target,
		totpPath("keys"),
		{ method: "POST", body: input },
		vaultTotpCreatedReply
	);
}

export function getVaultTotpKey(
	target: ApiTarget,
	name: string
): Promise<{ key: VaultTotpKey }> {
	return request(target, totpPath("keys", name), {}, vaultTotpKeyReply);
}

export function deleteVaultTotpKey(
	target: ApiTarget,
	name: string
): Promise<{ deleted: boolean }> {
	return request(
		target,
		totpPath("keys", name),
		{ method: "DELETE" },
		vaultDeletedReply
	);
}

/** The current code (`use` on `sys/totp/<name>`; audited). */
export function getVaultTotpCode(
	target: ApiTarget,
	name: string
): Promise<VaultTotpCode> {
	return request(target, totpPath("code", name), {}, vaultTotpCodeReply);
}

export function validateVaultTotpCode(
	target: ApiTarget,
	name: string,
	code: string
): Promise<{ valid: boolean }> {
	return request(
		target,
		totpPath("validate", name),
		{ method: "POST", body: { code } },
		vaultValidReply
	);
}

export function vaultAgentTotpCode(
	target: VaultAgentTarget,
	name: string
): Promise<VaultTotpCode> {
	return agentRequest(
		vaultTotpCodeReply,
		target,
		`/api/vault/agent/totp/code/${encodeURIComponent(name)}`
	);
}

export function vaultAgentTotpValidate(
	target: VaultAgentTarget,
	name: string,
	code: string
): Promise<{ valid: boolean }> {
	return agentRequest(
		vaultValidReply,
		target,
		`/api/vault/agent/totp/validate/${encodeURIComponent(name)}`,
		{ method: "POST", body: { code } }
	);
}

function passwordPolicyPath(name?: string, suffix = ""): string {
	return `/api/vault/sys/password-policies${name === undefined ? "" : `/${encodeURIComponent(name)}`}${suffix}`;
}

export function listVaultPasswordPolicies(
	target: ApiTarget
): Promise<{ policies: VaultPasswordPolicy[] }> {
	return request(target, passwordPolicyPath(), {}, vaultPasswordPoliciesReply);
}

export function getVaultPasswordPolicy(
	target: ApiTarget,
	name: string
): Promise<{ policy: VaultPasswordPolicy }> {
	return request(
		target,
		passwordPolicyPath(name),
		{},
		vaultPasswordPolicyReply
	);
}

/** `length` is 8–256; the rules' minimums must fit inside it. */
export function putVaultPasswordPolicy(
	target: ApiTarget,
	name: string,
	input: {
		description?: string;
		length: number;
		rules: VaultPasswordPolicyRule[];
	}
): Promise<{ policy: VaultPasswordPolicy }> {
	return request(
		target,
		passwordPolicyPath(name),
		{ method: "PUT", body: input },
		vaultPasswordPolicyReply
	);
}

export function deleteVaultPasswordPolicy(
	target: ApiTarget,
	name: string
): Promise<{ deleted: boolean }> {
	return request(
		target,
		passwordPolicyPath(name),
		{ method: "DELETE" },
		vaultDeletedReply
	);
}

export function generateVaultPassword(
	target: ApiTarget,
	policy: string
): Promise<{ password: string }> {
	return request(
		target,
		passwordPolicyPath(policy, "/generate"),
		{},
		vaultPasswordReply
	);
}

export function vaultAgentGeneratePassword(
	target: VaultAgentTarget,
	policy: string
): Promise<{ password: string }> {
	return agentRequest(
		vaultPasswordReply,
		target,
		`/api/vault/agent/password-policies/${encodeURIComponent(policy)}/generate`
	);
}
