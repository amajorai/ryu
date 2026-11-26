// Wire tests for the login import clients. Every value here is made up.

import { afterEach, expect, test } from "bun:test";
import { ApiError } from "./client.ts";
import { applyLoginImport, previewLoginImport } from "./vault-login-import.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) {
		server.stop(true);
	}
});

function node(reply: unknown, status = 200) {
	const seen: { body: unknown; route: string }[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			seen.push({
				body: await request.json(),
				route: `${request.method} ${url.pathname}`,
			});
			return Response.json(reply, { status });
		},
	});
	servers.push(server);
	return {
		seen,
		target: {
			token: "import-node-token",
			url: `http://127.0.0.1:${server.port}`,
			userJwt: null,
		},
	};
}

const CSV =
	"name,url,username,password\nExample,https://example.com,ada,made-up-wire-1\n";

const PREVIEW = {
	counts: { duplicate: 1, invalid: 0, new: 0, repeated: 0, total: 1 },
	environment: "prod",
	format: "chrome" as const,
	path: "/web",
	rows: [
		{
			existing: { id: "itm_1", key: "example", version: 3 },
			hasNotes: false,
			hasTotp: false,
			host: "example.com",
			row: 2,
			site: "https://example.com/",
			status: "duplicate" as const,
			title: "Example",
			totpDropped: false,
			username: "ada",
		},
	],
};

test("a preview posts the file and its folder and returns the plan", async () => {
	const core = node({ preview: PREVIEW });
	expect(
		await previewLoginImport(core.target, CSV, {
			environment: "prod",
			path: "/web",
		})
	).toEqual(PREVIEW);
	expect(core.seen).toEqual([
		{
			body: { csv: CSV, environment: "prod", path: "/web" },
			route: "POST /api/vault/login-imports/preview",
		},
	]);
});

test("an import posts the chosen records and the replacements by id and version", async () => {
	const result = {
		created: 0,
		replaced: 1,
		rows: [{ key: "example", outcome: "replaced" as const, row: 2 }],
		skipped: 0,
	};
	const core = node({ result });
	expect(
		await applyLoginImport(core.target, {
			csv: CSV,
			environment: "prod",
			replace: [{ expectedId: "itm_1", expectedVersion: 3, row: 2 }],
			rows: [],
		})
	).toEqual(result);
	expect(core.seen).toEqual([
		{
			body: {
				csv: CSV,
				environment: "prod",
				replace: [{ expectedId: "itm_1", expectedVersion: 3, row: 2 }],
				rows: [],
			},
			route: "POST /api/vault/login-imports",
		},
	]);
});

test("a reply that is not a plan is refused", async () => {
	const core = node({ preview: { ...PREVIEW, format: "made-up-format" } });
	await expect(previewLoginImport(core.target, CSV)).rejects.toThrow();
});

test("a refused file surfaces Core's code", async () => {
	const core = node(
		{
			error:
				"vault_invalid_request: login_import_unknown_format: the first row is not the header of a Chrome, Firefox, Safari, Bitwarden or 1Password password export",
		},
		400
	);
	const refusal = await previewLoginImport(core.target, "x,y\n1,2\n").catch(
		(error: unknown) => error
	);
	expect(refusal).toBeInstanceOf(ApiError);
	expect((refusal as ApiError).status).toBe(400);
	expect((refusal as ApiError).serverMessage).toContain(
		"login_import_unknown_format"
	);
});
