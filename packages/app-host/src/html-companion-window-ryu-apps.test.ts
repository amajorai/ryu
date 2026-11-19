// First-party app namespaces of the Path B `window.ryu` bridge, evaluated together
// with the sibling fragments they are joined with, against a recording `call` stub.

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

describe("HTML_COMPANION_WINDOW_RYU_APPS_SCRIPT", () => {
	it("routes app verbs, including the shell-navigation ones", () => {
		const { calls, ryu } = evaluate();
		for (const name of ["quests", "activity", "timeline", "meetings", "ui"]) {
			expect(Object.keys(ryu)).toContain(name);
		}
		ryu.quests?.openDetectionSettings?.();
		ryu.meetings?.remove?.({ id: "m" });
		ryu.warmup?.apply?.();
		expect(calls).toEqual([
			["quests.openDetectionSettings", []],
			["meetings.delete", [{ id: "m" }]],
			["warmup.apply", [[]]],
		]);
	});
});
