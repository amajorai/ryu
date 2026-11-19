// `ryu-cli secrets login --azure|--gcp` (workload OIDC tokens from the cloud
// metadata service, sent to JWT login) and `login … --no-store -- CMD`.

import { expect, test } from "bun:test";
import {
	AZURE_DEFAULT_RESOURCE,
	AZURE_IMDS_TOKEN_URL,
	azureManagedIdentityJwt,
	GCP_IDENTITY_URL,
	gcpIdentityJwt,
} from "../cli/secrets-login-cloud.ts";
import type { FetchLike } from "../cli/types.ts";
import { fakeNode, json, runSecrets } from "./secrets-fixture.ts";

const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ3b3JrbG9hZCJ9.c2ln";
const issued = {
	token: {
		token: "rvt_issued_secret",
		accessor: "acc_1",
		identityId: "mi_1",
		policies: ["ci"],
		expiresAt: "2030-01-01T00:15:00Z",
	},
};

interface Probe {
	headers: Headers;
	url: string;
}

function metadata(respond: (url: URL) => Response) {
	const probes: Probe[] = [];
	const fetch: FetchLike = (input, init) => {
		probes.push({ url: input, headers: new Headers(init?.headers) });
		return Promise.resolve(respond(new URL(input)));
	};
	return { fetch, probes };
}

test("Azure reads IMDS with Metadata: true, or the App Service endpoint", async () => {
	const imds = metadata(() => Response.json({ access_token: JWT }));
	expect(
		await azureManagedIdentityJwt(imds.fetch, {}, { clientId: "cid" })
	).toBe(JWT);
	const url = new URL(imds.probes[0]?.url ?? "");
	expect(`${url.origin}${url.pathname}`).toBe(AZURE_IMDS_TOKEN_URL);
	expect(url.searchParams.get("resource")).toBe(AZURE_DEFAULT_RESOURCE);
	expect(url.searchParams.get("client_id")).toBe("cid");
	expect(url.searchParams.get("api-version")).toBe("2018-02-01");
	expect(imds.probes[0]?.headers.get("metadata")).toBe("true");

	const appService = metadata(() => Response.json({ access_token: JWT }));
	await azureManagedIdentityJwt(
		appService.fetch,
		{
			IDENTITY_ENDPOINT: "http://127.0.0.1:41000/msi/token",
			IDENTITY_HEADER: "hdr",
		},
		{ resource: "api://ryu-vault" }
	);
	const app = new URL(appService.probes[0]?.url ?? "");
	expect(app.host).toBe("127.0.0.1:41000");
	expect(app.searchParams.get("resource")).toBe("api://ryu-vault");
	expect(app.searchParams.get("api-version")).toBe("2019-08-01");
	expect(appService.probes[0]?.headers.get("x-identity-header")).toBe("hdr");
});

test("metadata failures are usage errors that never echo a body", async () => {
	const refused = metadata(() => new Response("token=leaky", { status: 400 }));
	const error = await azureManagedIdentityJwt(refused.fetch, {}).catch(
		(e) => e
	);
	expect(String(error)).toContain("HTTP 400");
	expect(String(error)).not.toContain("leaky");
	const notJwt = metadata(() => Response.json({ access_token: "opaque" }));
	await expect(azureManagedIdentityJwt(notJwt.fetch, {})).rejects.toThrow(
		"JWT"
	);
	const unreachable: FetchLike = () => Promise.reject(new Error("no route"));
	await expect(gcpIdentityJwt(unreachable, "aud")).rejects.toThrow("no route");
});

test("GCP asks the metadata server for a full-format token for the audience", async () => {
	const gcp = metadata(() => new Response(`${JWT}\n`));
	expect(await gcpIdentityJwt(gcp.fetch, "https://vault.example")).toBe(JWT);
	const url = new URL(gcp.probes[0]?.url ?? "");
	expect(`${url.origin}${url.pathname}`).toBe(GCP_IDENTITY_URL);
	expect(url.searchParams.get("audience")).toBe("https://vault.example");
	expect(url.searchParams.get("format")).toBe("full");
	expect(gcp.probes[0]?.headers.get("metadata-flavor")).toBe("Google");
});

test("login --azure and --gcp send the metadata token to JWT login", async () => {
	const node = fakeNode({ "POST /api/vault/auth/jwt/login": json(issued) });
	const azure = await runSecrets(["login", "--azure", "web"], node, {
		fetch: metadata(() => Response.json({ access_token: JWT })).fetch,
	});
	expect(azure.code).toBe(0);
	expect(azure.out).toBe("rvt_issued_secret\n");
	expect(JSON.parse(node.calls[0]?.body ?? "{}")).toEqual({
		identity: "web",
		jwt: JWT,
	});
	const gcpProbe = metadata(() => new Response(JWT));
	const gcp = await runSecrets(["login", "--gcp", "batch"], node, {
		fetch: gcpProbe.fetch,
	});
	expect(gcp.code).toBe(0);
	// The audience defaults to the node address.
	expect(
		new URL(gcpProbe.probes[0]?.url ?? "").searchParams.get("audience")
	).toBe("http://node.test");
	expect(
		node.calls.every((call) => call.headers.get("authorization") === null)
	).toBe(true);
});

test("login --no-store gives the token only to the command, then revokes it", async () => {
	const node = fakeNode({
		"POST /api/vault/auth/approle/login": json(issued),
		"POST /api/vault/agent/self/revoke": json({ revoked: true }),
	});
	const seen: Array<{ cmd: string[]; env: Record<string, string> }> = [];
	const result = await runSecrets(
		[
			"login",
			"--approle",
			"role-1",
			"sid-1",
			"--no-store",
			"--",
			"deploy",
			"--prod",
		],
		node,
		{
			env: { HOME: "/home/me", PATH: "/bin" },
			spawn: (cmd, env) => {
				seen.push({ cmd, env });
				return Promise.resolve(7);
			},
		}
	);
	expect(result.code).toBe(7);
	expect(seen).toEqual([
		{
			cmd: ["deploy", "--prod"],
			env: {
				HOME: "/home/me",
				PATH: "/bin",
				RYU_VAULT_TOKEN: "rvt_issued_secret",
			},
		},
	]);
	expect(result.out + result.err).not.toContain("rvt_issued_secret");
	expect(node.calls.map((call) => call.route)).toEqual([
		"POST /api/vault/auth/approle/login",
		"POST /api/vault/agent/self/revoke",
	]);
	expect(node.calls[1]?.headers.get("x-ryu-vault-token")).toBe(
		"rvt_issued_secret"
	);
});

test("--no-store needs a command, a command needs --no-store, and a failed revoke is reported", async () => {
	const node = fakeNode({ "POST /api/vault/auth/approle/login": json(issued) });
	const bare = await runSecrets(
		["login", "--approle", "r", "s", "--no-store"],
		node
	);
	expect(bare.code).toBe(2);
	const cmdOnly = await runSecrets(
		["login", "--approle", "r", "s", "--", "x"],
		node
	);
	expect(cmdOnly.code).toBe(2);
	expect(node.calls).toHaveLength(0);
	const failed = await runSecrets(
		["login", "--approle", "r", "s", "--no-store", "--", "x"],
		node
	);
	expect(failed.code).toBe(0);
	expect(failed.err).toContain("Could not revoke");
	expect(failed.err).toContain("acc_1");
	expect(failed.err).not.toContain("rvt_issued_secret");
});
