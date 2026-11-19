// packages/core-client/src/vault/identity-token-verify.ts
//
// Verify a vault identity token against the issuer's public JWKS
// (`getVaultIdentityJwks`), the check a relying party makes. Core has no
// verify route: the JWKS is the contract. Uses WebCrypto only, so it runs in
// Bun, Node and the browser. Only the algorithms Core signs with are
// accepted (`ES256`, `RS256`, `EdDSA`); `none` and HMAC never verify.

import {
	VAULT_IDENTITY_SIGNING_ALGORITHMS,
	type VaultIdentitySigningAlgorithm,
} from "./identity-tokens.ts";

export interface VaultIdentityTokenCheck {
	/** Require this algorithm (otherwise any algorithm Core signs with). */
	algorithm?: VaultIdentitySigningAlgorithm;
	/** Require this `aud`. */
	audience?: string;
	/** Require this `iss`. */
	issuer?: string;
	/** Clock skew allowed on `exp` and `nbf`, in seconds (default 0). */
	leewaySecs?: number;
	/** The current time in epoch milliseconds (default `Date.now()`). */
	now?: number;
}

export type VaultIdentityTokenVerification =
	| {
			algorithm: VaultIdentitySigningAlgorithm;
			claims: Record<string, unknown>;
			kid: string;
			valid: true;
	  }
	| { claims: Record<string, unknown> | null; reason: string; valid: false };

type Jwk = Record<string, unknown>;

const KEY_PARAMS: Record<
	VaultIdentitySigningAlgorithm,
	{
		fields: string[];
		import: EcKeyImportParams | RsaHashedImportParams | Algorithm;
		verify: EcdsaParams | Algorithm;
	}
> = {
	ES256: {
		fields: ["kty", "crv", "x", "y"],
		import: { name: "ECDSA", namedCurve: "P-256" },
		verify: { name: "ECDSA", hash: "SHA-256" } as EcdsaParams,
	},
	RS256: {
		fields: ["kty", "n", "e"],
		import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		verify: { name: "RSASSA-PKCS1-v1_5" },
	},
	EdDSA: {
		fields: ["kty", "crv", "x"],
		import: { name: "Ed25519" },
		verify: { name: "Ed25519" },
	},
};

function base64UrlBytes(text: string): Uint8Array<ArrayBuffer> | null {
	if (!/^[A-Za-z0-9_-]*$/.test(text)) {
		return null;
	}
	const padded = text.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
	const bytes = new Uint8Array(new ArrayBuffer(binary.length));
	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

function jsonPart(text: string): Record<string, unknown> | null {
	const bytes = base64UrlBytes(text);
	if (!bytes) {
		return null;
	}
	try {
		const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function isAlgorithm(value: unknown): value is VaultIdentitySigningAlgorithm {
	return (VAULT_IDENTITY_SIGNING_ALGORITHMS as readonly unknown[]).includes(
		value
	);
}

function jwkList(jwks: Record<string, unknown>): Jwk[] {
	const keys = jwks.keys;
	return Array.isArray(keys)
		? keys.filter((key): key is Jwk => Boolean(key) && typeof key === "object")
		: [];
}

async function signatureValid(
	algorithm: VaultIdentitySigningAlgorithm,
	jwk: Jwk,
	signed: string,
	signature: Uint8Array<ArrayBuffer>
): Promise<boolean> {
	const params = KEY_PARAMS[algorithm];
	const publicJwk: JsonWebKey = {};
	for (const field of params.fields) {
		if (typeof jwk[field] === "string") {
			(publicJwk as Record<string, string>)[field] = jwk[field] as string;
		}
	}
	try {
		const key = await crypto.subtle.importKey(
			"jwk",
			publicJwk,
			params.import,
			false,
			["verify"]
		);
		return await crypto.subtle.verify(
			params.verify,
			key,
			signature,
			new TextEncoder().encode(signed)
		);
	} catch {
		return false;
	}
}

function claimProblem(
	claims: Record<string, unknown>,
	check: VaultIdentityTokenCheck
): string | null {
	const now = Math.floor((check.now ?? Date.now()) / 1000);
	const leeway = check.leewaySecs ?? 0;
	if (typeof claims.exp !== "number" || claims.exp + leeway <= now) {
		return "the token has expired";
	}
	if (typeof claims.nbf === "number" && claims.nbf - leeway > now) {
		return "the token is not valid yet";
	}
	if (check.audience !== undefined) {
		const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
		if (!audiences.includes(check.audience)) {
			return `the audience is not ${check.audience}`;
		}
	}
	if (check.issuer !== undefined && claims.iss !== check.issuer) {
		return `the issuer is not ${check.issuer}`;
	}
	return null;
}

/** Verify `token` against `jwks` (the issuer's `.well-known/keys`). */
export async function verifyVaultIdentityToken(
	token: string,
	jwks: Record<string, unknown>,
	check: VaultIdentityTokenCheck = {}
): Promise<VaultIdentityTokenVerification> {
	const parts = token.trim().split(".");
	const header = parts.length === 3 ? jsonPart(parts[0] ?? "") : null;
	const claims = parts.length === 3 ? jsonPart(parts[1] ?? "") : null;
	const signature = parts.length === 3 ? base64UrlBytes(parts[2] ?? "") : null;
	if (!(header && claims && signature)) {
		return { valid: false, claims: null, reason: "not a signed JWT" };
	}
	const algorithm = header.alg;
	if (!isAlgorithm(algorithm)) {
		return {
			valid: false,
			claims,
			reason: `unsupported algorithm ${String(algorithm)}`,
		};
	}
	if (check.algorithm && algorithm !== check.algorithm) {
		return {
			valid: false,
			claims,
			reason: `signed with ${algorithm}, expected ${check.algorithm}`,
		};
	}
	const kid = typeof header.kid === "string" ? header.kid : "";
	const jwk = jwkList(jwks).find((key) => key.kid === kid);
	if (!jwk) {
		return { valid: false, claims, reason: `no published key ${kid}` };
	}
	if (jwk.alg !== undefined && jwk.alg !== algorithm) {
		return {
			valid: false,
			claims,
			reason: `key ${kid} is ${String(jwk.alg)}, not ${algorithm}`,
		};
	}
	const signed = `${parts[0]}.${parts[1]}`;
	if (!(await signatureValid(algorithm, jwk, signed, signature))) {
		return { valid: false, claims, reason: "the signature does not match" };
	}
	const problem = claimProblem(claims, check);
	if (problem) {
		return { valid: false, claims, reason: problem };
	}
	return { valid: true, algorithm, claims, kid };
}
