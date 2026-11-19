import { expect, test } from "bun:test";
import { verifyVaultIdentityToken } from "./identity-token-verify.ts";
import {
	getVaultIdentityConfig,
	setVaultIdentityConfig,
	type VaultIdentitySigningAlgorithm,
} from "./identity-tokens.ts";

const NOW = 1_900_000_000_000;
const NOW_SECS = NOW / 1000;

const SIGNING: Record<
	VaultIdentitySigningAlgorithm,
	{
		generate: RsaHashedKeyGenParams | EcKeyGenParams | Algorithm;
		sign: Algorithm | EcdsaParams;
	}
> = {
	ES256: {
		generate: { name: "ECDSA", namedCurve: "P-256" },
		sign: { name: "ECDSA", hash: "SHA-256" } as EcdsaParams,
	},
	RS256: {
		generate: {
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		sign: { name: "RSASSA-PKCS1-v1_5" },
	},
	EdDSA: { generate: { name: "Ed25519" }, sign: { name: "Ed25519" } },
};

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function encodeJson(value: unknown): string {
	return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function issuer(algorithm: VaultIdentitySigningAlgorithm, kid: string) {
	const params = SIGNING[algorithm];
	const pair = (await crypto.subtle.generateKey(params.generate, true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;
	const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
	const published = {
		kty: jwk.kty,
		crv: jwk.crv,
		x: jwk.x,
		y: jwk.y,
		n: jwk.n,
		e: jwk.e,
		kid,
		alg: algorithm,
		use: "sig",
	};
	const sign = async (claims: Record<string, unknown>, alg = algorithm) => {
		const signed = `${encodeJson({ alg, kid, typ: "JWT" })}.${encodeJson(claims)}`;
		const signature = await crypto.subtle.sign(
			params.sign,
			pair.privateKey,
			new TextEncoder().encode(signed)
		);
		return `${signed}.${base64Url(new Uint8Array(signature))}`;
	};
	return { published, sign };
}

const claims = {
	iss: "https://vault.example",
	sub: "machine:mid_1",
	aud: "sts.amazonaws.com",
	iat: NOW_SECS,
	nbf: NOW_SECS,
	exp: NOW_SECS + 900,
};

test("tokens signed with each Core algorithm verify against the JWKS", async () => {
	for (const algorithm of ["ES256", "RS256", "EdDSA"] as const) {
		const { published, sign } = await issuer(algorithm, `k-${algorithm}`);
		const token = await sign(claims);
		const result = await verifyVaultIdentityToken(
			token,
			{ keys: [published] },
			{
				algorithm,
				audience: "sts.amazonaws.com",
				issuer: "https://vault.example",
				now: NOW,
			}
		);
		expect(result).toEqual({
			valid: true,
			algorithm,
			claims,
			kid: `k-${algorithm}`,
		});
	}
});

test("tampered, expired, early, mismatched and unsigned tokens are refused", async () => {
	const es = await issuer("ES256", "k1");
	const ed = await issuer("EdDSA", "k2");
	const jwks = { keys: [es.published, ed.published] };
	const token = await es.sign(claims);
	const [head, , signature] = token.split(".");
	const tampered = `${head}.${encodeJson({ ...claims, sub: "machine:other" })}.${signature}`;
	const reasons = async (
		value: string,
		check: Parameters<typeof verifyVaultIdentityToken>[2] = {}
	) => {
		const result = await verifyVaultIdentityToken(value, jwks, {
			now: NOW,
			...check,
		});
		return result.valid ? "valid" : result.reason;
	};
	expect(await reasons(tampered)).toBe("the signature does not match");
	expect(await reasons(token, { now: NOW + 901_000 })).toBe(
		"the token has expired"
	);
	expect(await reasons(token, { now: NOW - 10_000 })).toBe(
		"the token is not valid yet"
	);
	expect(await reasons(token, { algorithm: "RS256" })).toBe(
		"signed with ES256, expected RS256"
	);
	expect(await reasons(token, { audience: "other" })).toBe(
		"the audience is not other"
	);
	// An ES256 key under the EdDSA token's kid: the JWK's alg must match.
	const swapped = await ed.sign(claims, "ES256");
	expect(await reasons(swapped)).toBe("key k2 is EdDSA, not ES256");
	const none = `${encodeJson({ alg: "none", kid: "k1" })}.${encodeJson(claims)}.`;
	expect(await reasons(none)).toBe("unsupported algorithm none");
	const hmac = `${encodeJson({ alg: "HS256", kid: "k1" })}.${encodeJson(claims)}.AAAA`;
	expect(await reasons(hmac)).toBe("unsupported algorithm HS256");
	expect(await reasons("not-a-jwt")).toBe("not a signed JWT");
	const unknownKid = await (await issuer("ES256", "gone")).sign(claims);
	expect(await reasons(unknownKid)).toBe("no published key gone");
});

test("the issuer config carries the signing algorithm both ways", async () => {
	const sent: unknown[] = [];
	const config = {
		issuer: "https://vault.example",
		rotationPeriodSecs: 86_400,
		signingAlgorithm: "RS256",
	};
	const target = {
		url: "http://127.0.0.1:7777",
		token: "node-token",
		fetch: (_input: RequestInfo | URL, init?: RequestInit) => {
			if (init?.body) {
				sent.push(JSON.parse(String(init.body)));
			}
			return Promise.resolve(Response.json({ config }));
		},
	};
	expect((await getVaultIdentityConfig(target)).config.signingAlgorithm).toBe(
		"RS256"
	);
	await setVaultIdentityConfig(target, {
		issuer: "https://vault.example",
		rotationPeriodSecs: 86_400,
		signingAlgorithm: "EdDSA",
	});
	expect(sent).toEqual([
		{
			issuer: "https://vault.example",
			rotationPeriodSecs: 86_400,
			signingAlgorithm: "EdDSA",
		},
	]);
	const bad = {
		...target,
		fetch: () =>
			Promise.resolve(
				Response.json({ config: { ...config, signingAlgorithm: "HS256" } })
			),
	};
	await expect(getVaultIdentityConfig(bad)).rejects.toThrow();
});
