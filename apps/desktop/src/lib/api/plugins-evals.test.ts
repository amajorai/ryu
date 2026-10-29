import { expect, test } from "bun:test";
import { createFetchFixture } from "../../test-fixtures/native-fetch-fixture.ts";
import { fetchPluginEvals, runPluginEvals } from "./plugins.ts";

const target = { token: "node-token", url: "http://127.0.0.1:7980" };

test("fetchPluginEvals reads one installed package suite", async () => {
	const originalFetch = globalThis.fetch;
	let requestUrl = "";
	globalThis.fetch = createFetchFixture(originalFetch, async (input) => {
		requestUrl = String(input);
		return new Response(
			JSON.stringify({
				artifactKind: "app",
				pluginId: "com.example/mail",
				suite: {
					caseCount: 1,
					cases: [],
					directory: "evals",
					graderCount: 1,
					issues: [],
					rulesetVersion: "ryu-plugin-evals-1",
					schemaVersion: "1",
					status: "ready",
					supportedGraders: ["regex"],
					unsupportedGraders: [],
				},
			}),
			{ headers: { "content-type": "application/json" }, status: 200 }
		);
	});

	try {
		const overview = await fetchPluginEvals(target, "com.example/mail");
		expect("suite" in overview && overview.suite.status).toBe("ready");
	} finally {
		globalThis.fetch = originalFetch;
	}

	expect(requestUrl).toBe(
		"http://127.0.0.1:7980/api/plugins/evals?id=com.example%2Fmail"
	);
});

test("runPluginEvals posts the selected installed artifact", async () => {
	const originalFetch = globalThis.fetch;
	let requestUrl = "";
	let requestInit: RequestInit | undefined;
	globalThis.fetch = createFetchFixture(originalFetch, async (input, init) => {
		requestUrl = String(input);
		requestInit = init;
		return new Response(
			JSON.stringify({
				artifactKind: "plugin",
				baseline: { reason: "not run", status: "not_run" },
				cases: [],
				evidenceLevel: "plugin-agent",
				pluginId: "com.example/mail",
				runId: "plugin_eval_1",
				score: 1,
				schemaVersion: "1",
				status: "passed",
				suite: {
					caseCount: 1,
					cases: [],
					directory: "evals",
					graderCount: 1,
					issues: [],
					rulesetVersion: "ryu-plugin-evals-1",
					schemaVersion: "1",
					status: "ready",
					supportedGraders: ["regex"],
					unsupportedGraders: [],
				},
			}),
			{ headers: { "content-type": "application/json" }, status: 200 }
		);
	});

	try {
		const result = await runPluginEvals(target, {
			case: "smoke",
			id: "com.example/mail",
			runs: 1,
			threshold: 0.8,
		});
		expect(result.status).toBe("passed");
	} finally {
		globalThis.fetch = originalFetch;
	}

	expect(requestUrl).toBe("http://127.0.0.1:7980/api/plugins/evals/run");
	expect(requestInit?.method).toBe("POST");
	expect(JSON.parse(String(requestInit?.body))).toEqual({
		case: "smoke",
		id: "com.example/mail",
		runs: 1,
		threshold: 0.8,
	});
});
