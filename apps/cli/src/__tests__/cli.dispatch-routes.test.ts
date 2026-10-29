// Route-level dispatch tests for the raw Core commands (`stack`, `okf`,
// `open`/`link`), the catalog lifecycle commands (`models`, `skills`, `apps`,
// `mcp`), `action` failure/validation paths, and `mail` resource routing.
// Core is an injected CoreApi; every call is captured so a wrong route, method,
// or body fails the test, and usage errors must make no call at all.

import { expect, test } from "bun:test";
import { runCli } from "../cli/dispatch.ts";
import type { CliIO, CoreApi } from "../cli/types.ts";

type CoreCall = NonNullable<CoreApi["call"]>;
type CallOptions = NonNullable<Parameters<CoreCall>[2]>;
interface CapturedCall {
	body?: CallOptions["body"];
	method?: CallOptions["method"];
	path: Parameters<CoreCall>[1];
}
type CallAction = NonNullable<CoreApi["callAction"]>;

function makeIo() {
	let outBuf = "";
	let errBuf = "";
	return {
		io: {
			out: (s) => {
				outBuf += s;
			},
			err: (s) => {
				errBuf += s;
			},
		} satisfies CliIO,
		out: () => outBuf,
		err: () => errBuf,
	};
}

function stubApi(overrides: Partial<CoreApi> = {}): CoreApi {
	const notCalled = () => Promise.reject(new Error("unexpected CoreApi call"));
	return {
		fetchApps: notCalled,
		fetchAppsCatalog: notCalled,
		installApp: notCalled,
		enableApp: notCalled,
		disableApp: notCalled,
		uninstallApp: notCalled,
		execAppCommand: notCalled,
		streamChat: notCalled,
		...overrides,
	};
}

/** Run argv against a recording Core that answers every call with `reply`. */
async function runRecorded(
	argv: string[],
	reply: Awaited<ReturnType<CoreCall>> = { ok: true },
	overrides: Partial<CoreApi> = {}
) {
	const calls: CapturedCall[] = [];
	const cap = makeIo();
	const code = await runCli(argv, {
		io: cap.io,
		api: stubApi({
			call: (_target, path, options) => {
				calls.push({ body: options?.body, method: options?.method, path });
				return Promise.resolve(reply);
			},
			...overrides,
		}),
	});
	return { calls, code, err: cap.err(), out: cap.out() };
}

// ── stack / okf / open ───────────────────────────────────────────────────────

test("stack export GETs the fleet stack export route and prints its JSON", async () => {
	const template = { apiVersion: "ryu.dev/stack-template/v1", items: [] };
	const run = await runRecorded(["stack", "export", "--json"], template);
	expect(run.code).toBe(0);
	expect(run.calls).toEqual([
		{ body: undefined, method: "GET", path: "/api/fleet/stack/export" },
	]);
	expect(JSON.parse(run.out)).toEqual(template);
});

test("stack import is a usage error and never performs a silent export", async () => {
	for (const argv of [
		["stack", "import", "stack.json"],
		["stack", "export", "extra"],
		["stack", "frob"],
	]) {
		const run = await runRecorded(argv);
		expect(run.code).toBe(2);
		expect(run.err).toContain("Usage: ryu-cli stack export");
		expect(run.calls).toEqual([]);
	}
});

test("okf export POSTs its argv as {args} to the OKF export route", async () => {
	const run = await runRecorded(["okf", "export", "/tmp/bundle"]);
	expect(run.code).toBe(0);
	expect(run.calls).toEqual([
		{
			body: { args: ["export", "/tmp/bundle"] },
			method: "POST",
			path: "/api/okf/export",
		},
	]);
});

test("open and its link alias POST the page argv to the deep-link route", async () => {
	for (const verb of ["open", "link"]) {
		const run = await runRecorded([verb, "settings/privacy"]);
		expect(run.code).toBe(0);
		expect(run.calls).toEqual([
			{
				body: { args: ["settings/privacy"] },
				method: "POST",
				path: "/api/deep-link",
			},
		]);
	}
});

// ── catalog lifecycle ────────────────────────────────────────────────────────

test("models add installs a GGUF catalog model and prints the installed id", async () => {
	const run = await runRecorded(["models", "add", "qwen"]);
	expect(run.code).toBe(0);
	expect(run.calls).toEqual([
		{
			body: { id: "qwen", format: "gguf" },
			method: "POST",
			path: "/api/models/catalog/install",
		},
	]);
	expect(run.out).toBe("Installed qwen.\n");
});

test("apps install encodes the id into the plugin install route; --json prints Core's reply", async () => {
	const reply = { ok: true, installed: "a/b" };
	const run = await runRecorded(["apps", "install", "a/b", "--json"], reply);
	expect(run.code).toBe(0);
	expect(run.calls).toEqual([
		{ body: { id: "a/b" }, method: "POST", path: "/api/plugins/a%2Fb/install" },
	]);
	expect(JSON.parse(run.out)).toEqual(reply);
});

test("skills add and mcp add post only the id to their catalog install routes", async () => {
	const skills = await runRecorded(["skills", "add", "pdf"]);
	const mcp = await runRecorded(["mcp", "install", "github"]);
	expect(skills.calls).toEqual([
		{
			body: { id: "pdf" },
			method: "POST",
			path: "/api/skills/catalog/install",
		},
	]);
	expect(mcp.calls).toEqual([
		{
			body: { id: "github" },
			method: "POST",
			path: "/api/mcp/catalog/install",
		},
	]);
});

test("mcp with no subcommand lists the MCP catalog", async () => {
	const run = await runRecorded(["mcp"], { servers: [] });
	expect(run.code).toBe(0);
	expect(run.calls).toEqual([
		{ body: undefined, method: "GET", path: "/api/mcp/catalog" },
	]);
	expect(JSON.parse(run.out)).toEqual({ servers: [] });
});

test("catalog commands reject a missing id or unknown subcommand without calling Core", async () => {
	for (const argv of [
		["skills", "add"],
		["skills", "frob"],
	]) {
		const run = await runRecorded(argv);
		expect(run.code).toBe(2);
		expect(run.err).toContain("Usage: ryu-cli skills <list|add> [id]");
		expect(run.calls).toEqual([]);
	}
});

// ── action ───────────────────────────────────────────────────────────────────

test("a denied action exits 1 and names the failure, also under --json", async () => {
	const denied = { ok: false, error: "denied" };
	const human = await runRecorded(
		["action", "app.x/run", "{}", "--agent", "a1"],
		denied
	);
	expect(human.code).toBe(1);
	expect(human.out).toBe("Action app.x/run failed: denied\n");
	const json = await runRecorded(
		["action", "app.x/run", "{}", "--agent", "a1", "--json"],
		denied
	);
	expect(json.code).toBe(1);
	expect(JSON.parse(json.out)).toEqual(denied);
});

test("non-JSON action arguments are a usage error with no Core call", async () => {
	const run = await runRecorded([
		"action",
		"app.x/run",
		"{oops",
		"--agent",
		"a1",
	]);
	expect(run.code).toBe(2);
	expect(run.err).toContain("Action arguments must be valid JSON.");
	expect(run.calls).toEqual([]);
});

test("omitted action arguments default to an empty object", async () => {
	const run = await runRecorded(["action", "app.x/run", "--agent", "a1"]);
	expect(run.code).toBe(0);
	expect(run.calls).toEqual([
		{
			body: { agent_id: "a1", arguments: {} },
			method: "POST",
			path: "/api/actions/app.x%2Frun",
		},
	]);
	expect(run.out).toBe("Action app.x/run completed.\n");
});

test("the typed callAction client is preferred over the raw POST", async () => {
	const seen: Parameters<CallAction>[] = [];
	const run = await runRecorded(
		["action", "app.x/run", '{"n":1}', "--agent", "a1"],
		{ ok: true },
		{
			callAction: (target, actionId, input) => {
				seen.push([target, actionId, input]);
				return Promise.resolve({ ok: true });
			},
		}
	);
	expect(run.code).toBe(0);
	expect(run.calls).toEqual([]);
	expect(seen.map(([, id, input]) => [id, input])).toEqual([
		["app.x/run", { agentId: "a1", arguments: { n: 1 } }],
	]);
});

// ── mail ─────────────────────────────────────────────────────────────────────

test("mail create-* POST the parsed JSON body to their resource routes", async () => {
	const routes = {
		"create-inbox": "/api/mail/inboxes",
		"create-webhook": "/api/mail/webhooks",
		"create-pod": "/api/mail/pods",
		"create-domain": "/api/mail/domains",
	};
	for (const [verb, path] of Object.entries(routes)) {
		const run = await runRecorded(["mail", verb, '{"name":"n1"}']);
		expect(run.code).toBe(0);
		expect(run.calls).toEqual([{ body: { name: "n1" }, method: "POST", path }]);
	}
});

test("mail events lists all events or one inbox's encoded events", async () => {
	const all = await runRecorded(["mail", "events"]);
	const one = await runRecorded(["mail", "events", "in/1"]);
	expect(all.calls).toEqual([
		{ body: undefined, method: "GET", path: "/api/mail/events" },
	]);
	expect(one.calls).toEqual([
		{ body: undefined, method: "GET", path: "/api/mail/inboxes/in%2F1/events" },
	]);
});

test("bare mail lists inboxes; inbox-scoped reads use the encoded inbox id", async () => {
	const bare = await runRecorded(["mail"]);
	const threads = await runRecorded(["mail", "threads", "in/1"]);
	expect(bare.calls).toEqual([
		{ body: undefined, method: "GET", path: "/api/mail/inboxes" },
	]);
	expect(threads.calls).toEqual([
		{
			body: undefined,
			method: "GET",
			path: "/api/mail/inboxes/in%2F1/threads",
		},
	]);
});

test("mail rejects a missing inbox id or invalid JSON body without calling Core", async () => {
	for (const argv of [
		["mail", "threads"],
		["mail", "create-inbox", "notjson"],
		["mail", "frob"],
	]) {
		const run = await runRecorded(argv);
		expect(run.code).toBe(2);
		expect(run.err).toContain("ryu-cli mail <status|inboxes|");
		expect(run.calls).toEqual([]);
	}
});
