// Core namespaces of the Path B `window.ryu` bridge, evaluated together with the
// sibling fragments they are joined with, against a recording `call` stub.

import { describe, expect, it } from "bun:test";
import { htmlCompanionWindowRyuCoreScript } from "./html-companion-window-ryu.ts";
import { HTML_COMPANION_WINDOW_RYU_APPS_SCRIPT } from "./html-companion-window-ryu-apps.ts";
import { HTML_COMPANION_WINDOW_RYU_SHELL_SCRIPT } from "./html-companion-window-ryu-shell.ts";

type Bridge = Record<string, Record<string, (...args: unknown[]) => unknown>>;

/** Evaluate the three fragments exactly as `htmlCompanionSrcdoc` joins them. */
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
	const ryu = new Function(
		"call",
		"callStream",
		"applyThemeTokens",
		"MOUNT_CONTEXT",
		[
			"var ryu = {",
			htmlCompanionWindowRyuCoreScript(),
			HTML_COMPANION_WINDOW_RYU_APPS_SCRIPT,
			HTML_COMPANION_WINDOW_RYU_SHELL_SCRIPT,
			"return ryu;",
		].join("\n")
	)(call, callStream, () => undefined, { spaceId: "s" }) as Bridge;
	return { calls, ryu };
}

describe("htmlCompanionWindowRyuCoreScript", () => {
	it("opens the object with host, node and the shared i18n bridge", () => {
		const { calls, ryu } = evaluate();
		const keys = Object.keys(ryu);
		expect(keys.slice(0, 4)).toEqual(["host", "node", "i18n", "listAgents"]);
		expect(keys).toContain("webhooks");
		ryu.i18n?.get?.();
		ryu.node?.shareOrigins?.();
		ryu.webhooks?.getSecret?.("w-1");
		expect(calls).toEqual([
			["i18n.get", []],
			["node.shareOrigins", []],
			["webhooks.secretGet", [{ id: "w-1" }]],
		]);
	});
});
