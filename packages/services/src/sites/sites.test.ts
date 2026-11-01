import { describe, expect, test } from "bun:test";
import {
	RyuAuthenticationError,
	RyuConfigurationError,
	RyuConflictError,
	RyuInvalidRequestError,
	RyuNotFoundError,
	RyuUnavailableError,
} from "../errors.ts";
import { Ryu } from "../ryu.ts";
import { siteUrl } from "./client.ts";
import { SITES_ROUTES, SITES_SDK_ROUTES } from "./routes.ts";

import {
	BASE,
	client,
	ENV,
	failure,
	HTML,
	KEY,
	NOW,
	type Recorded,
	SITE_ID,
	STATUS,
	site,
	sitesError,
	sitesServer,
	stubFetch,
	version,
} from "./sites-test-fixtures.ts";

describe("Sites route table", () => {
	test("mounts the management contract and has no idempotent routes", () => {
		expect(SITES_ROUTES.mount).toBe("/api/sites");
		expect(SITES_ROUTES.idempotent).toEqual([]);
		for (const route of SITES_SDK_ROUTES) {
			expect(route.path.startsWith("/api/sites/")).toBe(true);
		}
	});
});

describe("siteUrl", () => {
	test("builds the visitor URL the way the Sites service does", () => {
		expect(siteUrl("launch-notes", STATUS)).toBe(
			"http://launch-notes.localhost:8022/"
		);
		expect(
			siteUrl("launch-notes", {
				baseDomain: "sites.example.com",
				visitorPort: 8022,
			})
		).toBe("https://launch-notes.sites.example.com/");
	});
});

describe("ryu.sites.deploy", () => {
	test("reads the revision, saves the HTML with expectedRevision, then deploys", async () => {
		const { calls, ryu } = client(sitesServer({ revision: 4 }));
		const result = await ryu.sites.deploy({
			projectId: SITE_ID,
			html: HTML,
			message: "first",
		});
		expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
			`GET ${BASE}/api/sites/projects/${SITE_ID}`,
			`GET ${BASE}/api/sites/status`,
			`POST ${BASE}/api/sites/projects/${SITE_ID}/versions`,
			`POST ${BASE}/api/sites/projects/${SITE_ID}/deploy`,
		]);
		expect(JSON.parse(calls[2]?.body ?? "{}")).toEqual({
			expectedRevision: 4,
			html: HTML,
			message: "first",
		});
		expect(JSON.parse(calls[3]?.body ?? "{}")).toEqual({
			expectedRevision: 5,
			versionId: "ver_1",
		});
		expect(result.version?.id).toBe("ver_1");
		expect(result.project.deploymentId).toBe("ver_1");
		expect(result.project.revision).toBe(6);
		expect(result.project.settings.audience).toBe("private");
		expect(result.url).toBe("http://launch-notes.localhost:8022/");
		for (const call of calls) {
			expect(call.headers.get("authorization")).toBe(`Bearer ${KEY}`);
			expect(call.headers.get("idempotency-key")).toBeNull();
		}
	});

	test("a pinned expectedRevision skips the read", async () => {
		const { calls, ryu } = client(sitesServer({ revision: 2 }));
		await ryu.sites.deploy({
			projectId: SITE_ID,
			html: HTML,
			expectedRevision: 2,
		});
		expect(calls.map((call) => call.method)).toEqual(["GET", "POST", "POST"]);
		expect(calls[0]?.url).toBe(`${BASE}/api/sites/status`);
	});

	test("deploys a saved version", async () => {
		const { calls, ryu } = client(sitesServer({ revision: 0 }));
		const saved = await ryu.sites.versions.create(SITE_ID, {
			html: HTML,
			expectedRevision: 0,
		});
		expect(saved.revision).toBe(1);
		const result = await ryu.sites.deploy({
			projectId: SITE_ID,
			versionId: "ver_1",
		});
		expect(result.version?.id).toBe("ver_1");
		expect(JSON.parse(calls.at(-1)?.body ?? "{}")).toEqual({
			expectedRevision: 1,
			versionId: "ver_1",
		});
	});

	test("a stale revision is RyuConflictError with details, and is not retried", async () => {
		const { calls, ryu } = client(sitesServer({ revision: 3 }));
		const error = await failure(
			ryu.sites.deploy({ projectId: SITE_ID, html: HTML, expectedRevision: 1 })
		);
		expect(error).toBeInstanceOf(RyuConflictError);
		expect(error.status).toBe(409);
		expect(error.code).toBe("conflict");
		expect(error.details).toEqual({
			expectedRevision: 1,
			projectId: SITE_ID,
			step: "version",
		});
		expect(error.attempts).toBe(1);
		expect(calls.filter((call) => call.url.endsWith("/versions"))).toHaveLength(
			1
		);
	});

	test("a blocked deploy names the saved version so it can be deployed later", async () => {
		const server = sitesServer({ revision: 0 });
		const { ryu } = client((request) =>
			request.url.endsWith("/deploy")
				? sitesError(
						422,
						"security_blocked",
						"A potential secret was detected."
					)
				: server(request)
		);
		const error = await failure(
			ryu.sites.deploy({ projectId: SITE_ID, html: HTML })
		);
		expect(error).toBeInstanceOf(RyuInvalidRequestError);
		expect(error.code).toBe("security_blocked");
		expect(error.details).toEqual({
			expectedRevision: 1,
			projectId: SITE_ID,
			step: "deploy",
			versionId: "ver_1",
		});
	});

	test("object mode returns the last response's meta", async () => {
		const stub = stubFetch(sitesServer());
		const ryu = new Ryu({ env: ENV, fetch: stub.fetch, result: "object" });
		const { data, error, meta } = await ryu.sites.deploy({
			projectId: SITE_ID,
			html: HTML,
		});
		expect(error).toBeNull();
		expect(data?.url).toBe("http://launch-notes.localhost:8022/");
		expect(meta?.status).toBe(200);
		expect(meta?.attempts).toBe(1);
	});
});

describe("ryu.sites", () => {
	test("a Site's domains, connections, remix source and version tools are typed and decoded", async () => {
		const remixed = {
			...site(1),
			connections: [
				{
					agentId: "ryu",
					description: "",
					id: "crm",
					label: "CRM",
					readOnly: true,
					revision: 2,
					toolId: "crm.lookup",
					updatedAt: NOW,
					updatedBy: "node-owner",
				},
			],
			domains: [
				{
					checkedAt: null,
					host: "launch.example.com",
					status: "pending_dns",
					verification: "ryu-site-verify=abc",
				},
			],
			remixedFrom: { name: "Template", siteId: "site_src", versionId: "v_1" },
			versions: [
				{
					...version("ver_1"),
					extensions: {
						connections: ["crm"],
						mcp: true,
						tools: [
							{
								collection: "notes",
								description: "Lists notes.",
								name: "list_notes",
								operation: "records.list",
							},
						],
						ui: false,
					},
				},
			],
		};
		const { ryu } = client(() => Response.json(remixed));
		const project = await ryu.sites.projects.get(SITE_ID);
		expect(project.schemaVersion).toBe(1);
		expect(project.domains[0]?.status).toBe("pending_dns");
		expect(project.connections?.[0]?.toolId).toBe("crm.lookup");
		expect(project.remixedFrom?.siteId).toBe("site_src");
		expect(project.versions[0]?.extensions?.tools?.[0]?.name).toBe(
			"list_notes"
		);
		// A domain binding without its host is refused, not passed through.
		const broken = { ...remixed, domains: [{ status: "active" }] };
		const refused = client(() => Response.json(broken));
		await expect(refused.ryu.sites.projects.get(SITE_ID)).rejects.toMatchObject(
			{ code: "invalid_response" }
		);
	});

	test("status, list, get, create and delete use the management routes", async () => {
		const { calls, ryu } = client((request) => {
			const path = new URL(request.url).pathname;
			if (path === "/api/sites/status") {
				return Response.json(STATUS);
			}
			if (request.method === "DELETE") {
				return Response.json({ deleted: true });
			}
			if (path === "/api/sites/projects") {
				return request.method === "POST"
					? Response.json(site(0), { status: 201 })
					: Response.json([site(0)]);
			}
			return Response.json(site(0));
		});
		expect((await ryu.sites.status()).visitorPort).toBe(8022);
		expect(await ryu.sites.projects.list({ scope: "shared" })).toHaveLength(1);
		expect((await ryu.sites.projects.get(SITE_ID)).slug).toBe("launch-notes");
		const created = await ryu.sites.projects.create({
			name: "Launch",
			slug: "launch-notes",
		});
		expect(created.revision).toBe(0);
		expect(
			await ryu.sites.projects.delete(SITE_ID, {
				expectedRevision: 0,
				slug: "launch-notes",
			})
		).toEqual({ deleted: true });
		expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
			`GET ${BASE}/api/sites/status`,
			`GET ${BASE}/api/sites/projects?scope=shared`,
			`GET ${BASE}/api/sites/projects/${SITE_ID}`,
			`POST ${BASE}/api/sites/projects`,
			`DELETE ${BASE}/api/sites/projects/${SITE_ID}`,
		]);
		expect(JSON.parse(calls[3]?.body ?? "{}")).toEqual({
			name: "Launch",
			slug: "launch-notes",
		});
		expect(JSON.parse(calls[4]?.body ?? "{}")).toEqual({
			expectedRevision: 0,
			slug: "launch-notes",
		});
	});

	test("unpublish reads the revision when it is not given", async () => {
		const { calls, ryu } = client(sitesServer({ revision: 7 }));
		const project = await ryu.sites.unpublish(SITE_ID);
		expect(project.deploymentId).toBeNull();
		expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);
		expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({ expectedRevision: 7 });
		const pinned = client(sitesServer({ revision: 7 }));
		await pinned.ryu.sites.unpublish(SITE_ID, { expectedRevision: 7 });
		expect(pinned.calls).toHaveLength(1);
	});

	test("{error:{code,message,fields}} maps to details.fields", async () => {
		const { ryu } = client(() =>
			sitesError(400, "invalid_input", "Check the submitted fields", [
				"slug",
				"name",
			])
		);
		const error = await failure(
			ryu.sites.projects.create({ name: "", slug: "x" })
		);
		expect(error).toBeInstanceOf(RyuInvalidRequestError);
		expect(error.code).toBe("invalid_input");
		expect(error.message).toBe("Check the submitted fields");
		expect(error.details).toEqual({ fields: ["slug", "name"] });
		expect(error.envelope).toBe("nested-error");
	});

	test("a 409 on a direct write is not retried", async () => {
		const { calls, ryu } = client(() =>
			sitesError(409, "conflict", "Site changed. Reload before saving.")
		);
		const error = await failure(
			ryu.sites.versions.create(SITE_ID, { html: HTML, expectedRevision: 0 })
		);
		expect(error).toBeInstanceOf(RyuConflictError);
		expect(calls).toHaveLength(1);
	});

	test("401 and 404 map to typed errors", async () => {
		const denied = client(() =>
			sitesError(401, "unauthorized", "Sign in to manage Sites")
		);
		const unauthorized = await failure(denied.ryu.sites.projects.list());
		expect(unauthorized).toBeInstanceOf(RyuAuthenticationError);
		expect(unauthorized.code).toBe("unauthorized");
		const missing = client(() =>
			sitesError(404, "not_found", "Site not found")
		);
		const notFound = await failure(missing.ryu.sites.projects.get("site_x"));
		expect(notFound).toBeInstanceOf(RyuNotFoundError);
	});

	test("a dot-segment project id is refused before any request", async () => {
		const { calls, ryu } = client(sitesServer());
		const error = await failure(ryu.sites.projects.get(".."));
		expect(error).toBeInstanceOf(RyuInvalidRequestError);
		expect(error.code).toBe("invalid_id");
		expect(calls).toHaveLength(0);
	});

	test("a missing RYU_SITES_URL is a configuration error naming it", async () => {
		const { calls, ryu } = client(sitesServer(), { RYU_SITES_API_KEY: KEY });
		const error = await failure(ryu.sites.status());
		expect(error).toBeInstanceOf(RyuConfigurationError);
		expect(error.details).toEqual({ missing: ["RYU_SITES_URL"] });
		expect(calls).toHaveLength(0);
	});
});

describe("ryu.sites.deploy after the deploy committed", () => {
	/** Wraps the test server so the deploy reply leaves the deployed version out of `versions`. */
	function withoutDeployedVersion(revision: number) {
		const server = sitesServer({ revision });
		return async (request: Recorded): Promise<Response> => {
			const response = server(request);
			if (!new URL(request.url).pathname.endsWith("/deploy")) {
				return response;
			}
			const project = (await response.json()) as Record<string, unknown>;
			return Response.json({ ...project, versions: [] });
		};
	}

	test("falls back to the saved version instead of throwing", async () => {
		const { calls, ryu } = client(withoutDeployedVersion(0));
		const result = await ryu.sites.deploy({ projectId: SITE_ID, html: HTML });
		expect(result.project.deploymentId).toBe("ver_1");
		expect(result.version?.id).toBe("ver_1");
		expect(calls.at(-1)?.url).toBe(
			`${BASE}/api/sites/projects/${SITE_ID}/deploy`
		);
	});

	test("returns version null for a saved version the reply leaves out", async () => {
		const { ryu } = client(withoutDeployedVersion(0));
		const result = await ryu.sites.deploy({
			projectId: SITE_ID,
			versionId: "ver_9",
			expectedRevision: 0,
		});
		expect(result.project.deploymentId).toBe("ver_9");
		expect(result.version).toBeNull();
	});
});

describe("ryu.sites.projects.delete retries", () => {
	/**
	 * Mirrors the Sites DELETE handler: it bumps the revision before removing
	 * the Site's Spaces database, so a database failure (503) leaves a newer
	 * revision behind and a replay with the old one is refused with 409.
	 */
	function partialDelete() {
		let revision = 3;
		return (request: Recorded): Response => {
			const body = JSON.parse(request.body ?? "{}") as {
				expectedRevision?: number;
			};
			if (body.expectedRevision !== revision) {
				return sitesError(
					409,
					"conflict",
					"Site changed. Reload before saving."
				);
			}
			revision += 1;
			return Response.json(
				{
					error: {
						code: "platform_unavailable",
						message: "Ryu Spaces is unavailable",
					},
				},
				{ status: 503, headers: { "retry-after": "0" } }
			);
		};
	}

	test("a 5xx after the revision moved is sent once and reports the first failure", async () => {
		const { calls, ryu } = client(partialDelete());
		const error = await failure(
			ryu.sites.projects.delete(SITE_ID, {
				expectedRevision: 3,
				slug: "launch-notes",
			})
		);
		// A replay would resend the stale expectedRevision and answer a spurious 409.
		expect(error).toBeInstanceOf(RyuUnavailableError);
		expect(error.code).toBe("platform_unavailable");
		expect(calls.map((call) => call.method)).toEqual(["DELETE"]);
	});

	test("a lost reply after the write applied is not replayed into a spurious 409", async () => {
		const stub = stubFetch(() => {
			throw new TypeError("fetch failed");
		});
		const ryu = new Ryu({ env: ENV, fetch: stub.fetch });
		await failure(
			ryu.sites.projects.delete(SITE_ID, {
				expectedRevision: 3,
				slug: "launch-notes",
			})
		);
		expect(stub.calls).toHaveLength(1);
	});

	test("maxRetries: 0 reports the first failure", async () => {
		const stub = stubFetch(partialDelete());
		const ryu = new Ryu({ env: ENV, fetch: stub.fetch, maxRetries: 0 });
		const error = await failure(
			ryu.sites.projects.delete(SITE_ID, {
				expectedRevision: 3,
				slug: "launch-notes",
			})
		);
		expect(error).toBeInstanceOf(RyuUnavailableError);
		expect(error.code).toBe("platform_unavailable");
		expect(stub.calls).toHaveLength(1);
	});
});

describe("a RYU_SITES_URL on the visitor listener", () => {
	const visitorEnv = {
		RYU_SITES_API_KEY: "s",
		RYU_SITES_URL: "http://127.0.0.1:8022",
	};

	test("gets a hint naming the management port", async () => {
		const { ryu } = client(
			() => sitesError(404, "not_found", "Site is not deployed"),
			visitorEnv
		);
		for (const call of [
			ryu.sites.status(),
			ryu.sites.projects.create({ name: "Launch", slug: "launch-site" }),
		]) {
			const error = await failure(call);
			expect(error).toBeInstanceOf(RyuNotFoundError);
			expect(error.message).toBe(`Site is not deployed. Hint: ${error.hint}`);
			expect(error.hint).toContain("visitor listener");
			expect(error.hint).toContain("RYU_SITES_PORT, 8021 by default");
		}
	});

	test("a management 404 keeps its own message and no visitor hint", async () => {
		const { ryu } = client(() =>
			sitesError(404, "not_found", "Project not found")
		);
		const error = await failure(ryu.sites.projects.get("site_9"));
		expect(error).toBeInstanceOf(RyuNotFoundError);
		expect(error.hint ?? "").not.toContain("visitor listener");
	});
});
