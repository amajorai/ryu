import { afterEach, expect, test } from "bun:test";
import { type PluginValue, pluginValueSchema } from "./plugin-wire-values.ts";
import {
	promptRunWireSchema,
	promptSuiteWireSchema,
} from "./prompt-suite-wire-contracts.ts";
import {
	createPromptSuite,
	duplicatePromptRun,
	getPromptRun,
	getPromptSuite,
	getPromptSuiteVersion,
	importPromptTrace,
	listPromptSuiteVersions,
	savePromptReview,
	savePromptRun,
	updatePromptSuite,
} from "./prompt-suites.ts";

const originalFetch = globalThis.fetch;
const target = { token: null, url: "https://prompt.test" };
const suite = {
	agent_id: "agent",
	config: { future: { tests: "malformed DSL" } },
	created_at: 1,
	id: "suite/1",
	name: "Suite",
	updated_at: 2,
};
const version = { created_at: 3, id: "v", label: null, suite_id: suite.id };
const run = { created_at: 4, id: "r", name: "Run", suite_id: suite.id };
afterEach(() => {
	globalThis.fetch = originalFetch;
});
function respond(body: PluginValue) {
	globalThis.fetch = Object.assign(
		async () => Response.json(pluginValueSchema.parse(body)),
		{ preconnect: originalFetch.preconnect }
	);
}

test("complete Core records preserve arbitrary JSON configuration and identity", async () => {
	const config = JSON.parse(
		'{"__proto__":{"future":true},"tests":"malformed DSL"}'
	);
	const raw = { ...suite, config, additive: { future: true } };
	expect(promptSuiteWireSchema.parse(raw)).toBe(raw);
	expect(promptSuiteWireSchema.parse(raw).config).toBe(config);
	for (const value of [null, false, "legacy", [], { future: [null] }]) {
		respond({ suite: { ...suite, config: value } });
		expect((await getPromptSuite(target, suite.id)).config).toEqual(value);
	}
	respond({
		suite: {
			agent_id: "agent",
			config: {},
			id: "suite",
			name: "missing timestamps",
		},
	});
	await expect(getPromptSuite(target, suite.id)).rejects.toThrow();
});

test("suite drafts preserve native YAML serialization and label omission", async () => {
	const bodies: string[] = [];
	globalThis.fetch = Object.assign(
		async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
			bodies.push(String(init?.body));
			return Response.json({ suite, version });
		},
		{ preconnect: originalFetch.preconnect }
	);
	const created = await createPromptSuite(target, {
		agentId: "agent",
		name: "Suite",
		label: " reviewed ",
		config: {
			optional: undefined,
			scalars: [Number.NaN, Number.POSITIVE_INFINITY],
			future: true,
		},
	});
	await updatePromptSuite(target, suite.id, {
		name: "Suite",
		config: ["future"],
		label: " ",
	});
	expect(bodies).toEqual([
		'{"agent_id":"agent","config":{"scalars":[null,null],"future":true},"label":"reviewed","name":"Suite"}',
		'{"config":["future"],"name":"Suite"}',
	]);
	expect(created.version).toEqual({
		config: {},
		createdAt: 3,
		id: "v",
		label: null,
		suiteId: suite.id,
	});
});

test("version metadata omits captured config while version reads retain legacy JSON", async () => {
	respond({ versions: [{ ...version, config: ["legacy"] }] });
	expect(await listPromptSuiteVersions(target, suite.id)).toEqual([
		{ createdAt: 3, id: "v", label: null, suiteId: suite.id },
	]);
	respond({ version: { ...version, config: null } });
	expect((await getPromptSuiteVersion(target, suite.id, "v")).config).toEqual(
		{}
	);
	respond({ version: { ...version, config: ["legacy"] } });
	expect((await getPromptSuiteVersion(target, suite.id, "v")).config).toEqual([
		"legacy",
	]);
});

test("run requests retain future outer fields and replies retain all Core JSON values", async () => {
	let body: RequestInit["body"];
	globalThis.fetch = Object.assign(
		async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
			body = init?.body;
			return Response.json({ run });
		},
		{ preconnect: originalFetch.preconnect }
	);
	await savePromptRun(target, suite.id, {
		name: "Run",
		request: { optional: undefined, model: "future" },
		result: [true, null],
		future: { field: 1 },
	});
	expect(body).toBe(
		'{"name":"Run","request":{"model":"future"},"result":[true,null],"future":{"field":1}}'
	);
	const raw = {
		...run,
		request: null,
		result: ["future"],
		metadata: { retained: true },
	};
	expect(promptRunWireSchema.parse(raw)).toBe(raw);
	respond({ run: raw });
	expect(await getPromptRun(target, suite.id, "r")).toEqual({
		createdAt: 4,
		id: "r",
		name: "Run",
		suiteId: suite.id,
		request: null,
		result: ["future"],
	});
});

test("review and duplicate bodies retain absent, empty and explicit-null behavior", async () => {
	const bodies: RequestInit["body"][] = [];
	globalThis.fetch = Object.assign(
		async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
			bodies.push(init?.body);
			return Response.json({
				review: { result_key: "key", run_id: "r", updated_at: 5 },
				run,
			});
		},
		{ preconnect: originalFetch.preconnect }
	);
	expect(
		await savePromptReview(target, suite.id, "r", {
			resultKey: "key",
			comment: "",
		})
	).toEqual({
		comment: null,
		highlighted: false,
		pass: null,
		resultKey: "key",
		runId: "r",
		score: null,
		updatedAt: 5,
	});
	await duplicatePromptRun(target, suite.id, "r", " ");
	await duplicatePromptRun(target, suite.id, "r", " Copy ");
	expect(bodies).toEqual([
		'{"comment":"","highlighted":false,"pass":null,"result_key":"key","score":null}',
		undefined,
		'{"name":"Copy"}',
	]);
});

test("trace imports preserve full suite normalization and future case values", async () => {
	respond({
		added: true,
		case: { future: [1, null] },
		source_run_id: "trace",
		suite,
		version: null,
	});
	expect(await importPromptTrace(target, suite.id, "trace")).toEqual({
		added: true,
		case: { future: [1, null] },
		sourceRunId: "trace",
		suite: {
			agentId: "agent",
			config: suite.config,
			createdAt: 1,
			id: suite.id,
			name: "Suite",
			updatedAt: 2,
		},
		version: null,
	});
});
