import { describe, expect, test } from "bun:test";
import { parseSecretsArgs } from "../cli/secrets-args.ts";
import { identityConfigFrom } from "../cli/secrets-identity.ts";
import { fakeNode, json, runSecrets } from "./secrets-fixture.ts";

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

const part = (value: unknown) =>
	base64Url(new TextEncoder().encode(JSON.stringify(value)));

// An Ed25519 issuer standing in for Core's EdDSA signing key.
const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
	"sign",
	"verify",
])) as CryptoKeyPair;
const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
const JWKS = {
	keys: [
		{ kty: "OKP", crv: "Ed25519", x: publicJwk.x, kid: "k1", alg: "EdDSA" },
	],
};

async function signed(claims: Record<string, unknown>): Promise<string> {
	const input = `${part({ alg: "EdDSA", kid: "k1", typ: "JWT" })}.${part(claims)}`;
	const signature = await crypto.subtle.sign(
		{ name: "Ed25519" },
		pair.privateKey,
		new TextEncoder().encode(input)
	);
	return `${input}.${base64Url(new Uint8Array(signature))}`;
}

const nowSecs = Math.floor(Date.now() / 1000);
const CLAIMS = {
	iss: "https://vault.example",
	sub: "user:u1",
	aud: "sts.amazonaws.com",
	iat: nowSecs,
	nbf: nowSecs,
	exp: nowSecs + 900,
};
const TOKEN = await signed(CLAIMS);
const CONFIG = {
	issuer: "https://vault.example",
	rotationPeriodSecs: 86_400,
	signingAlgorithm: "ES256",
};
const MINTED = {
	token: TOKEN,
	role: "deploy",
	ttlSecs: 900,
	expiresAt: "2030-01-01T00:15:00Z",
};

function identityNode() {
	return fakeNode({
		"GET /api/vault/identity/config": json({ config: CONFIG }),
		"PUT /api/vault/identity/config": (call) =>
			Response.json({ config: JSON.parse(call.body) }),
		"POST /api/vault/identity/token/deploy": json({ token: MINTED }),
		"POST /api/vault/agent/identity/token/deploy": json({ token: MINTED }),
		"GET /api/vault/identity/.well-known/keys": json(JWKS),
	});
}

describe("ryu secrets identity", () => {
	test("config --algorithm keeps the issuer and rotation period", async () => {
		const node = identityNode();
		const { code, out } = await runSecrets(
			["identity", "config", "--algorithm", "eddsa"],
			node
		);
		expect(code).toBe(0);
		const put = node.calls.find((call) => call.route.startsWith("PUT"));
		expect(JSON.parse(put?.body ?? "{}")).toEqual({
			...CONFIG,
			signingAlgorithm: "EdDSA",
		});
		expect(out).toContain("signing EdDSA");
		const bad = await runSecrets(
			["identity", "config", "--algorithm", "HS256"],
			identityNode()
		);
		expect(bad.code).not.toBe(0);
		expect(bad.err).toContain("ES256, RS256, EdDSA");
	});

	test("token prints the JWT, as the user or with RYU_VAULT_TOKEN as the machine", async () => {
		const node = identityNode();
		const human = await runSecrets(["identity", "token", "deploy"], node);
		expect(human.out).toBe(`${TOKEN}\n`);
		const machine = await runSecrets(["identity", "token", "deploy"], node, {
			env: { HOME: "/home/me", RYU_VAULT_TOKEN: "rvt_x" },
		});
		expect(machine.code).toBe(0);
		const agentCall = node.calls.at(-1);
		expect(agentCall?.route).toBe(
			"POST /api/vault/agent/identity/token/deploy"
		);
		expect(agentCall?.headers.get("x-ryu-vault-token")).toBe("rvt_x");
	});

	test("an AI agent session does not print a minted token", async () => {
		const node = identityNode();
		const { code, out } = await runSecrets(
			["identity", "token", "deploy"],
			node,
			{ env: { HOME: "/home/me", CLAUDECODE: "1" } }
		);
		expect(code).not.toBe(0);
		expect(out).not.toContain(TOKEN);
		expect(node.calls).toEqual([]);
	});

	test("verify checks the signature, algorithm and audience against the JWKS", async () => {
		const valid = await runSecrets(
			[
				"identity",
				"verify",
				TOKEN,
				"--algorithm",
				"EdDSA",
				"--audience",
				"sts.amazonaws.com",
			],
			identityNode()
		);
		expect(valid.code).toBe(0);
		expect(valid.out).toContain("Valid EdDSA token (key k1).");
		expect(valid.out).toContain('"sub": "user:u1"');

		const piped = await runSecrets(["identity", "verify"], identityNode(), {
			readStdin: () => Promise.resolve(`${TOKEN}\n`),
		});
		expect(piped.code).toBe(0);

		const wrongAlg = await runSecrets(
			["identity", "verify", TOKEN, "--algorithm", "RS256"],
			identityNode()
		);
		expect(wrongAlg.code).toBe(1);
		expect(wrongAlg.err).toContain("signed with EdDSA, expected RS256");

		const forged = await signed({ ...CLAIMS, sub: "user:admin" });
		const [, body] = forged.split(".");
		const [head, , signature] = TOKEN.split(".");
		const tampered = await runSecrets(
			["identity", "verify", `${head}.${body}.${signature}`],
			identityNode()
		);
		expect(tampered.code).toBe(1);
		expect(tampered.err).toContain("the signature does not match");

		const expired = await signed({ ...CLAIMS, exp: nowSecs - 60 });
		const late = await runSecrets(
			["identity", "verify", expired],
			identityNode()
		);
		expect(late.code).toBe(1);
		expect(late.err).toContain("the token has expired");
	});

	test("identityConfigFrom sends the issuer and rotation it read", () => {
		const current = {
			issuer: "https://vault.example",
			rotationPeriodSecs: 86_400,
		};
		expect(
			identityConfigFrom(parseSecretsArgs(["identity"]), current)
		).toBeNull();
		expect(
			identityConfigFrom(
				parseSecretsArgs(["identity", "--rotation-period", "2d"]),
				current
			)
		).toEqual({ ...current, rotationPeriodSecs: 172_800 });
	});
});
