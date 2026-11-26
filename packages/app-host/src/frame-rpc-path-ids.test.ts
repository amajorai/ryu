// packages/app-host/src/frame-rpc-path-ids.test.ts
//
// The id keys a frame sends to the families whose host services build paths
// from them (quests, monitors, workflows, spaces, meetings, approvals,
// notifications). Two halves - every listed key refuses a path character before
// any service runs, and the list cannot fall behind `HostServices` in rpc.ts: a
// method that takes a key named `id`, or ending in `Id` or `_id`, must be in
// `FRAME_PATH_ID_KEYS` or in the short exempt list below with its reason.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	assertFramePathIds,
	dispatchFrameRpc,
	FRAME_PATH_ID_KEYS,
	isSafePathId,
} from "./frame-rpc.ts";
import {
	type Capability,
	CodedRpcError,
	type HostServices,
	METHOD_CAPABILITY,
} from "./rpc.ts";

const FAMILIES = [
	"quests",
	"monitors",
	"workflows",
	"spaces",
	"meetings",
	"approvals",
	"notifications",
] as const;
const ID_KEY = /^id$|Id$|_id$/;

/** Keys that hold an id but never become a path segment on any host. */
const EXEMPT_KEYS: ReadonlyMap<string, string> = new Map([
	[
		"workflows.bindConnectTrigger connectTriggerId",
		"the client takes only a UUID and sends it in a body (core-client composio-triggers.ts bindWorkflowConnectTrigger)",
	],
	[
		"workflows.removeConnectBinding bindingId",
		"sent only when it equals a binding id of Core's own list, then encodeURIComponent (composio-triggers.ts removeWorkflowConnectBinding)",
	],
	...[
		"spaces.createDatabase space_id",
		"spaces.createDoc space_id",
		"spaces.deleteDatabase database_id",
		"spaces.deleteDatabase space_id",
		"spaces.deleteDoc doc_id",
		"spaces.getDatabase database_id",
		"spaces.getDatabase space_id",
		"spaces.getDoc doc_id",
		"spaces.listDatabases space_id",
		"spaces.listDocs space_id",
		"spaces.queryDatabase database_id",
		"spaces.queryDatabase space_id",
		"spaces.search space_id",
		"spaces.updateDatabase database_id",
		"spaces.updateDatabase space_id",
		"spaces.updateDoc doc_id",
	].map((entry): [string, string] => [
		entry,
		"spaces calls go to Core's plugin bridge with the id in the body; desktop spaces.search uses its own encoding client",
	]),
	[
		"notifications.send target_user_id",
		"a user id in the body of the send request, not a path segment",
	],
]);

/** Methods whose argument is a type imported into rpc.ts, so its keys are not read here. */
const EXEMPT_METHODS: ReadonlyMap<string, string> = new Map([
	[
		"monitors.create",
		"MonitorInput from core-client, the body of POST /api/monitors; Core mints the id",
	],
	[
		"workflows.save",
		"WorkflowDefinitionInput from workflow-records.ts, the body of POST /workflows; Core checks the id",
	],
]);

interface FrameMethod {
	/** Top-level keys of the argument, or undefined when its type is not in rpc.ts. */
	keys: string[] | undefined;
	method: string;
}

const RPC_SOURCE = readFileSync(join(import.meta.dir, "rpc.ts"), "utf8");

/** The text between `start` and the next line that is only `}`. */
function blockAfter(start: string): string | undefined {
	const at = RPC_SOURCE.indexOf(start);
	if (at < 0) {
		return;
	}
	const end = RPC_SOURCE.indexOf("\n}\n", at);
	return RPC_SOURCE.slice(at + start.length, end);
}

function withoutComments(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Top-level keys of an object type body (nested object types folded away). */
function topLevelKeys(body: string): string[] {
	let flat = body;
	for (;;) {
		const folded = flat.replace(/\{[^{}]*\}/g, "0");
		if (folded === flat) {
			break;
		}
		flat = folded;
	}
	return [...flat.matchAll(/(?:^|[;,{\s])(\w+)\??\s*:/g)].map(
		(match) => match[1] ?? ""
	);
}

function argumentKeys(parameter: string): string[] | undefined {
	const type = parameter.replace(/^\s*\w+\??\s*:\s*/, "").trim();
	if (type === "") {
		return [];
	}
	if (type.startsWith("{")) {
		return topLevelKeys(type.slice(1, type.lastIndexOf("}")));
	}
	const named = /^(\w+)$/.exec(type)?.[1];
	const body = named && blockAfter(`export interface ${named} {`);
	return body === undefined || body === "" ? undefined : topLevelKeys(body);
}

/** Every frame method of the families as `HostServices` declares it. */
function declaredFrameMethods(): FrameMethod[] {
	const body = withoutComments(
		blockAfter("export interface HostServices {") ?? ""
	);
	const member = new RegExp(
		`^\\t(${FAMILIES.join("|")})([A-Z]\\w*)\\?\\(`,
		"gm"
	);
	const methods: FrameMethod[] = [];
	for (const match of body.matchAll(member)) {
		const open = (match.index ?? 0) + match[0].length;
		let depth = 1;
		let close = open;
		while (depth > 0 && close < body.length) {
			const character = body[close];
			depth += character === "(" ? 1 : character === ")" ? -1 : 0;
			close += 1;
		}
		const rest = match[2] ?? "";
		methods.push({
			method: `${match[1]}.${rest.charAt(0).toLowerCase()}${rest.slice(1)}`,
			keys: argumentKeys(body.slice(open, close - 1)),
		});
	}
	return methods;
}

function caseLabels(): Set<string> {
	const label = new RegExp(`case "((?:${FAMILIES.join("|")})\\.\\w+)"`, "g");
	return new Set(
		[...RPC_SOURCE.matchAll(label)].map((match) => match[1] ?? "")
	);
}

describe("the frame id table follows HostServices", () => {
	const declared = declaredFrameMethods();

	test("reads every frame method of the families that dispatchRpc answers", () => {
		expect(new Set(declared.map(({ method }) => method))).toEqual(caseLabels());
		expect(declared.length).toBeGreaterThan(70);
	});

	test("every id key is checked or exempt with a reason", () => {
		const unlisted: string[] = [];
		for (const { method, keys } of declared) {
			if (keys === undefined) {
				if (!EXEMPT_METHODS.has(method)) {
					unlisted.push(`${method} (argument type not readable here)`);
				}
				continue;
			}
			for (const key of keys.filter((name) => ID_KEY.test(name))) {
				const checked = FRAME_PATH_ID_KEYS.get(method)?.includes(key);
				if (!(checked || EXEMPT_KEYS.has(`${method} ${key}`))) {
					unlisted.push(`${method} ${key}`);
				}
			}
		}
		expect(unlisted).toEqual([]);
	});

	test("the table and the exempt lists name only keys that exist", () => {
		const keysOf = new Map(declared.map(({ method, keys }) => [method, keys]));
		const stale: string[] = [];
		for (const [method, keys] of FRAME_PATH_ID_KEYS) {
			for (const key of keys) {
				if (!keysOf.get(method)?.includes(key)) {
					stale.push(`${method} ${key}`);
				}
			}
		}
		for (const entry of EXEMPT_KEYS.keys()) {
			const [method = "", key = ""] = entry.split(" ");
			if (!keysOf.get(method)?.includes(key)) {
				stale.push(entry);
			}
		}
		for (const method of EXEMPT_METHODS.keys()) {
			if (!keysOf.has(method) || keysOf.get(method) !== undefined) {
				stale.push(method);
			}
		}
		expect(stale).toEqual([]);
	});
});

const PLAIN_ID = "plain_0123abcd-EF";
const HOSTILE_IDS = ["a/b", "a\\b", "a?b", "a#b", "a%2Fb", "..", ".\t.", "a b"];

/** Fields a method needs besides its ids for dispatchRpc to reach the service. */
const OTHER_FIELDS: Readonly<Record<string, Record<string, unknown>>> = {
	"meetings.rename": { title: "t" },
	"meetings.setIcon": { icon: null },
	"monitors.update": {
		input: {
			backend: "http",
			check: { type: "uptime" },
			enabled: true,
			interval: "5m",
			name: "n",
			notify: [],
			url: "https://example.test",
		},
	},
	"workflows.bindConnectTrigger": {
		connectTriggerId: "0f8fad5b-d9cb-469f-a165-70867728950e",
	},
	"workflows.removeConnectBinding": { bindingId: "binding_1" },
	"workflows.resume": { payload: "{}" },
	"quests.update": { input: { title: "t", completion_condition: "c" } },
};

function serviceName(method: string): string {
	const [family = "", rest = ""] = method.split(".");
	return `${family}${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
}

/** Services that record which one ran and return nothing. */
function recordingServices(calls: string[]): HostServices {
	const services: object = new Proxy(
		{},
		{
			get: (_target, name) =>
				typeof name === "string"
					? () => {
							calls.push(name);
						}
					: undefined,
		}
	);
	return services as HostServices;
}

async function outcome(method: string, arg: Record<string, unknown>) {
	const calls: string[] = [];
	const capability = METHOD_CAPABILITY[method];
	const granted = new Set<Capability>(capability ? [capability] : []);
	const error = await dispatchFrameRpc(
		method,
		[arg],
		granted,
		recordingServices(calls)
	).then(
		() => undefined,
		(cause: unknown) => cause
	);
	return { calls, error };
}

function argFor(method: string, keys: readonly string[]) {
	return {
		...OTHER_FIELDS[method],
		...Object.fromEntries(keys.map((key) => [key, PLAIN_ID])),
	};
}

describe("frame ids of the families", () => {
	// meetings.setIcon has a case in dispatchRpc but no grant row, so a frame
	// gets "Unknown method" today; its ids are checked once a row is added.
	const ungranted = [...FRAME_PATH_ID_KEYS.keys()].filter(
		(method) => METHOD_CAPABILITY[method] === undefined
	);

	test("only meetings.setIcon is listed without a grant row", () => {
		expect(ungranted).toEqual(["meetings.setIcon"]);
		for (const id of HOSTILE_IDS) {
			expect(() =>
				assertFramePathIds("meetings.setIcon", [{ id, icon: null }])
			).toThrow(CodedRpcError);
		}
	});

	for (const [method, keys] of FRAME_PATH_ID_KEYS) {
		if (ungranted.includes(method)) {
			continue;
		}
		for (const key of keys) {
			for (const id of HOSTILE_IDS) {
				test(`${method} refuses ${key} ${JSON.stringify(id)} before any service`, async () => {
					const { calls, error } = await outcome(method, {
						...argFor(method, keys),
						[key]: id,
					});
					expect(error).toBeInstanceOf(CodedRpcError);
					expect(error).toMatchObject({ code: "invalid_args" });
					expect(calls).toEqual([]);
				});
			}
		}

		test(`${method} passes plain ids on to ${serviceName(method)}`, async () => {
			const { calls } = await outcome(method, argFor(method, keys));
			expect(calls).toContain(serviceName(method));
		});
	}

	test("a key outside the table is not judged here", () => {
		expect(() =>
			assertFramePathIds("workflows.removeConnectBinding", [
				{ id: PLAIN_ID, bindingId: "a/b" },
			])
		).not.toThrow();
		expect(() =>
			assertFramePathIds("monitors.update", [
				{ id: PLAIN_ID, input: { name: "a/b" } },
			])
		).not.toThrow();
	});

	test("the ids Core and the apps mint pass the check", () => {
		for (const id of [
			"quest_0123456789abcdef0123456789abcdef",
			"mon_0123456789abcdef0123456789abcdef",
			"appr_0123456789abcdef0123456789abcdef",
			"ntf_0123456789abcdef0123456789abcdef",
			"ntf_connect_0123456789abcdef",
			"mtg_0123456789abcdef0123456789abcdef",
			"rcp_0123456789abcdef0123456789abcdef",
			"run_0123456789abcdef",
			"dryrun_0123456789abcdef",
			"daily-digest_2",
			"prompt-chaining",
			"0f8fad5b-d9cb-469f-a165-70867728950e",
		]) {
			expect(isSafePathId(id)).toBe(true);
		}
	});
});
