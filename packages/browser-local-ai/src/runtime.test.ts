import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { BrowserGenerationRequest } from "./runtime.ts";

const originalNavigator = Object.getOwnPropertyDescriptor(
	globalThis,
	"navigator"
);
Object.defineProperty(globalThis, "navigator", {
	configurable: true,
	value: { gpu: {} },
});
const calls: Array<{ device: string; dtype: string }> = [];
const messages: unknown[] = [];
let gpuText = "";
let wasmText = "Blue.";
let wasmFailure = false;
let duringGeneration:
	| ((criteria: { _call(ids: number[][]): boolean[] }) => void)
	| undefined;
interface TestRuntimeEnvironment {
	backends: {
		onnx: { wasm: { numThreads: number; wasmPaths: { wasm?: string } } };
	};
	useBrowserCache: boolean;
	useFSCache: boolean;
	useWasmCache: boolean;
}
const environment: TestRuntimeEnvironment = {
	useBrowserCache: false,
	useFSCache: true,
	useWasmCache: true,
	backends: {
		onnx: { wasm: { numThreads: 4, wasmPaths: {} } },
	},
};
mock.module("@huggingface/transformers", () => ({
	env: environment,
	TextStreamer: class {},
	StoppingCriteria: class {},
	pipeline: async (
		_task: string,
		_id: string,
		options: { device: string; dtype: string }
	) => {
		calls.push({ device: options.device, dtype: options.dtype });
		if (options.device === "wasm" && wasmFailure) {
			throw new Error("WASM unavailable");
		}
		return Object.assign(
			async (
				input: string | BrowserGenerationRequest["messages"],
				generation: { stopping_criteria: { _call(ids: number[][]): boolean[] } }
			) => {
				duringGeneration?.(generation.stopping_criteria);
				messages.push(input);
				return [
					{
						generated_text: [
							{
								role: "assistant",
								content: options.device === "webgpu" ? gpuText : wasmText,
							},
						],
					},
				];
			},
			{ tokenizer: {} }
		);
	},
}));
const { BrowserLocalRuntime } = await import("./runtime.ts");
const modelId = "onnx-community/SmolLM2-135M-Instruct-ONNX";
const request = {
	modelId,
	messages: [{ role: "user" as const, content: "What color is the sky?" }],
};
beforeEach(() => {
	calls.length = 0;
	messages.length = 0;
	gpuText = "";
	wasmText = "Blue.";
	wasmFailure = false;
	duringGeneration = undefined;
});
afterAll(() => {
	if (originalNavigator) {
		Object.defineProperty(globalThis, "navigator", originalNavigator);
	} else {
		Reflect.deleteProperty(globalThis, "navigator");
	}
});
describe("browser generation backend recovery", () => {
	test("loads CPU q8 directly without WebGPU and uses the packaged single-thread runtime", async () => {
		Object.defineProperty(globalThis, "navigator", {
			configurable: true,
			value: {},
		});
		try {
			const runtime = new BrowserLocalRuntime({
				wasmBinaryUrl: "chrome-extension://fixture/ort.wasm",
			});
			expect((await runtime.generate(request)).text).toBe("Blue.");
			expect(calls).toEqual([{ device: "wasm", dtype: "q8" }]);
			expect(environment.useWasmCache).toBe(false);
			expect(environment.backends.onnx.wasm).toEqual({
				numThreads: 1,
				wasmPaths: { wasm: "chrome-extension://fixture/ort.wasm" },
			});
		} finally {
			Object.defineProperty(globalThis, "navigator", {
				configurable: true,
				value: { gpu: {} },
			});
		}
	});
	test("retries an empty WebGPU answer with WASM and reuses the recovered pipeline", async () => {
		const runtime = new BrowserLocalRuntime({
			wasmBinaryUrl: "chrome-extension://fixture/ort.wasm",
		});
		expect(await runtime.generate(request)).toEqual({
			text: "Blue.",
			toolCalls: [],
		});
		expect(calls).toEqual([
			{ device: "webgpu", dtype: "q4f16" },
			{ device: "wasm", dtype: "q8" },
		]);
		expect(messages).toEqual([request.messages, request.messages]);
		expect(runtime.getStatus(modelId)?.status).toBe("ready");
		expect(await runtime.generate(request)).toEqual({
			text: "Blue.",
			toolCalls: [],
		});
		expect(calls).toHaveLength(2);
	});
	test("retains a usable WebGPU answer without unnecessary fallback", async () => {
		gpuText = "Blue.";
		const runtime = new BrowserLocalRuntime();
		expect((await runtime.generate(request)).text).toBe("Blue.");
		expect(calls).toEqual([{ device: "webgpu", dtype: "q4f16" }]);
	});
	test("reports empty output from both backends without an infinite retry", async () => {
		wasmText = "";
		await expect(new BrowserLocalRuntime().generate(request)).rejects.toThrow(
			"returned no text"
		);
		expect(calls).toHaveLength(2);
	});
	test("evicts a failed fallback so a later attempt can recover", async () => {
		wasmFailure = true;
		const runtime = new BrowserLocalRuntime();
		await expect(runtime.generate(request)).rejects.toThrow("WASM unavailable");
		expect(runtime.getStatus(modelId)?.status).toBe("failed");
		wasmFailure = false;
		expect((await runtime.generate(request)).text).toBe("Blue.");
		expect(calls).toHaveLength(4);
	});
});

test("cancel stops decoding and rejects output without backend fallback; retry remains usable", async () => {
	const controller = new AbortController();
	const runtime = new BrowserLocalRuntime();
	duringGeneration = (criteria) => {
		expect(criteria._call([[1], [2]])).toEqual([false, false]);
		controller.abort();
		expect(criteria._call([[1], [2]])).toEqual([true, true]);
	};
	await expect(runtime.generate(request, controller.signal)).rejects.toThrow();
	expect(calls).toEqual([{ device: "webgpu", dtype: "q4f16" }]);
	expect(messages).toHaveLength(1);
	duringGeneration = undefined;
	gpuText = "Recovered.";
	expect((await runtime.generate(request)).text).toBe("Recovered.");
	expect(calls).toHaveLength(1);
});
test("already canceled generation does not prepare a model", async () => {
	const controller = new AbortController();
	controller.abort();
	await expect(
		new BrowserLocalRuntime().generate(request, controller.signal)
	).rejects.toThrow();
	expect(calls).toHaveLength(0);
});
describe("tool-call parsing", () => {
	const toolCallsFor = async (text: string) => {
		gpuText = text;
		return (await new BrowserLocalRuntime().generate(request)).toolCalls;
	};
	test("keeps a call whose arguments are a nested object", async () => {
		expect(
			await toolCallsFor(
				'<tool_call>{"name":"browser.read","arguments":{"tabId":3}}</tool_call>'
			)
		).toEqual([{ name: "browser.read", arguments: { tabId: 3 } }]);
	});
	test("accepts arguments before the name and braces inside strings", async () => {
		expect(
			await toolCallsFor(
				'{"arguments":{"query":"a } b \\" {"},"tool":"browser.search"}'
			)
		).toEqual([{ name: "browser.search", arguments: { query: 'a } b " {' } }]);
	});
	test("returns every call in one reply without re-reading nested objects", async () => {
		expect(
			await toolCallsFor(
				'First {"name":"a","arguments":{}} then [{"name":"b","input":{"x":{"y":1}}}] and {not json'
			)
		).toEqual([
			{ name: "a", arguments: {} },
			{ name: "b", arguments: { x: { y: 1 } } },
		]);
	});
	test("ignores objects without a tool name", async () => {
		expect(await toolCallsFor('Here is data: {"name":"","x":1}')).toEqual([]);
	});
});
