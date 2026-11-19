// Path A `installWindowRyu()`, evaluated with recording `call`/`callStream` stubs
// and a fake `window`, so the installed surface and its RPC routing are observable.

import { describe, expect, it } from "bun:test";
import { installWindowRyuScript } from "./plugin-window-ryu-script.ts";

type Bridge = Record<
	string,
	Record<string, (...args: unknown[]) => unknown>
> & {
	context: unknown;
	tokenTable: unknown;
};

function install() {
	const calls: [string, unknown[]][] = [];
	const call = (method: string, args: unknown[]) => {
		calls.push([method, args]);
		return Promise.resolve();
	};
	const callStream = () => ({
		cancel: () => undefined,
		promise: Promise.resolve(),
	});
	const fakeWindow: Record<string, unknown> = {};
	new Function(
		"call",
		"callStream",
		"applyThemeTokens",
		"MOUNT_CONTEXT",
		"window",
		`${installWindowRyuScript()}\ninstallWindowRyu();`
	)(call, callStream, () => undefined, { docId: "d-1" }, fakeWindow);
	return { calls, fakeWindow, ryu: fakeWindow.ryu as Bridge };
}

describe("installWindowRyuScript", () => {
	it("installs window.ryu, the openai alias and the host-bridge marker", () => {
		const { fakeWindow, ryu } = install();
		expect(fakeWindow.openai).toBe(ryu);
		expect(fakeWindow.__ryuHostBridge).toBe(true);
		expect(ryu.context).toEqual({ docId: "d-1" });
		expect(ryu.tokenTable).toBe(ryu.realtime);
	});

	it("routes host, service and shell verbs over call()", () => {
		const { calls, ryu } = install();
		const host = ryu.host as unknown as {
			native: { haptics: (a?: unknown) => unknown };
		};
		host.native.haptics();
		ryu.storage?.get?.({ key: "k" });
		ryu.finetune?.list?.();
		ryu.skills?.setTitle?.({ title: "t" });
		ryu.shell?.openTab?.();
		expect(calls).toEqual([
			["native.haptics", [{}]],
			["storage.get", [{ key: "k" }]],
			["finetune.list", []],
			["skills.setTitle", [{ title: "t" }]],
			["shell.openTab", [{}]],
		]);
	});
});
