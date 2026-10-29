import { expect, test } from "bun:test";
import { pluginRecord } from "../src/lib/api/plugin-wire-values.ts";
import { parseProofJsonRecord } from "./fixture-json.ts";
import {
	parsePromptStudioFixtureState,
	suiteSaveFixtureSchema,
} from "./prompt-studio-fixture-contract.ts";

test("persisted Prompt Studio state retains future JSON configuration and own prototype keys", () => {
	const state = parsePromptStudioFixtureState(
		'{"suite":{"agent_id":"agent","config":{"future":{"__proto__":{"retained":true}},"tests":"future-shape"},"created_at":1,"id":"suite","name":"Suite","updated_at":2},"reviews":[],"runCounter":0}'
	);
	expect(pluginRecord(state.suite?.config)?.tests).toBe("future-shape");
	const future = pluginRecord(state.suite?.config)?.future;
	expect(
		Object.getOwnPropertyDescriptor(new Object(future), "__proto__")?.value
	).toEqual({ retained: true });
	expect(state.runCounter).toBe(0);
});
test("persisted Prompt Studio state supports missing legacy fields and rejects malformed consumed records", () => {
	expect(parsePromptStudioFixtureState("{}")).toEqual({});
	expect(() =>
		parsePromptStudioFixtureState('{"runCounter":"three"}')
	).toThrow();
	expect(() =>
		parsePromptStudioFixtureState('{"runs":[{"id":"run"}]}')
	).toThrow();
	expect(() =>
		parsePromptStudioFixtureState(
			'{"reviews":[["run:key",{"run_id":"run","result_key":"key","updated_at":1,"score":"wrong"}]]}'
		)
	).toThrow();
	expect(() =>
		parsePromptStudioFixtureState(
			'{"suiteVersions":[{"suite_id":"suite","id":"version","created_at":1,"config":null,"label":3}]}'
		)
	).toThrow();
});
test("fixture save boundary accepts opaque serialized configs and rejects invalid transport fields", () => {
	const input = {
		config: parseProofJsonRecord(
			'{"__proto__":{"future":true},"tests":"unsupported"}'
		),
		name: "Suite",
	};
	const saved = suiteSaveFixtureSchema.parse(input);
	expect(saved.config).toBe(input.config);
	expect(pluginRecord(saved.config)?.tests).toBe("unsupported");
	expect(() =>
		suiteSaveFixtureSchema.parse({ config: { bad: undefined } })
	).toThrow();
	expect(() => suiteSaveFixtureSchema.parse({ name: 3 })).toThrow();
	expect(suiteSaveFixtureSchema.parse({ label: null, name: null })).toEqual({
		label: null,
		name: null,
	});
});

test("stored transport payloads preserve scalar, array, and null configurations", () => {
	for (const config of [null, 3, "future", [false, "future"]]) {
		const suite = {
			agent_id: "agent",
			config,
			created_at: 1,
			id: "suite",
			name: "Suite",
			updated_at: 2,
		};
		expect(
			parsePromptStudioFixtureState(JSON.stringify({ suite })).suite?.config
		).toEqual(config);
		expect(suiteSaveFixtureSchema.parse({ config }).config).toEqual(config);
	}
});
