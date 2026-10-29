import { describe, expect, it } from "bun:test";
import {
	normalizeNodeUrl,
	parseActionInputs,
	resolveTarget,
	validateOperationInputs,
} from "./input.ts";

function reader(values: Record<string, string>) {
	return { get: (name: string) => values[name] ?? "" };
}

describe("GitHub Action input parsing", () => {
	it("parses JSON options and applies safe defaults", () => {
		const inputs = parseActionInputs(
			reader({
				inference: '{"temperature":0.2}',
				"plugin-flags": '{"com.ryu.search":true}',
				"tool-arguments": '{"query":"ryu"}',
			})
		);

		expect(inputs.operation).toBe("setup");
		expect(inputs.target).toBe("auto");
		expect(inputs.persist).toBe(false);
		expect(inputs.enableLongTerm).toBe(false);
		expect(inputs.inference).toEqual({ temperature: 0.2 });
		expect(inputs.pluginFlags).toEqual({ "com.ryu.search": true });
		expect(inputs.toolArguments).toEqual({ query: "ryu" });
	});

	it("rejects malformed and unsafe inputs", () => {
		expect(() => parseActionInputs(reader({ inference: "[]" }))).toThrow(
			"Input 'inference' must contain a JSON object."
		);
		expect(() => parseActionInputs(reader({ persist: "maybe" }))).toThrow(
			"Input 'persist' must be true or false."
		);
		expect(() => normalizeNodeUrl("ftp://ryu.example")).toThrow(
			"Ryu node URL must use http or https."
		);
		expect(() => normalizeNodeUrl("https://user:pass@ryu.example")).toThrow(
			"must not include credentials"
		);
		expect(() => normalizeNodeUrl("https://ryu.example/?token=secret")).toThrow(
			"must not include credentials"
		);
		expect(normalizeNodeUrl("https://ryu.example///")).toBe(
			"https://ryu.example"
		);
	});

	it("accepts plain http only for a literal loopback node", () => {
		for (const remote of [
			"http://ryu.example",
			"http://10.0.0.5:7980",
			"http://localhost:7980",
			"http://127.0.0.1.nip.io:7980",
			"http://[fe80::1]:7980",
		]) {
			expect(() => normalizeNodeUrl(remote)).toThrow("must use https");
		}
		expect(normalizeNodeUrl("http://127.0.0.1:7980/")).toBe(
			"http://127.0.0.1:7980"
		);
		expect(normalizeNodeUrl("http://127.1.2.3:7980")).toBe(
			"http://127.1.2.3:7980"
		);
		expect(normalizeNodeUrl("http://[::1]:7980")).toBe("http://[::1]:7980");
	});

	it("resolves explicit and environment targets with predictable precedence", () => {
		const environment = {
			RYU_CORE_TOKEN: "core-token",
			RYU_CORE_URL: "https://core.example/",
			RYU_MANAGED_NODE_TOKEN: "managed-env-token",
			RYU_MANAGED_NODE_URL: "https://managed-env.example/",
		};

		expect(
			resolveTarget(
				{
					managedNodeToken: "managed-input-token",
					managedNodeUrl: "https://managed-input.example/",
					nodeToken: "node-input-token",
					nodeUrl: "https://node-input.example///",
					target: "auto",
				},
				environment
			)
		).toEqual({
			mode: "auto",
			token: "node-input-token",
			url: "https://node-input.example",
		});

		expect(
			resolveTarget(
				{
					managedNodeToken: null,
					managedNodeUrl: null,
					nodeToken: null,
					nodeUrl: null,
					target: "managed",
				},
				environment
			)
		).toEqual({
			mode: "managed",
			token: "managed-env-token",
			url: "https://managed-env.example",
		});

		expect(
			resolveTarget(
				{
					managedNodeToken: "ignored-token",
					managedNodeUrl: "https://ignored.example",
					nodeToken: null,
					nodeUrl: null,
					target: "self-hosted",
				},
				environment
			)
		).toEqual({
			mode: "self-hosted",
			token: "core-token",
			url: "https://core.example",
		});

		expect(
			resolveTarget(
				{
					managedNodeToken: null,
					managedNodeUrl: "https://managed-input.example",
					nodeToken: "node-token",
					nodeUrl: null,
					target: "managed",
				},
				{
					RYU_CORE_TOKEN: "core-token",
					RYU_CORE_URL: "https://core.example",
					RYU_MANAGED_NODE_TOKEN: "managed-env-token",
					RYU_MANAGED_NODE_URL: "https://managed-env.example",
				}
			)
		).toEqual({
			mode: "managed",
			token: "managed-env-token",
			url: "https://managed-input.example",
		});
	});

	it("requires a prompt and exactly one run selector", () => {
		const base = parseActionInputs(
			reader({ operation: "run", prompt: "hello", agent: "agent-a" })
		);
		expect(() => validateOperationInputs(base)).not.toThrow();
		expect(() => validateOperationInputs({ ...base, prompt: null })).toThrow(
			"Input 'prompt' is required"
		);
		expect(() => validateOperationInputs({ ...base, team: "team-a" })).toThrow(
			"mutually exclusive"
		);
	});
});
