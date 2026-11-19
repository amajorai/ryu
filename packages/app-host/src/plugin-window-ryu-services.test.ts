// The Path A `window.ryu` service namespaces, evaluated as the object-literal
// members they are spliced in as, with a recording `call` stub.

import { describe, expect, it } from "bun:test";
import { PLUGIN_WINDOW_RYU_SERVICES_SCRIPT } from "./plugin-window-ryu-services.ts";

type Services = Record<string, Record<string, (...args: unknown[]) => unknown>>;

function evaluate() {
	const calls: [string, unknown[]][] = [];
	const call = (method: string, args: unknown[]) => {
		calls.push([method, args]);
		return Promise.resolve();
	};
	const callStream = () => ({
		cancel: () => undefined,
		promise: Promise.resolve(),
	});
	const services = new Function(
		"call",
		"callStream",
		`return {\n${PLUGIN_WINDOW_RYU_SERVICES_SCRIPT}\n};`
	)(call, callStream) as Services;
	return { calls, services };
}

describe("PLUGIN_WINDOW_RYU_SERVICES_SCRIPT", () => {
	it("declares the service namespaces from fine-tune through skills", () => {
		const { services } = evaluate();
		expect(Object.keys(services)).toEqual([
			"finetune",
			"monitors",
			"workflows",
			"ghost",
			"app",
			"realtime",
			"ui",
			"social",
			"subtitles",
			"reasoning",
			"safeActions",
			"rlm",
			"tuition",
			"news",
			"blueprint",
			"skills",
		]);
	});

	it("forwards verbs to their host methods", () => {
		const { calls, services } = evaluate();
		services.monitors?.run?.({ id: "m" });
		services.app?.request?.();
		services.ui?.openExternal?.({ href: "https://example.com" });
		expect(calls).toEqual([
			["monitors.run", [{ id: "m" }]],
			["app.request", [{}]],
			["ui.openExternal", [{ href: "https://example.com" }]],
		]);
	});
});
