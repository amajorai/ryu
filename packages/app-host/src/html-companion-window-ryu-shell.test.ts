// Forwarders and shell primitives that close the Path B `window.ryu` bridge,
// evaluated together with the sibling fragments against a recording `call` stub.

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

describe("HTML_COMPANION_WINDOW_RYU_SHELL_SCRIPT", () => {
	it("closes the object with the forwarders, shell and mount context", () => {
		const { calls, ryu } = evaluate();
		const keys = Object.keys(ryu);
		expect(keys.at(-1)).toBe("context");
		expect(ryu.context as unknown).toEqual({ spaceId: "s" });
		ryu.social?.openList?.();
		ryu.blueprint?.request?.({ path: "/p" });
		ryu.apps?.installBundle?.({ id: "b" });
		ryu.shell?.openTab?.();
		expect(calls).toEqual([
			["social.openList", []],
			["blueprint.request", [{ path: "/p" }]],
			["apps.installBundle", [{ id: "b" }]],
			["shell.openTab", [{}]],
		]);
	});
});
