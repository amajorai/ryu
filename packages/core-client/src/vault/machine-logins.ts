// packages/core-client/src/vault/machine-logins.ts
//
// Keyless machine logins (TLS certificate, AWS IAM, Kubernetes): part of the
// Secret Vault client. `../vault.ts` re-exports these names and documents the
// wire conventions. Like AppRole and JWT login these are public routes that
// authenticate in-handler, so they take a {@link VaultMachineTarget} and never
// send the node bearer. Bodies follow `server/vault_seal_dynamic_api.rs`
// (`CertLogin`, `AwsLogin`, `KubernetesLogin`) and
// `vault/auth_methods.rs` (`AwsIamLogin`).

import type { VaultIssuedToken, VaultMachineTarget } from "./agent-routes.ts";
import { vaultMachineLoginResponse } from "./codecs-machine.ts";
import { machineRequest } from "./internal.ts";

/** `aud` a certificate proof-of-possession JWT must carry. */
export const VAULT_CERT_LOGIN_AUDIENCE = "ryu-vault-cert-login";

/** Header the signed STS request must carry and sign (replay protection). */
export const VAULT_AWS_SERVER_ID_HEADER = "x-ryu-server-id";

export interface VaultCertLoginInput {
	/** The client certificate (PEM). */
	certificatePem: string;
	identity: string;
	/**
	 * A JWT signed with the certificate's private key: `aud`
	 * {@link VAULT_CERT_LOGIN_AUDIENCE}, `sub` the identity name, a unique
	 * `jti`, and at most five minutes between `iat` and `exp`.
	 */
	proof: string;
}

/** A presigned `sts:GetCallerIdentity` request; every field but the method is base64. */
export interface VaultAwsLoginInput {
	iamHttpRequestMethod?: "POST";
	iamRequestBody: string;
	/** Base64 JSON object of the signed headers (string values). */
	iamRequestHeaders: string;
	iamRequestUrl: string;
	identity: string;
}

export interface VaultKubernetesLoginInput {
	identity: string;
	/** The pod's service-account token. */
	jwt: string;
}

function login<T>(
	target: VaultMachineTarget,
	method: string,
	body: T
): Promise<{ token: VaultIssuedToken }> {
	return machineRequest(
		vaultMachineLoginResponse,
		target,
		`/api/vault/auth/${method}/login`,
		{ method: "POST", body }
	);
}

/** Log in with a TLS client certificate and a proof-of-possession JWT. */
export function vaultCertLogin(
	target: VaultMachineTarget,
	input: VaultCertLoginInput
): Promise<{ token: VaultIssuedToken }> {
	return login(target, "cert", input);
}

/** Log in with a presigned `sts:GetCallerIdentity` request. */
export function vaultAwsLogin(
	target: VaultMachineTarget,
	input: VaultAwsLoginInput
): Promise<{ token: VaultIssuedToken }> {
	return login(target, "aws", input);
}

/** Log in with a Kubernetes service-account token (Core runs a TokenReview). */
export function vaultKubernetesLogin(
	target: VaultMachineTarget,
	input: VaultKubernetesLoginInput
): Promise<{ token: VaultIssuedToken }> {
	return login(target, "kubernetes", input);
}
