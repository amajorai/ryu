import { expect, test } from "bun:test";
import {
	createVaultMachine,
	listVaultMachines,
	setVaultMachineTokenConfig,
} from "./machine-identities.ts";

interface Seen {
	body: unknown;
	method: string;
	url: string;
}

function fakeCore(reply: unknown) {
	const seen: Seen[] = [];
	const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
		seen.push({
			url: new URL(String(input)).pathname,
			method: init?.method ?? "GET",
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		});
		return Promise.resolve(Response.json(reply));
	};
	return {
		seen,
		target: { url: "http://127.0.0.1:7777", token: "node-token", fetch },
	};
}

// `MachineIdentity` from `vault/machine.rs`: `AuthMethod` is internally
// tagged; the newtype variants carry the camelCase auth configs from
// `vault/auth_methods.rs` with their `Option`s rendered as null.
const base = {
	policies: ["ci"],
	tokenTtlSecs: 900,
	disabled: false,
	createdAt: "2030-01-01T00:00:00+00:00",
	createdBy: "user:alice",
	tokenConfig: {},
};
const certAuth = {
	kind: "cert",
	caPem: "-----BEGIN CERTIFICATE-----",
	allowedCommonNames: ["node-*"],
};
const machines = [
	{
		...base,
		id: "mi_1",
		name: "runner",
		auth: { kind: "approle", role_id: "role-1" },
	},
	{
		...base,
		id: "mi_2",
		name: "mesh-node",
		auth: { ...certAuth, allowedDnsSans: [], allowedUriSans: [] },
	},
	{
		...base,
		id: "mi_3",
		name: "ci-aws",
		auth: {
			kind: "aws-iam",
			boundIamPrincipalArns: ["arn:aws:iam::123456789012:role/ci-*"],
			serverIdHeaderValue: "vault.example",
			stsEndpoint: null,
		},
		tokenConfig: { maxTtlSecs: 3600, boundCidrs: ["10.0.0.0/8"] },
	},
	{
		...base,
		id: "mi_4",
		name: "web",
		auth: {
			kind: "kubernetes",
			host: "https://10.0.0.1:6443",
			caPem: null,
			reviewerJwtEnv: null,
			boundServiceAccountNames: ["web"],
			boundServiceAccountNamespaces: ["prod"],
			audiences: [],
		},
	},
];

test("identities of every auth kind parse", async () => {
	const { target } = fakeCore({ machines });
	const listed = await listVaultMachines(target);
	expect(listed.machines.map((machine) => machine.auth.kind)).toEqual([
		"approle",
		"cert",
		"aws-iam",
		"kubernetes",
	]);
	expect(listed.machines[2]?.tokenConfig?.boundCidrs).toEqual(["10.0.0.0/8"]);
});

test("a cert identity is created with its CA and name globs", async () => {
	const { seen, target } = fakeCore({ machine: machines[1] });
	await createVaultMachine(target, {
		name: "mesh-node",
		auth: {
			kind: "cert",
			caPem: "-----BEGIN CERTIFICATE-----",
			allowedCommonNames: ["node-*"],
		},
		policies: ["mesh"],
	});
	expect(seen[0]).toEqual({
		url: "/api/vault/machines",
		method: "POST",
		body: { name: "mesh-node", auth: certAuth, policies: ["mesh"] },
	});
});

test("token config is replaced with PUT on the identity", async () => {
	const { seen, target } = fakeCore({ machine: machines[2] });
	await setVaultMachineTokenConfig(target, "ci aws", {
		maxTtlSecs: 3600,
		boundCidrs: ["10.0.0.0/8"],
	});
	expect(seen[0]).toEqual({
		url: "/api/vault/machines/ci%20aws/token-config",
		method: "PUT",
		body: { maxTtlSecs: 3600, boundCidrs: ["10.0.0.0/8"] },
	});
});
