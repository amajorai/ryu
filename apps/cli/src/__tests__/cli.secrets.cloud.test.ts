import { describe, expect, test } from "bun:test";
import { cloudVaultBase } from "../cli/secrets-cloud.ts";
import { fakeNode, runSecrets } from "./secrets-fixture.ts";

const KEY = "ryu_sa_test_key";
const ORG = "org-1";
const BASE = `https://api.example.test/api/control-plane/orgs/${ORG}/vault`;

interface Sent {
	body: unknown;
	headers: Headers;
	method: string;
	url: string;
}

const ROW = {
	name: "DATABASE_URL",
	scope: "org",
	scopeId: ORG,
	environment: "production",
	path: "/",
	version: 3,
	status: "active",
	capabilities: ["list", "read"],
	updatedAt: "2026-11-14T00:00:00.000Z",
};

/** A control plane that answers the two service-account routes. */
function controlPlane(reply?: (sent: Sent) => Response) {
	const sent: Sent[] = [];
	const fetch = (input: string, init?: RequestInit) => {
		const entry: Sent = {
			url: input,
			method: init?.method ?? "GET",
			headers: new Headers(init?.headers),
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		};
		sent.push(entry);
		if (reply) {
			return Promise.resolve(reply(entry));
		}
		return Promise.resolve(
			entry.method === "GET"
				? Response.json({
						secrets: [ROW, { ...ROW, scope: "project", scopeId: "p-1" }],
					})
				: Response.json({ value: "postgres://user:pw@db/app" })
		);
	};
	return { fetch, sent };
}

function run(
	argv: string[],
	plane: ReturnType<typeof controlPlane>,
	env: Record<string, string> = {}
) {
	return runSecrets(["cloud", ...argv], fakeNode({}), {
		env: {
			HOME: "/home/me",
			RYU_AUTH_URL: "https://api.example.test",
			RYU_SERVICE_ACCOUNT_KEY: KEY,
			...env,
		},
		fetch: plane.fetch,
	});
}

describe("ryu-cli secrets cloud", () => {
	test("list sends the key as x-api-key and prints scope and version", async () => {
		const plane = controlPlane();
		const listed = await run(
			["list", "--org", ORG, "--env", "production"],
			plane
		);
		expect(listed.code).toBe(0);
		expect(plane.sent[0]?.url).toBe(`${BASE}/secrets?environment=production`);
		expect(plane.sent[0]?.headers.get("x-api-key")).toBe(KEY);
		expect(listed.out).toContain("DATABASE_URL");
		expect(listed.out).toContain("project:p-1");
		expect(listed.out).not.toContain(KEY);
	});

	test("get reveals an org value, or a project value with --project", async () => {
		const plane = controlPlane();
		const org = await run(
			["get", "DATABASE_URL", "--org", ORG, "--env", "production"],
			plane
		);
		expect(org.code).toBe(0);
		expect(org.out).toBe("postgres://user:pw@db/app\n");
		expect(plane.sent[0]?.url).toBe(`${BASE}/secrets/DATABASE_URL/reveal`);
		expect(plane.sent[0]?.body).toEqual({
			scope: "org",
			scopeId: ORG,
			environment: "production",
			path: "/",
		});
		await run(
			["get", "API_KEY", "--org", ORG, "--project", "p-1", "--path", "/svc"],
			plane
		);
		expect(plane.sent[1]?.body).toEqual({
			scope: "project",
			scopeId: "p-1",
			environment: "default",
			path: "/svc",
		});
	});

	test("without a key, nothing is sent", async () => {
		const plane = controlPlane();
		const refused = await run(["list", "--org", ORG], plane, {
			RYU_SERVICE_ACCOUNT_KEY: "",
		});
		expect(refused.code).not.toBe(0);
		expect(refused.err).toContain("RYU_SERVICE_ACCOUNT_KEY");
		expect(plane.sent).toEqual([]);
	});

	test("a key is never sent over plain HTTP except to this machine", async () => {
		const plane = controlPlane();
		const refused = await run(["list", "--org", ORG], plane, {
			RYU_AUTH_URL: "http://api.example.test",
		});
		expect(refused.code).not.toBe(0);
		expect(refused.err).toContain("plain HTTP");
		expect(plane.sent).toEqual([]);
		expect(cloudVaultBase({ RYU_AUTH_URL: "http://localhost:3000" }, ORG)).toBe(
			`http://localhost:3000/api/control-plane/orgs/${ORG}/vault`
		);
	});

	test("get is refused in an AI agent session before any request; list is not", async () => {
		const plane = controlPlane();
		for (const argv of [
			["get", "DATABASE_URL", "--org", ORG],
			["--org", ORG, "get", "DATABASE_URL"],
		]) {
			const refused = await run(argv, plane, { CLAUDECODE: "1" });
			expect(refused.code).not.toBe(0);
			expect(refused.out).not.toContain("postgres://");
		}
		expect(plane.sent).toEqual([]);
		const listed = await run(["list", "--org", ORG], plane, {
			CLAUDECODE: "1",
		});
		expect(listed.code).toBe(0);
	});

	test("a refusal shows the server's sentence, never the key", async () => {
		// The control plane answers a key refusal in plain text unless the
		// request accepts JSON; the CLI asks for JSON and reads either.
		for (const reply of [
			new Response("vault_denied: read on `production/DATABASE_URL`", {
				status: 403,
			}),
			Response.json(
				{ error: "vault_denied: read on `production/DATABASE_URL`" },
				{ status: 403 }
			),
		]) {
			const plane = controlPlane(() => reply);
			const refused = await run(["get", "DATABASE_URL", "--org", ORG], plane);
			expect(refused.code).not.toBe(0);
			expect(refused.err).toContain("vault_denied: read on");
			expect(refused.err).not.toContain(KEY);
			expect(plane.sent[0]?.headers.get("accept")).toBe("application/json");
		}
	});

	test("a redirect is never followed, so the key never reaches another host", async () => {
		const sent: { redirect?: RequestRedirect; url: string }[] = [];
		const refused = await runSecrets(
			["cloud", "list", "--org", ORG],
			fakeNode({}),
			{
				env: {
					HOME: "/home/me",
					RYU_AUTH_URL: "https://api.example.test",
					RYU_SERVICE_ACCOUNT_KEY: KEY,
				},
				fetch: (input: string, init?: RequestInit) => {
					sent.push({ url: input, redirect: init?.redirect });
					return Promise.resolve(
						Response.redirect("http://evil.example/steal", 307)
					);
				},
			}
		);
		expect(refused.code).not.toBe(0);
		expect(refused.err).toContain("not followed");
		expect(sent).toEqual([{ url: `${BASE}/secrets`, redirect: "manual" }]);
	});

	test("`.` and `..` are refused as an org or a name", async () => {
		const plane = controlPlane();
		for (const argv of [
			["list", "--org", ".."],
			["get", "..", "--org", ORG],
			["get", "X", "--org", "."],
		]) {
			expect((await run(argv, plane)).code).not.toBe(0);
		}
		expect(plane.sent).toEqual([]);
	});
});
