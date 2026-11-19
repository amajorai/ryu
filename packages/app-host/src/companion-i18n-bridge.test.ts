// The shared `i18n` bridge members, evaluated as the generated bootstraps install
// them, with `call`/`callStream` replaced by recorders.

import { describe, expect, it } from "bun:test";
import { I18N_BRIDGE } from "./companion-i18n-bridge.ts";

interface StreamHandle {
	cancel: () => void;
	promise: Promise<unknown>;
}

interface I18nBridge {
	i18n: {
		get: () => unknown;
		subscribe: (opts?: { onChange?: (value: unknown) => void }) => {
			dispose: () => void;
		};
		translate: (args?: unknown) => unknown;
	};
}

function install() {
	const calls: [string, unknown[]][] = [];
	const streams: { chunk: (data: string) => void; method: string }[] = [];
	const cancel = () => undefined;
	const call = (method: string, args: unknown[]) => {
		calls.push([method, args]);
		return Promise.resolve(method);
	};
	const callStream = (
		method: string,
		_args: unknown[],
		chunk: (data: string) => void
	): StreamHandle => {
		streams.push({ chunk, method });
		return { cancel, promise: Promise.resolve() };
	};
	const bridge = new Function("call", "callStream", `return {${I18N_BRIDGE}};`)(
		call,
		callStream
	) as I18nBridge;
	return { bridge, calls, cancel, streams };
}

describe("I18N_BRIDGE", () => {
	it("routes get and translate to the host i18n verbs", () => {
		const { bridge, calls } = install();
		bridge.i18n.get();
		bridge.i18n.translate();
		bridge.i18n.translate({ id: "greeting" });
		expect(calls).toEqual([
			["i18n.get", []],
			["i18n.translate", [{}]],
			["i18n.translate", [{ id: "greeting" }]],
		]);
	});

	it("streams parsed locale changes and disposes through cancel", () => {
		const { bridge, cancel, streams } = install();
		const seen: unknown[] = [];
		const handle = bridge.i18n.subscribe({
			onChange: (value) => seen.push(value),
		});
		expect(streams.map((stream) => stream.method)).toEqual(["i18n.subscribe"]);
		streams[0]?.chunk('{"locale":"fr"}');
		streams[0]?.chunk("not json");
		expect(seen).toEqual([{ locale: "fr" }]);
		expect(handle.dispose).toBe(cancel);
	});
});
