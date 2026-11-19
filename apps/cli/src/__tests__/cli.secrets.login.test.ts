// `ryu-cli secrets login --cert|--aws|--k8s`: the client-side proofs (SigV4
// against AWS's published test vectors, certificate proof-of-possession JWTs)
// and the login requests. Core is faked through the target's `fetch`.

import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { K8S_TOKEN_PATH } from "../cli/secrets-login.ts";
import {
	awsLoginRequest,
	certLoginProof,
	signSigV4,
	stsRegion,
} from "../cli/secrets-login-proofs.ts";
import { fakeNode, json, runSecrets } from "./secrets-fixture.ts";

let dir: string | null = null;
afterEach(async () => {
	if (dir) {
		await rm(dir, { recursive: true, force: true });
		dir = null;
	}
});

const issued = {
	token: {
		token: "rvt_issued",
		accessor: "acc_1",
		identityId: "mi_1",
		policies: ["ci"],
		expiresAt: "2030-01-01T00:15:00Z",
	},
};

// AWS SigV4 test suite: get-vanilla and post-vanilla.
const EXAMPLE_KEYS = {
	accessKeyId: "AKIDEXAMPLE",
	secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};
const VECTOR_TIME = new Date("2015-08-30T12:36:00Z");

test("SigV4 matches the AWS get-vanilla and post-vanilla vectors", () => {
	const scope = { region: "us-east-1", service: "service" };
	const request = {
		url: "https://example.amazonaws.com/",
		headers: {},
		body: "",
	};
	const get = signSigV4(
		{ ...request, method: "GET" },
		EXAMPLE_KEYS,
		scope,
		VECTOR_TIME
	);
	expect(get.authorization).toBe(
		"AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
	);
	expect(get["x-amz-date"]).toBe("20150830T123600Z");
	const post = signSigV4(
		{ ...request, method: "POST" },
		EXAMPLE_KEYS,
		scope,
		VECTOR_TIME
	);
	expect(post.authorization).toEndWith(
		"Signature=5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b"
	);
});

test("the STS login request is the exact signed GetCallerIdentity Core accepts", () => {
	const login = awsLoginRequest({
		identity: "ci",
		serverId: "vault.example",
		credentials: { ...EXAMPLE_KEYS, sessionToken: "session-tok" },
		now: VECTOR_TIME,
	});
	const decode = (text: string) => Buffer.from(text, "base64").toString("utf8");
	expect(login.identity).toBe("ci");
	expect(decode(login.iamRequestUrl)).toBe("https://sts.amazonaws.com/");
	expect(decode(login.iamRequestBody)).toBe(
		"Action=GetCallerIdentity&Version=2011-06-15"
	);
	const headers = JSON.parse(decode(login.iamRequestHeaders));
	expect(headers["x-ryu-server-id"]).toBe("vault.example");
	expect(headers["x-amz-security-token"]).toBe("session-tok");
	expect(headers.authorization).toContain(
		"/20150830/us-east-1/sts/aws4_request"
	);
	expect(headers.authorization).toContain(
		"SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-ryu-server-id,"
	);
	expect(JSON.stringify(login)).not.toContain(EXAMPLE_KEYS.secretAccessKey);
	expect(stsRegion("https://sts.eu-west-1.amazonaws.com/")).toBe("eu-west-1");
	expect(stsRegion("https://sts.amazonaws.com/")).toBe("us-east-1");
});

function decodePart(part: string | undefined) {
	return JSON.parse(Buffer.from(part ?? "", "base64url").toString("utf8"));
}

test("certificate proofs verify with the key's public half for EC, Ed25519 and RSA", () => {
	const now = new Date("2030-01-01T00:00:00Z");
	const cases = [
		["ES256", generateKeyPairSync("ec", { namedCurve: "P-256" }), "sha256"],
		["ES384", generateKeyPairSync("ec", { namedCurve: "P-384" }), "sha384"],
		["EdDSA", generateKeyPairSync("ed25519"), null],
		["RS256", generateKeyPairSync("rsa", { modulusLength: 2048 }), "sha256"],
	] as const;
	for (const [alg, pair, hash] of cases) {
		const pem = pair.privateKey
			.export({ type: "pkcs8", format: "pem" })
			.toString();
		const proof = certLoginProof(pem, "mesh-node", now);
		const [header, claims, signature] = proof.split(".");
		expect(decodePart(header)).toEqual({ alg, typ: "JWT" });
		const body = decodePart(claims);
		expect(body).toMatchObject({
			aud: "ryu-vault-cert-login",
			sub: "mesh-node",
			iat: 1_893_456_000,
			exp: 1_893_456_060,
		});
		expect(typeof body.jti).toBe("string");
		const valid = verify(
			hash,
			Buffer.from(`${header}.${claims}`),
			alg.startsWith("ES")
				? { key: pair.publicKey, dsaEncoding: "ieee-p1363" }
				: pair.publicKey,
			Buffer.from(signature ?? "", "base64url")
		);
		expect({ alg, valid }).toEqual({ alg, valid: true });
	}
	expect(() => certLoginProof("not a key", "x")).toThrow("--key-file");
});

test("login --cert reads the files, sends a proof, never the private key", async () => {
	dir = await mkdtemp(join(tmpdir(), "ryu-cert-login-"));
	const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
	await writeFile(join(dir, "cert.pem"), "-----BEGIN CERTIFICATE-----\nMII\n");
	await writeFile(join(dir, "key.pem"), keyPem);
	const node = fakeNode({ "POST /api/vault/auth/cert/login": json(issued) });
	const result = await runSecrets(
		[
			"login",
			"--cert",
			"mesh-node",
			"--cert-file",
			join(dir, "cert.pem"),
			"--key-file",
			join(dir, "key.pem"),
		],
		node
	);
	expect(result.code).toBe(0);
	expect(result.out).toBe("rvt_issued\n");
	const sent = JSON.parse(node.calls[0]?.body ?? "{}");
	expect(sent.identity).toBe("mesh-node");
	expect(sent.certificatePem).toContain("BEGIN CERTIFICATE");
	expect(sent.proof.split(".")).toHaveLength(3);
	expect(node.calls[0]?.body).not.toContain("PRIVATE KEY");
	expect(node.calls[0]?.headers.get("authorization")).toBeNull();
});

test("login --aws signs with the AWS environment and --k8s reads the token file", async () => {
	const node = fakeNode({
		"POST /api/vault/auth/aws/login": json(issued),
		"POST /api/vault/auth/kubernetes/login": json(issued),
	});
	const missing = await runSecrets(
		["login", "--aws", "ci", "--server-id", "vault.example"],
		node
	);
	expect(missing.code).not.toBe(0);
	expect(missing.err).toContain("AWS_ACCESS_KEY_ID");
	const aws = await runSecrets(
		[
			"login",
			"--aws",
			"ci",
			"--server-id",
			"vault.example",
			"--region",
			"eu-west-1",
		],
		node,
		{
			env: {
				HOME: "/home/me",
				AWS_ACCESS_KEY_ID: "AKID",
				AWS_SECRET_ACCESS_KEY: "s3cr3t-key",
			},
		}
	);
	expect(aws.code).toBe(0);
	const awsBody = node.calls.at(-1)?.body ?? "";
	expect(awsBody).not.toContain("s3cr3t-key");
	const headers = JSON.parse(
		Buffer.from(JSON.parse(awsBody).iamRequestHeaders, "base64").toString(
			"utf8"
		)
	);
	expect(headers.authorization).toContain("Credential=AKID/");
	expect(headers.authorization).toContain("/eu-west-1/sts/aws4_request");

	dir = await mkdtemp(join(tmpdir(), "ryu-k8s-login-"));
	await writeFile(join(dir, "token"), "eyJ.sa.token\n");
	const k8s = await runSecrets(
		["login", "--k8s", "web", "--jwt-file", join(dir, "token")],
		node
	);
	expect(k8s.code).toBe(0);
	expect(JSON.parse(node.calls.at(-1)?.body ?? "{}")).toEqual({
		identity: "web",
		jwt: "eyJ.sa.token",
	});
});

test("login --k8s defaults to the pod's service-account token file", async () => {
	const node = fakeNode({});
	const result = await runSecrets(["login", "--k8s", "web"], node);
	expect(K8S_TOKEN_PATH).toBe(
		"/var/run/secrets/kubernetes.io/serviceaccount/token"
	);
	expect(result.code).not.toBe(0);
	expect(result.err).toContain(K8S_TOKEN_PATH);
	expect(node.calls).toHaveLength(0);
});

test("login without a method prints the usage with every method", async () => {
	const result = await runSecrets(["login"], fakeNode({}));
	expect(result.code).not.toBe(0);
	for (const method of ["--approle", "--jwt", "--cert", "--aws", "--k8s"]) {
		expect(result.err).toContain(method);
	}
});
