import { expect, test } from "bun:test";
import {
	vaultAwsLogin,
	vaultCertLogin,
	vaultKubernetesLogin,
} from "./machine-logins.ts";

interface Seen {
	body: unknown;
	headers: Headers;
	url: string;
}

// `IssuedToken` from `vault/machine.rs`, as `login_token_response` wraps it.
const issued = {
	token: {
		token: "rvt_secret",
		accessor: "acc_1",
		identityId: "mi_1",
		policies: ["ci"],
		expiresAt: "2030-01-01T00:15:00+00:00",
	},
};

function machineTarget() {
	const seen: Seen[] = [];
	const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
		seen.push({
			url: new URL(String(input)).pathname,
			body: JSON.parse(String(init?.body)),
			headers: new Headers(init?.headers),
		});
		return Promise.resolve(Response.json(issued));
	};
	return { seen, target: { url: "https://node.example/", fetch } };
}

test("cert, AWS and Kubernetes logins post their bodies to the public routes", async () => {
	const { seen, target } = machineTarget();
	const cert = await vaultCertLogin(target, {
		identity: "mesh-node",
		certificatePem: "-----BEGIN CERTIFICATE-----",
		proof: "eyJ.proof.sig",
	});
	expect(cert.token.accessor).toBe("acc_1");
	await vaultAwsLogin(target, {
		identity: "ci",
		iamHttpRequestMethod: "POST",
		iamRequestUrl: "aHR0cHM6Ly9zdHMuYW1hem9uYXdzLmNvbS8=",
		iamRequestBody: "Ym9keQ==",
		iamRequestHeaders: "e30=",
	});
	await vaultKubernetesLogin(target, { identity: "web", jwt: "eyJ.sa.token" });
	expect(seen.map((call) => call.url)).toEqual([
		"/api/vault/auth/cert/login",
		"/api/vault/auth/aws/login",
		"/api/vault/auth/kubernetes/login",
	]);
	expect(seen[0]?.body).toEqual({
		identity: "mesh-node",
		certificatePem: "-----BEGIN CERTIFICATE-----",
		proof: "eyJ.proof.sig",
	});
	expect(seen[1]?.body).toMatchObject({
		identity: "ci",
		iamRequestHeaders: "e30=",
	});
	expect(seen[2]?.body).toEqual({ identity: "web", jwt: "eyJ.sa.token" });
	for (const call of seen) {
		expect(call.headers.get("authorization")).toBeNull();
		expect(call.headers.get("x-ryu-vault-token")).toBeNull();
	}
});

test("a refused login surfaces Core's status", async () => {
	const target = {
		url: "https://node.example",
		fetch: () =>
			Promise.resolve(
				Response.json(
					{
						error: { code: "vault_forbidden", message: "certificate rejected" },
					},
					{ status: 403 }
				)
			),
	};
	await expect(
		vaultKubernetesLogin(target, { identity: "web", jwt: "bad" })
	).rejects.toMatchObject({ status: 403 });
});
