import { describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { RyuFetch } from "@ryuhq/services";
import { type CliIo, runCli } from "../cli.ts";
import {
	defaultPassportUsageWindow,
	passportCommands,
} from "../commands/passport.ts";
import { sitesCommands } from "../commands/sites.ts";
import { createServicesMcpServer, mcpModeLine } from "../mcp/server.ts";
import { workspaceProgram } from "../program.ts";
import { commandLine } from "../registry.ts";

interface Recorded {
	body: string | null;
	headers: Headers;
	method: string;
	url: string;
}

function stubFetch(respond: (request: Recorded) => Response) {
	const calls: Recorded[] = [];
	const fetch: RyuFetch = async (input, init) => {
		const request = new Request(input, init);
		const recorded: Recorded = {
			body: request.body === null ? null : await request.text(),
			headers: request.headers,
			method: request.method,
			url: request.url,
		};
		calls.push(recorded);
		return respond(recorded);
	};
	return { calls, fetch };
}

function capture(
	fetch: RyuFetch,
	env: Record<string, string>,
	files: Record<string, string> = {}
) {
	let out = "";
	let err = "";
	const io: CliIo = {
		env,
		stdin: "",
		stdout: { write: (chunk: string) => (out += chunk) },
		stderr: { write: (chunk: string) => (err += chunk) },
		fetch,
		readFile: (path) =>
			path in files
				? Promise.resolve(files[path] ?? "")
				: Promise.reject(new Error("ENOENT: no such file")),
	};
	return { io, stdout: () => out, stderr: () => err };
}

// --- Passport ----------------------------------------------------------------------------

const PASSPORT = "http://127.0.0.1:8093";
const ADMIN = "passport-admin-cli-secret";
const RUNTIME = "passport-runtime-cli-secret";
const PASSPORT_ENV = {
	RYU_PASSPORT_URL: PASSPORT,
	RYU_PASSPORT_API_KEY: ADMIN,
};
const CONNECTION = {
	created_at: 1_760_000_000,
	domain: "api.github.com",
	flow_status: "DONE",
	id: "conn_1",
	last_checked: 0,
	profile_id: "work",
	source: "manual",
	status: "AUTHENTICATED",
	updated_at: 1_760_000_000,
};

function passportServer(request: Recorded): Response {
	const path = new URL(request.url).pathname;
	switch (`${request.method} ${path}`) {
		case "GET /v1/capabilities":
			return Response.json({
				api_version: "v1",
				features: { profiles: true },
				service: "passport",
			});
		case "GET /v1/profiles":
			return Response.json({
				profiles: [{ connections: [CONNECTION], profile_id: "work" }],
			});
		case "GET /v1/connections":
		case "GET /v1/runtime/connections":
			return Response.json({ connections: [CONNECTION] });
		case "GET /v1/connections/conn_1":
			return Response.json({
				connection: CONNECTION,
				flow_status: "DONE",
				status: "AUTHENTICATED",
			});
		case "POST /v1/connections/conn_1/fetch":
			return Response.json({
				authenticated: true,
				content: '{"login":"octocat"}',
				status: 200,
				truncated: false,
			});
		case "GET /v1/usage":
			return Response.json({
				from: "2026-10-20T13:00:00Z",
				meters: { connectionSeconds: 3600, fetches: 2 },
				ok: true,
				to: "2026-10-21T13:00:00Z",
				type: "usage.report",
			});
		default:
			return Response.json({ error: "connection not found" }, { status: 404 });
	}
}

describe("ryu-services passport", () => {
	test("registers the read-only commands", () => {
		expect(
			passportCommands.map((command) => commandLine("passport", command))
		).toEqual([
			"ryu-services passport capabilities",
			"ryu-services passport profiles",
			"ryu-services passport connections list",
			"ryu-services passport connections get",
			"ryu-services passport usage",
		]);
		expect(passportCommands.every((command) => command.readOnly)).toBe(true);
	});

	test("profiles and connections list --json print { data, meta } with the admin key", async () => {
		const { calls, fetch } = stubFetch(passportServer);
		const profiles = capture(fetch, PASSPORT_ENV);
		expect(await runCli(["passport", "profiles", "--json"], profiles.io)).toBe(
			0
		);
		const printed = JSON.parse(profiles.stdout()) as {
			data: { profiles: { profile_id: string }[] };
			meta: { status: number };
		};
		expect(printed.data.profiles[0]?.profile_id).toBe("work");
		expect(printed.meta.status).toBe(200);

		const listed = capture(fetch, PASSPORT_ENV);
		expect(await runCli(["passport", "connections", "list"], listed.io)).toBe(
			0
		);
		// Human mode: one JSON line per connection, nothing else on stdout.
		const lines = listed.stdout().trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("api.github.com");
		expect(JSON.parse(lines[0] ?? "")).toHaveProperty("id", "conn_1");
		expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
			`GET ${PASSPORT}/v1/profiles`,
			`GET ${PASSPORT}/v1/connections`,
		]);
		for (const call of calls) {
			expect(call.headers.get("authorization")).toBe(`Bearer ${ADMIN}`);
		}
	});

	test("capabilities, connections get and usage", async () => {
		const { calls, fetch } = stubFetch(passportServer);
		for (const argv of [
			["passport", "capabilities"],
			["passport", "connections", "get", "conn_1"],
			[
				"passport",
				"usage",
				"--from",
				"2026-10-01T00:00:00Z",
				"--to",
				"2026-10-01T02:00:00Z",
			],
		]) {
			const run = capture(fetch, PASSPORT_ENV);
			expect(await runCli(argv, run.io)).toBe(0);
		}
		expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
			`GET ${PASSPORT}/v1/capabilities`,
			`GET ${PASSPORT}/v1/connections/conn_1`,
			`GET ${PASSPORT}/v1/usage?from=2026-10-01T00%3A00%3A00Z&to=2026-10-01T02%3A00%3A00Z`,
		]);
	});

	test("connections list with only a runtime grant lists the grant's connections", async () => {
		const { calls, fetch } = stubFetch(passportServer);
		const run = capture(fetch, {
			RYU_PASSPORT_URL: PASSPORT,
			RYU_PASSPORT_RUNTIME_KEY: RUNTIME,
		});
		expect(
			await runCli(["passport", "connections", "list", "--json"], run.io)
		).toBe(0);
		const printed = JSON.parse(run.stdout()) as {
			data: { connections: { id: string }[] };
			meta: { status: number };
		};
		expect(printed.data.connections[0]?.id).toBe("conn_1");
		expect(printed.meta.status).toBe(200);
		expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
			"/v1/runtime/connections",
		]);
		expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${RUNTIME}`);
	});

	test("an administration command with only a runtime grant names the CLI command to run", async () => {
		const { calls, fetch } = stubFetch(passportServer);
		const env = {
			RYU_PASSPORT_URL: PASSPORT,
			RYU_PASSPORT_RUNTIME_KEY: RUNTIME,
		};
		const run = capture(fetch, env);
		expect(await runCli(["passport", "profiles"], run.io)).toBe(2);
		expect(run.stderr()).toContain("configuration_error");
		expect(run.stderr()).toContain(
			"hint: This command needs RYU_PASSPORT_API_KEY"
		);
		expect(run.stderr()).toContain(
			`${workspaceProgram()} passport connections list`
		);
		const hint = run
			.stderr()
			.split("\n")
			.find((line) => line.includes("hint:"));
		expect(hint).not.toContain("ryu.passport.runtime");
		const json = capture(fetch, env);
		expect(await runCli(["passport", "profiles", "--json"], json.io)).toBe(2);
		const printed = JSON.parse(json.stdout()) as {
			error: { hint: string; message: string };
		};
		expect(printed.error.hint).toContain(
			`${workspaceProgram()} passport connections list`
		);
		// The message ends with the CLI hint that replaced the SDK's, not the SDK's.
		expect(printed.error.message).toEndWith(`Hint: ${printed.error.hint}`);
		expect(printed.error.message.match(/Hint:/gu)).toHaveLength(1);
		expect(calls).toHaveLength(0);
	});

	test("connections list with neither key names both keys, not itself", async () => {
		const { calls, fetch } = stubFetch(passportServer);
		const env = { RYU_PASSPORT_URL: PASSPORT };
		const run = capture(fetch, env);
		expect(await runCli(["passport", "connections", "list"], run.io)).toBe(2);
		const hint =
			run
				.stderr()
				.split("\n")
				.find((line) => line.includes("hint:")) ?? "";
		expect(hint).toContain("RYU_PASSPORT_API_KEY");
		expect(hint).toContain("RYU_PASSPORT_RUNTIME_KEY");
		expect(hint).not.toContain("passport connections list");
		// The SDK hint (which names the SDK-only `new Ryu()` option) never
		// rides along in the message beside the CLI hint.
		const errorLine =
			run
				.stderr()
				.split("\n")
				.find((line) => line.startsWith("error ")) ?? "";
		expect(errorLine).toContain("configuration_error");
		expect(errorLine.split("Hint:").length).toBeLessThanOrEqual(2);
		expect(run.stderr()).not.toContain("new Ryu()");
		const json = capture(fetch, env);
		expect(
			await runCli(["passport", "connections", "list", "--json"], json.io)
		).toBe(2);
		const printed = JSON.parse(json.stdout()) as {
			error: {
				code: string;
				details: { missing: string[] };
				hint: string;
				message: string;
			};
		};
		expect(printed.error.code).toBe("configuration_error");
		expect(printed.error.message.split("Hint:")).toHaveLength(2);
		expect(printed.error.message).toContain(printed.error.hint);
		expect(printed.error.message).not.toContain("new Ryu()");
		expect(printed.error.details.missing).toEqual(
			expect.arrayContaining([
				"RYU_PASSPORT_API_KEY",
				"RYU_PASSPORT_RUNTIME_KEY",
			])
		);
		expect(printed.error.hint).not.toContain("connections list");
		expect(calls).toHaveLength(0);
	});

	test("connections list with both keys uses the administration route", async () => {
		const { calls, fetch } = stubFetch(passportServer);
		const run = capture(fetch, {
			...PASSPORT_ENV,
			RYU_PASSPORT_RUNTIME_KEY: RUNTIME,
		});
		expect(
			await runCli(["passport", "connections", "list", "--json"], run.io)
		).toBe(0);
		expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
			"/v1/connections",
		]);
		expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${ADMIN}`);
		const dry = capture(
			() => Promise.reject(new Error("a dry run must not send requests")),
			{ ...PASSPORT_ENV, RYU_PASSPORT_RUNTIME_KEY: RUNTIME }
		);
		expect(
			await runCli(["passport", "connections", "list", "--dry-run"], dry.io)
		).toBe(0);
		expect(dry.stdout()).toContain(`${PASSPORT}/v1/connections`);
		expect(dry.stdout()).not.toContain("/v1/runtime/connections");
		expect(dry.stdout()).toContain("$RYU_PASSPORT_API_KEY");
	});

	test("connections list --dry-run with only a runtime grant prints the runtime curl", async () => {
		let sent = 0;
		const run = capture(
			() => {
				sent += 1;
				return Promise.reject(new Error("a dry run must not send requests"));
			},
			{ RYU_PASSPORT_URL: PASSPORT, RYU_PASSPORT_RUNTIME_KEY: RUNTIME }
		);
		expect(
			await runCli(["passport", "connections", "list", "--dry-run"], run.io)
		).toBe(0);
		expect(sent).toBe(0);
		expect(run.stdout()).toContain(`${PASSPORT}/v1/runtime/connections`);
		expect(run.stdout()).not.toContain(RUNTIME);
	});

	test("usage defaults to the last 24 whole hours, written without fractions", () => {
		const now = Date.parse("2026-10-21T12:34:56.789Z");
		expect(defaultPassportUsageWindow(now)).toEqual({
			from: "2026-10-20T13:00:00Z",
			to: "2026-10-21T13:00:00Z",
		});
		const onTheHour = Date.parse("2026-10-21T12:00:00.000Z");
		expect(defaultPassportUsageWindow(onTheHour)).toEqual({
			from: "2026-10-20T13:00:00Z",
			to: "2026-10-21T13:00:00Z",
		});
	});

	test("usage with only one bound and get without an id are usage errors", async () => {
		const { calls, fetch } = stubFetch(passportServer);
		const half = capture(fetch, PASSPORT_ENV);
		expect(
			await runCli(
				["passport", "usage", "--from", "2026-10-01T00:00:00Z"],
				half.io
			)
		).toBe(2);
		expect(half.stderr()).toContain("both --from and --to");
		const noId = capture(fetch, PASSPORT_ENV);
		expect(await runCli(["passport", "connections", "get"], noId.io)).toBe(2);
		expect(calls).toHaveLength(0);
	});

	test("a Passport error exits 1 with its code", async () => {
		const { fetch } = stubFetch(passportServer);
		const run = capture(fetch, PASSPORT_ENV);
		expect(
			await runCli(["passport", "connections", "get", "conn_missing"], run.io)
		).toBe(1);
		expect(run.stderr()).toContain("not_found");
		expect(run.stderr()).toContain("connection not found");
	});

	test("--dry-run prints curl with the key placeholder and sends nothing", async () => {
		let sent = 0;
		const run = capture(() => {
			sent += 1;
			return Promise.reject(new Error("a dry run must not send requests"));
		}, PASSPORT_ENV);
		expect(await runCli(["passport", "profiles", "--dry-run"], run.io)).toBe(0);
		expect(sent).toBe(0);
		expect(run.stdout()).toContain(`${PASSPORT}/v1/profiles`);
		expect(run.stdout()).toContain("$RYU_PASSPORT_API_KEY");
		expect(run.stdout()).not.toContain(ADMIN);
	});
});

// --- Sites -------------------------------------------------------------------------------

const SITES = "http://127.0.0.1:8021";
const SITES_KEY = "sites-cli-management-secret";
const SITES_ENV = { RYU_SITES_URL: SITES, RYU_SITES_API_KEY: SITES_KEY };
const SITE_ID = "site_1";
const HTML = "<!doctype html><title>Hi</title><p>Hi</p>";
const NOW = "2026-10-21T12:00:00.000Z";

function site(
	revision: number,
	versionIds: string[],
	deploymentId: string | null
) {
	return {
		aliases: [],
		createdAt: NOW,
		deploymentId,
		domains: [],
		hasPublished: deploymentId !== null,
		id: SITE_ID,
		name: "Launch",
		ownerId: "node-owner",
		prompt: "",
		revision,
		settings: { audience: "private", viewers: [], workspaceId: null },
		slug: "launch-notes",
		template: "website",
		updatedAt: NOW,
		versions: versionIds.map((id) => ({
			bytes: HTML.length,
			commit: null,
			createdAt: NOW,
			id,
			message: "cli",
		})),
	};
}

function sitesServer() {
	let current: ReturnType<typeof site> = site(0, [], null);
	return (request: Recorded): Response => {
		const path = new URL(request.url).pathname;
		const body = JSON.parse(request.body ?? "{}") as {
			expectedRevision?: number;
			settings?: ReturnType<typeof site>["settings"];
			versionId?: string;
		};
		switch (`${request.method} ${path}`) {
			case `PUT /api/sites/projects/${SITE_ID}/settings`:
				if (body.expectedRevision !== current.revision) {
					return Response.json(
						{
							error: {
								code: "conflict",
								message: "Site changed. Reload before saving.",
							},
						},
						{ status: 409 }
					);
				}
				current = {
					...current,
					revision: current.revision + 1,
					settings: body.settings ?? current.settings,
				};
				return Response.json(current);
			case "GET /api/sites/status":
				return Response.json({
					apiVersion: "v1",
					baseDomain: "localhost",
					limits: { projects: 30 },
					mode: "standalone",
					publicEnabled: false,
					visitorPort: 8022,
				});
			case "GET /api/sites/projects":
				return Response.json([current]);
			case "POST /api/sites/projects":
				return Response.json(current, { status: 201 });
			case `GET /api/sites/projects/${SITE_ID}`:
				return Response.json(current);
			case `POST /api/sites/projects/${SITE_ID}/versions`:
				if (body.expectedRevision !== current.revision) {
					return Response.json(
						{
							error: {
								code: "conflict",
								message: "Site changed. Reload before saving.",
							},
						},
						{ status: 409 }
					);
				}
				current = site(current.revision + 1, ["ver_1"], null);
				return Response.json(current, { status: 201 });
			case `POST /api/sites/projects/${SITE_ID}/deploy`:
				current = site(current.revision + 1, ["ver_1"], body.versionId ?? null);
				return Response.json(current);
			default:
				return Response.json(
					{ error: { code: "not_found", message: "Site not found" } },
					{ status: 404 }
				);
		}
	};
}

describe("ryu-services sites", () => {
	test("registers the design's commands", () => {
		expect(
			sitesCommands.map((command) => commandLine("sites", command))
		).toEqual([
			"ryu-services sites status",
			"ryu-services sites list",
			"ryu-services sites get",
			"ryu-services sites create",
			"ryu-services sites deploy",
			"ryu-services sites settings",
		]);
	});

	test("create posts the name, slug and options and prints the Site", async () => {
		const { calls, fetch } = stubFetch(sitesServer());
		const run = capture(fetch, SITES_ENV);
		expect(
			await runCli(
				[
					"sites",
					"create",
					"--name",
					"Launch",
					"--slug",
					"launch-notes",
					"--template",
					"dashboard",
					"--prompt",
					"Release notes",
					"--json",
				],
				run.io
			)
		).toBe(0);
		expect((JSON.parse(run.stdout()) as { data: { id: string } }).data.id).toBe(
			SITE_ID
		);
		expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
			`POST ${SITES}/api/sites/projects`,
		]);
		expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${SITES_KEY}`);
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
			name: "Launch",
			prompt: "Release notes",
			slug: "launch-notes",
			template: "dashboard",
		});
	});

	test("create checks the slug and template before sending", async () => {
		const { calls, fetch } = stubFetch(sitesServer());
		for (const [argv, message] of [
			[["--name", "L", "--slug", "Launch"], "--slug must be 5-48"],
			[["--name", "L", "--slug", "abc"], "--slug must be 5-48"],
			[
				["--name", "L", "--slug", "launch-notes", "--template", "blog"],
				"--template must be one of website",
			],
			[["--slug", "launch-notes"], "--name is required."],
		] as const) {
			const run = capture(fetch, SITES_ENV);
			expect(await runCli(["sites", "create", ...argv], run.io)).toBe(2);
			expect(run.stderr()).toContain(message);
			expect(run.stderr()).toContain(
				`Run ${workspaceProgram()} sites create --help for usage.`
			);
		}
		expect(calls).toHaveLength(0);
	});

	test("deploy --project and get take a slug: a 404 on the id looks it up", async () => {
		const { calls, fetch } = stubFetch(sitesServer());
		const run = capture(fetch, SITES_ENV, { "./index.html": HTML });
		expect(
			await runCli(
				["sites", "deploy", "./index.html", "--project", "launch-notes"],
				run.io
			)
		).toBe(0);
		expect(run.stdout()).toContain("http://launch-notes.localhost:8022/");
		expect(
			calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)
		).toEqual([
			"GET /api/sites/projects/launch-notes",
			"GET /api/sites/projects",
			`GET /api/sites/projects/${SITE_ID}`,
			"GET /api/sites/status",
			`POST /api/sites/projects/${SITE_ID}/versions`,
			`POST /api/sites/projects/${SITE_ID}/deploy`,
		]);
		calls.length = 0;
		const got = capture(fetch, SITES_ENV);
		expect(await runCli(["sites", "get", "launch-notes"], got.io)).toBe(0);
		expect(got.stdout()).toContain(`"id": "${SITE_ID}"`);
		expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
			"/api/sites/projects/launch-notes",
			"/api/sites/projects",
			`/api/sites/projects/${SITE_ID}`,
		]);
	});

	test("an unknown Site exits 1 with a hint naming sites list and sites create", async () => {
		const { calls, fetch } = stubFetch(sitesServer());
		const run = capture(fetch, SITES_ENV, { "./index.html": HTML });
		expect(
			await runCli(
				["sites", "deploy", "./index.html", "--project", "no-such-site"],
				run.io
			)
		).toBe(1);
		expect(run.stderr()).toContain("not_found");
		expect(run.stderr()).toContain(`${workspaceProgram()} sites list`);
		expect(run.stderr()).toContain(`${workspaceProgram()} sites create --name`);
		// One lookup by id, then owned and shared Sites searched for the slug;
		// nothing was saved.
		expect(
			calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)
		).toEqual([
			"GET /api/sites/projects/no-such-site",
			"GET /api/sites/projects",
			"GET /api/sites/projects",
		]);
		// A value that cannot be a slug is not looked up.
		calls.length = 0;
		const upper = capture(fetch, SITES_ENV);
		expect(await runCli(["sites", "get", "Site_X"], upper.io)).toBe(1);
		expect(calls).toHaveLength(1);
	});

	test("a UUID is never looked up as a slug, and a failed lookup keeps the original 404", async () => {
		const { calls, fetch } = stubFetch(sitesServer());
		const uuid = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
		const byId = capture(fetch, SITES_ENV);
		expect(await runCli(["sites", "get", uuid], byId.io)).toBe(1);
		expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
			`/api/sites/projects/${uuid}`,
		]);
		// A wrong base path 404s every route, the slug lookup's list call
		// included (with another error); the Site lookup's 404 is what prints.
		const { calls: wrong, fetch: wrongFetch } = stubFetch((request) =>
			new URL(request.url).pathname === "/api/sites/projects"
				? Response.json(
						{ error: { code: "not_found", message: "No such route" } },
						{ status: 404 }
					)
				: Response.json(
						{ error: { code: "not_found", message: "Site not found" } },
						{ status: 404 }
					)
		);
		const run = capture(wrongFetch, SITES_ENV);
		expect(await runCli(["sites", "get", "launch-notes"], run.io)).toBe(1);
		expect(run.stderr()).toContain("Site not found");
		expect(run.stderr()).not.toContain("No such route");
		expect(wrong.map((call) => new URL(call.url).pathname)).toEqual([
			"/api/sites/projects/launch-notes",
			"/api/sites/projects",
		]);
	});

	test("a 404 from the deploy step (Site found, version missing) gets no wrong-id hint", async () => {
		const healthy = sitesServer();
		const { fetch } = stubFetch((request) =>
			new URL(request.url).pathname === `/api/sites/projects/${SITE_ID}/deploy`
				? Response.json(
						{ error: { code: "not_found", message: "Version not found" } },
						{ status: 404 }
					)
				: healthy(request)
		);
		const run = capture(fetch, SITES_ENV, { "./index.html": HTML });
		expect(
			await runCli(
				["sites", "deploy", "./index.html", "--project", SITE_ID, "--json"],
				run.io
			)
		).toBe(1);
		const printed = JSON.parse(run.stdout()) as {
			error: { details?: { step?: string }; hint?: string | null };
		};
		expect(printed.error.details?.step).toBe("deploy");
		expect(printed.error.hint ?? "").not.toContain("sites create");
	});

	test("list, get and status use the management bearer", async () => {
		const { calls, fetch } = stubFetch(sitesServer());
		for (const argv of [
			["sites", "list", "--scope", "shared"],
			["sites", "get", SITE_ID],
			["sites", "status"],
		]) {
			const run = capture(fetch, SITES_ENV);
			expect(await runCli(argv, run.io)).toBe(0);
		}
		expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
			`GET ${SITES}/api/sites/projects?scope=shared`,
			`GET ${SITES}/api/sites/projects/${SITE_ID}`,
			`GET ${SITES}/api/sites/status`,
		]);
		for (const call of calls) {
			expect(call.headers.get("authorization")).toBe(`Bearer ${SITES_KEY}`);
		}
		const bad = capture(fetch, SITES_ENV);
		expect(await runCli(["sites", "list", "--scope", "everyone"], bad.io)).toBe(
			2
		);
		expect(bad.stderr()).toContain("--scope must be one of");
	});

	test("deploy reads the file, saves a version and deploys it", async () => {
		const { calls, fetch } = stubFetch(sitesServer());
		const run = capture(fetch, SITES_ENV, { "./index.html": HTML });
		const code = await runCli(
			[
				"sites",
				"deploy",
				"./index.html",
				"--project",
				SITE_ID,
				"--message",
				"cli",
				"--json",
			],
			run.io
		);
		expect(code).toBe(0);
		const printed = JSON.parse(run.stdout()) as {
			data: { url: string; version: { id: string } };
		};
		expect(printed.data.url).toBe("http://launch-notes.localhost:8022/");
		expect(printed.data.version.id).toBe("ver_1");
		expect(
			calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)
		).toEqual([
			`GET /api/sites/projects/${SITE_ID}`,
			"GET /api/sites/status",
			`POST /api/sites/projects/${SITE_ID}/versions`,
			`POST /api/sites/projects/${SITE_ID}/deploy`,
		]);
		expect(JSON.parse(calls[2]?.body ?? "{}")).toEqual({
			expectedRevision: 0,
			html: HTML,
			message: "cli",
		});
	});

	test("deploy --json keeps the deploy call's meta", async () => {
		const server = sitesServer();
		const { fetch } = stubFetch((request) => {
			const response = server(request);
			response.headers.set("x-request-id", "req_sites");
			return response;
		});
		const run = capture(fetch, SITES_ENV, { "./index.html": HTML });
		const code = await runCli(
			["sites", "deploy", "./index.html", "--project", SITE_ID, "--json"],
			run.io
		);
		expect(code).toBe(0);
		const printed = JSON.parse(run.stdout()) as {
			meta: { requestId: string | null; status: number };
		};
		expect(printed.meta.status).toBeGreaterThan(0);
		expect(printed.meta.requestId).toBe("req_sites");
	});

	test("deploy with a stale --expected-revision exits 1 with conflict", async () => {
		const { fetch } = stubFetch(sitesServer());
		const run = capture(fetch, SITES_ENV, { "./index.html": HTML });
		expect(
			await runCli(
				[
					"sites",
					"deploy",
					"./index.html",
					"--project",
					SITE_ID,
					"--expected-revision",
					"3",
				],
				run.io
			)
		).toBe(1);
		expect(run.stderr()).toContain("conflict");
	});

	test("deploy needs a file and --project, and a readable file", async () => {
		const { calls, fetch } = stubFetch(sitesServer());
		const noProject = capture(fetch, SITES_ENV, { "./index.html": HTML });
		expect(
			await runCli(["sites", "deploy", "./index.html"], noProject.io)
		).toBe(2);
		expect(noProject.stderr()).toContain("--project");
		const noFile = capture(fetch, SITES_ENV);
		expect(
			await runCli(["sites", "deploy", "--project", SITE_ID], noFile.io)
		).toBe(2);
		const missing = capture(fetch, SITES_ENV);
		expect(
			await runCli(
				["sites", "deploy", "./missing.html", "--project", SITE_ID],
				missing.io
			)
		).toBe(2);
		expect(missing.stderr()).toContain("Cannot read");
		expect(calls).toHaveLength(0);
	});

	test("settings changes only the named settings and prints the Site", async () => {
		const { calls, fetch } = stubFetch(sitesServer());
		const run = capture(fetch, SITES_ENV);
		expect(
			await runCli(
				[
					"sites",
					"settings",
					SITE_ID,
					"--audience",
					"invited",
					"--viewer",
					"ada@example.com",
					"--viewer",
					"lin@example.com",
					"--allow-remix",
					"on",
				],
				run.io
			)
		).toBe(0);
		expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
			`GET ${SITES}/api/sites/projects/${SITE_ID}`,
			`PUT ${SITES}/api/sites/projects/${SITE_ID}/settings`,
		]);
		expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({
			expectedRevision: 0,
			settings: {
				audience: "invited",
				viewers: ["ada@example.com", "lin@example.com"],
				workspaceId: null,
				allowRemix: true,
			},
		});
		expect(calls[1]?.headers.get("authorization")).toBe(`Bearer ${SITES_KEY}`);
		const printed = JSON.parse(run.stdout()) as {
			revision: number;
			settings: { audience: string };
		};
		expect(printed.revision).toBe(1);
		expect(printed.settings.audience).toBe("invited");
	});

	test("settings takes a slug, --no-workspace and --no-viewers", async () => {
		const { calls, fetch } = stubFetch(sitesServer());
		const run = capture(fetch, SITES_ENV);
		expect(
			await runCli(
				[
					"sites",
					"settings",
					"launch-notes",
					"--no-workspace",
					"--no-viewers",
					"--optional-sign-in",
					"off",
				],
				run.io
			)
		).toBe(0);
		const put = calls.find((call) => call.method === "PUT");
		expect(put?.url).toBe(`${SITES}/api/sites/projects/${SITE_ID}/settings`);
		expect(JSON.parse(put?.body ?? "{}").settings).toEqual({
			audience: "private",
			viewers: [],
			workspaceId: null,
			optionalSignIn: false,
		});
	});

	test("settings --workspace sends the id as given, even none", async () => {
		const { calls, fetch } = stubFetch(sitesServer());
		const run = capture(fetch, SITES_ENV);
		expect(
			await runCli(
				["sites", "settings", SITE_ID, "--workspace", "none"],
				run.io
			)
		).toBe(0);
		const put = calls.find((call) => call.method === "PUT");
		expect(JSON.parse(put?.body ?? "{}").settings.workspaceId).toBe("none");
	});

	test("settings with a stale --expected-revision exits 1 with conflict", async () => {
		const { fetch } = stubFetch(sitesServer());
		const run = capture(fetch, SITES_ENV);
		expect(
			await runCli(
				[
					"sites",
					"settings",
					SITE_ID,
					"--audience",
					"public",
					"--expected-revision",
					"3",
				],
				run.io
			)
		).toBe(1);
		expect(run.stderr()).toContain("conflict");
	});

	test("settings checks its flags before sending", async () => {
		const { calls, fetch } = stubFetch(sitesServer());
		for (const [argv, message] of [
			[["sites", "settings", SITE_ID], "Name at least one setting"],
			[["sites", "settings", "--audience", "public"], "<id> is required"],
			[
				["sites", "settings", SITE_ID, "--audience", "everyone"],
				"--audience must be one of private, invited, workspace, public",
			],
			[
				["sites", "settings", SITE_ID, "--allow-remix", "yes"],
				"--allow-remix must be on or off",
			],
			[
				[
					"sites",
					"settings",
					SITE_ID,
					"--viewer",
					"ada@example.com",
					"--no-viewers",
				],
				"not both",
			],
			[
				["sites", "settings", SITE_ID, "--workspace", ""],
				"--workspace needs a workspace id",
			],
			[
				["sites", "settings", SITE_ID, "--workspace", "  "],
				"--workspace needs a workspace id",
			],
			[
				["sites", "settings", SITE_ID, "--workspace", "ws_1", "--no-workspace"],
				"not both",
			],
		] as const) {
			const run = capture(fetch, SITES_ENV);
			expect(await runCli([...argv], run.io)).toBe(2);
			expect(run.stderr()).toContain(message);
		}
		expect(calls).toHaveLength(0);
	});

	test("deploy --dry-run prints the first request as curl and sends nothing", async () => {
		let sent = 0;
		const run = capture(
			() => {
				sent += 1;
				return Promise.reject(new Error("a dry run must not send requests"));
			},
			SITES_ENV,
			{ "./index.html": HTML }
		);
		expect(
			await runCli(
				["sites", "deploy", "./index.html", "--project", SITE_ID, "--dry-run"],
				run.io
			)
		).toBe(0);
		expect(sent).toBe(0);
		expect(run.stdout()).toContain(`${SITES}/api/sites/projects/${SITE_ID}`);
		expect(run.stdout()).toContain("$RYU_SITES_API_KEY");
		expect(run.stdout()).not.toContain(SITES_KEY);
	});
});

// --- MCP ---------------------------------------------------------------------------------

async function connect(
	fetch: RyuFetch,
	env: Record<string, string>,
	services: ("passport" | "sites")[],
	readOnly = false
) {
	const { server, registration } = createServicesMcpServer({
		config: { env, fetch },
		log: () => undefined,
		services,
		readOnly,
	});
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: "ryu-services-test", version: "1.0.0" });
	await client.connect(clientTransport);
	return { client, registration, close: () => client.close() };
}

describe("ryu-services mcp: passport tools", () => {
	test("registers the design's tools, all read-only, fetch open-world", async () => {
		const { fetch } = stubFetch(passportServer);
		const { client, close } = await connect(
			fetch,
			PASSPORT_ENV,
			["passport"],
			true
		);
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"passport_fetch",
			"passport_list_connections",
			"passport_list_profiles",
		]);
		const fetchTool = tools.find((tool) => tool.name === "passport_fetch");
		expect(fetchTool?.annotations?.openWorldHint).toBe(true);
		expect(fetchTool?.annotations?.readOnlyHint).toBe(true);
		await close();
	});

	test("without a runtime key the tools use the administration key", async () => {
		const { calls, fetch } = stubFetch(passportServer);
		const { client, close } = await connect(fetch, PASSPORT_ENV, ["passport"]);
		const listed = await client.callTool({
			name: "passport_list_connections",
			arguments: {},
		});
		expect(
			(listed.structuredContent as { data: { connections: unknown[] } }).data
				.connections
		).toHaveLength(1);
		const fetched = await client.callTool({
			name: "passport_fetch",
			arguments: {
				connectionId: "conn_1",
				url: "https://api.github.com/user",
				credentialHeaders: { Authorization: "Bearer vault:api.github.com" },
			},
		});
		expect(
			(fetched.structuredContent as { data: { content: string } }).data.content
		).toContain("octocat");
		// The tool bodies await the grant check first; meta still comes through.
		for (const result of [listed, fetched]) {
			expect(
				(result.structuredContent as { meta: { status: number } }).meta.status
			).toBe(200);
		}
		expect(
			calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)
		).toEqual(["GET /v1/connections", "POST /v1/connections/conn_1/fetch"]);
		expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({
			credentialHeaders: { Authorization: "Bearer vault:api.github.com" },
			method: "GET",
			url: "https://api.github.com/user",
		});
		for (const call of calls) {
			expect(call.headers.get("authorization")).toBe(`Bearer ${ADMIN}`);
		}
		await close();
	});

	test("with a runtime key the tools use the runtime grant", async () => {
		const { calls, fetch } = stubFetch(passportServer);
		const { client, close } = await connect(
			fetch,
			{ ...PASSPORT_ENV, RYU_PASSPORT_RUNTIME_KEY: RUNTIME },
			["passport"]
		);
		await client.callTool({ name: "passport_list_connections", arguments: {} });
		await client.callTool({
			name: "passport_fetch",
			arguments: { connectionId: "conn_1", url: "https://api.github.com/user" },
		});
		expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
			"/v1/runtime/connections",
			"/v1/connections/conn_1/fetch",
		]);
		for (const call of calls) {
			expect(call.headers.get("authorization")).toBe(`Bearer ${RUNTIME}`);
		}
		await close();
	});

	test("a runtime grant alone registers the passport tools", async () => {
		const { calls, fetch } = stubFetch(passportServer);
		const { client, close, registration } = await connect(
			fetch,
			{
				RYU_PASSPORT_RUNTIME_KEY: RUNTIME,
				RYU_PASSPORT_URL: PASSPORT,
			},
			["passport"]
		);
		expect(registration.services).toEqual(["passport"]);
		await client.callTool({ name: "passport_list_connections", arguments: {} });
		expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
			"/v1/runtime/connections",
		]);
		expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${RUNTIME}`);
		await close();
	});

	test("an error is a tool error carrying the RyuError code, never the key", async () => {
		const { fetch } = stubFetch(passportServer);
		const { client, close } = await connect(fetch, PASSPORT_ENV, ["passport"]);
		const failed = await client.callTool({
			name: "passport_fetch",
			arguments: {
				connectionId: "conn_missing",
				url: "https://api.github.com/",
			},
		});
		expect(failed.isError).toBe(true);
		const text = JSON.stringify(failed.structuredContent);
		expect(text).toContain("not_found");
		expect(text).not.toContain(ADMIN);
		await close();
	});
});

describe("ryu-services mcp: the read-only banner", () => {
	test("names --allow-writes only when read-only mode left a write tool out", async () => {
		const { fetch } = stubFetch(passportServer);
		const passport = await connect(fetch, PASSPORT_ENV, ["passport"], true);
		expect(passport.registration.withheld).toEqual([]);
		expect(mcpModeLine(passport.registration)).toBe(
			"ryu-services mcp: read-only mode, 3 tools registered."
		);
		await passport.close();
		const sites = await connect(fetch, SITES_ENV, ["sites"], true);
		expect(sites.registration.withheld.sort()).toEqual([
			"sites_create",
			"sites_deploy",
			"sites_update_settings",
		]);
		expect(mcpModeLine(sites.registration)).toContain("--allow-writes");
		await sites.close();
		const writes = await connect(fetch, SITES_ENV, ["sites"], false);
		expect(writes.registration.withheld).toEqual([]);
		await writes.close();
	});
});

describe("ryu-services mcp: sites tools", () => {
	test("sites_create makes a private Site and returns its id; a bad slug is invalid_arguments", async () => {
		const { calls, fetch } = stubFetch(sitesServer());
		const { client, close } = await connect(fetch, SITES_ENV, ["sites"]);
		const { tools } = await client.listTools();
		expect(
			tools.find((tool) => tool.name === "sites_create")?.annotations
		).toMatchObject({
			readOnlyHint: false,
			destructiveHint: false,
			openWorldHint: false,
		});
		const created = await client.callTool({
			name: "sites_create",
			arguments: {
				name: "Launch",
				slug: "launch-notes",
				description: "Release notes",
			},
		});
		expect(created.isError).toBeFalsy();
		expect(
			(created.structuredContent as { data: { id: string; revision: number } })
				.data
		).toMatchObject({ id: SITE_ID, revision: 0 });
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
			name: "Launch",
			prompt: "Release notes",
			slug: "launch-notes",
		});
		const bad = await client.callTool({
			name: "sites_create",
			arguments: { name: "Launch", slug: "Launch Notes" },
		});
		expect(bad.isError).toBe(true);
		expect(JSON.stringify(bad.structuredContent)).toContain(
			"invalid_arguments"
		);
		expect(calls).toHaveLength(1);
		await close();
	});

	test("sites_update_settings keeps other settings, needs expectedRevision and is a non-destructive write", async () => {
		const { calls, fetch } = stubFetch(sitesServer());
		const { client, close } = await connect(fetch, SITES_ENV, ["sites"]);
		const { tools } = await client.listTools();
		expect(
			tools.find((tool) => tool.name === "sites_update_settings")?.annotations
		).toMatchObject({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		});
		const updated = await client.callTool({
			name: "sites_update_settings",
			arguments: { siteId: SITE_ID, audience: "public", expectedRevision: 0 },
		});
		expect(updated.isError).toBeFalsy();
		expect(
			(updated.structuredContent as { data: { revision: number } }).data
				.revision
		).toBe(1);
		expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({
			expectedRevision: 0,
			settings: { audience: "public", viewers: [], workspaceId: null },
		});
		const missing = await client.callTool({
			name: "sites_update_settings",
			arguments: { siteId: SITE_ID, audience: "public" },
		});
		expect(missing.isError).toBe(true);
		expect(JSON.stringify(missing.structuredContent)).toContain(
			"invalid_arguments"
		);
		expect(calls).toHaveLength(2);
		await close();
	});

	test("sites_update_settings reports a 503 unavailable configuration refusal as not retryable, after one PUT", async () => {
		const server = sitesServer();
		const { calls, fetch } = stubFetch((request) =>
			request.method === "PUT"
				? Response.json(
						{
							error: {
								code: "unavailable",
								message:
									"Connect platform identity before enabling sharing or sign-in",
							},
						},
						{ status: 503 }
					)
				: server(request)
		);
		const { client, close } = await connect(fetch, SITES_ENV, ["sites"]);
		const refused = await client.callTool({
			name: "sites_update_settings",
			arguments: { siteId: SITE_ID, audience: "invited", expectedRevision: 0 },
		});
		expect(refused.isError).toBe(true);
		expect(refused.structuredContent).toMatchObject({
			error: { code: "unavailable", retryable: false, status: 503 },
		});
		expect(calls.map((call) => call.method)).toEqual(["GET", "PUT"]);
		await close();
	});

	test("registers sites_list, sites_get, sites_create, sites_deploy and sites_update_settings; read-only mode drops the writes", async () => {
		const { fetch } = stubFetch(sitesServer());
		const all = await connect(fetch, SITES_ENV, ["sites"]);
		const { tools } = await all.client.listTools();
		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"sites_create",
			"sites_deploy",
			"sites_get",
			"sites_list",
			"sites_update_settings",
		]);
		const deployTool = tools.find((tool) => tool.name === "sites_deploy");
		expect(deployTool?.annotations?.readOnlyHint).toBe(false);
		expect(deployTool?.annotations?.idempotentHint).toBe(false);
		await all.close();
		const readOnly = await connect(fetch, SITES_ENV, ["sites"], true);
		const listed = await readOnly.client.listTools();
		expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
			"sites_get",
			"sites_list",
		]);
		await readOnly.close();
	});

	test("sites_list all reads owned and shared; sites_deploy publishes html", async () => {
		const { calls, fetch } = stubFetch(sitesServer());
		const { client, close } = await connect(fetch, SITES_ENV, ["sites"]);
		const listed = await client.callTool({ name: "sites_list", arguments: {} });
		expect((listed.structuredContent as { data: unknown[] }).data).toHaveLength(
			2
		);
		expect(calls.map((call) => new URL(call.url).search).sort()).toEqual([
			"?scope=owned",
			"?scope=shared",
		]);
		const deployed = await client.callTool({
			name: "sites_deploy",
			arguments: {
				siteId: SITE_ID,
				html: HTML,
				message: "mcp",
				expectedRevision: 0,
			},
		});
		expect(deployed.isError).toBeFalsy();
		expect(
			calls.some((call) => call.url.endsWith(`/api/sites/projects/${SITE_ID}`))
		).toBe(false);
		expect(
			(deployed.structuredContent as { data: { url: string } }).data.url
		).toBe("http://launch-notes.localhost:8022/");
		const got = await client.callTool({
			name: "sites_get",
			arguments: { siteId: SITE_ID },
		});
		expect(
			(got.structuredContent as { data: { deploymentId: string } }).data
				.deploymentId
		).toBe("ver_1");
		await close();
	});

	test("sites_list for one scope carries the call's meta; sites_deploy is destructive", async () => {
		const server = sitesServer();
		const { fetch } = stubFetch((request) => {
			const response = server(request);
			response.headers.set("x-request-id", "req_list");
			return response;
		});
		const { client, close } = await connect(fetch, SITES_ENV, ["sites"]);
		const listed = await client.callTool({
			name: "sites_list",
			arguments: { scope: "owned" },
		});
		expect(listed.structuredContent).toMatchObject({
			meta: { requestId: "req_list", status: 200 },
		});
		const { tools } = await client.listTools();
		expect(
			tools.find((tool) => tool.name === "sites_deploy")?.annotations
				?.destructiveHint
		).toBe(true);
		await close();
	});

	test("sites_deploy with both or neither of html and versionId is a tool error", async () => {
		const { calls, fetch } = stubFetch(sitesServer());
		const { client, close } = await connect(fetch, SITES_ENV, ["sites"]);
		for (const args of [
			{ siteId: SITE_ID, expectedRevision: 0 },
			{ siteId: SITE_ID, html: HTML, versionId: "ver_1", expectedRevision: 0 },
		]) {
			const failed = await client.callTool({
				name: "sites_deploy",
				arguments: args,
			});
			expect(failed.isError).toBe(true);
			expect(failed.structuredContent).toMatchObject({
				error: { code: "invalid_arguments", retryable: false },
			});
		}
		expect(calls).toHaveLength(0);
		await close();
	});

	test("sites_deploy requires expectedRevision and never reads it for the agent", async () => {
		const { calls, fetch } = stubFetch(sitesServer());
		const { client, close } = await connect(fetch, SITES_ENV, ["sites"]);
		const { tools } = await client.listTools();
		const deployTool = tools.find((tool) => tool.name === "sites_deploy");
		expect(deployTool?.inputSchema.required).toContain("expectedRevision");
		const failed = await client.callTool({
			name: "sites_deploy",
			arguments: { siteId: SITE_ID, html: HTML },
		});
		expect(failed.isError).toBe(true);
		expect(calls).toHaveLength(0);
		await close();
	});

	test("sites_deploy with versionId deploys a saved version", async () => {
		const server = sitesServer();
		const { calls, fetch } = stubFetch(server);
		const { client, close } = await connect(fetch, SITES_ENV, ["sites"]);
		await client.callTool({
			name: "sites_deploy",
			arguments: { siteId: SITE_ID, html: HTML, expectedRevision: 0 },
		});
		calls.length = 0;
		const redeployed = await client.callTool({
			name: "sites_deploy",
			arguments: { siteId: SITE_ID, versionId: "ver_1", expectedRevision: 2 },
		});
		expect(redeployed.isError).toBeFalsy();
		expect(
			calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)
		).toEqual([
			"GET /api/sites/status",
			`POST /api/sites/projects/${SITE_ID}/deploy`,
		]);
		expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({
			expectedRevision: 2,
			versionId: "ver_1",
		});
		await close();
	});
});
