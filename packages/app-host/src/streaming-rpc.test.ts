import { describe, expect, it } from "bun:test";
import { resolveRpcStream } from "./streaming-rpc.ts";

describe("method-specific stream dispatch", () => {
	it("runs locale subscriptions and aborts without an agent capability", async () => {
		const controller = new AbortController();
		const frames: string[] = [];
		const run = resolveRpcStream("i18n.subscribe", [{}], {
			i18nSubscribe: async (_input, emit, signal) => {
				emit(JSON.stringify({ locale: "fr" }));
				await new Promise<void>((resolve) =>
					signal.addEventListener("abort", () => resolve(), { once: true })
				);
			},
		});
		const pending = run((frame) => frames.push(frame), controller.signal);
		controller.abort();
		await pending;
		expect(frames).toEqual(['{"locale":"fr"}']);
	});
	it("identifies unavailable methods without attempting an agent run", () => {
		expect(() =>
			resolveRpcStream("finetune.stream", [{ id: "run-1" }], {})
		).toThrow("finetune.stream is not available");
		expect(() =>
			resolveRpcStream("realtime.subscribe", [{ connection_id: "c" }], {})
		).toThrow("realtime.subscribe is not available");
		expect(() => resolveRpcStream("unknown.subscribe", [{}], {})).toThrow(
			"unknown.subscribe is not available"
		);
	});
	it("validates each method's own input", () => {
		expect(() => resolveRpcStream("agent.run.stream", [{}], {})).toThrow(
			"task: string"
		);
		expect(() =>
			resolveRpcStream("finetune.stream", [{ task: "hello" }], {})
		).toThrow("id: string");
	});
});
