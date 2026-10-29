// apps/desktop/src/hooks/available-updates-policy.test.ts
//
// Pins the rules that decide which "available update" rows the download center
// shows and the order "Update all" applies them in. Each guards a row that
// could never clear (or an update run cut short) when it was wrong.

import { describe, expect, it } from "bun:test";
import type { UpdateCheck } from "@/src/lib/api/update.ts";
import {
	pluginHasUpdate,
	showsAppUpdateRow,
	withAppUpdateLast,
} from "./available-updates-policy.ts";

function verdict(overrides: Partial<UpdateCheck>): UpdateCheck {
	return {
		asset: null,
		channel: "stable",
		current: "0.0.14",
		html_url: null,
		latest: "0.1.3",
		notes: null,
		update_available: true,
		...overrides,
	};
}

describe("showsAppUpdateRow", () => {
	it("hides the row when Core reports no update", () => {
		expect(
			showsAppUpdateRow(verdict({ update_available: false }), false, "0.1.0")
		).toBe(false);
		expect(showsAppUpdateRow(undefined, true, "0.1.0")).toBe(false);
	});

	it("gates a local node on the running app, not the answering Core", () => {
		// A stale ~/.ryu/bin Core on 0.0.14 answering for an app already on 0.1.3.
		expect(showsAppUpdateRow(verdict({}), true, "0.1.3")).toBe(false);
		expect(showsAppUpdateRow(verdict({}), true, "0.1.2")).toBe(true);
	});

	it("trusts a remote node's own verdict", () => {
		// The remote Core updates itself; the app's version says nothing about it.
		expect(showsAppUpdateRow(verdict({}), false, "0.1.3")).toBe(true);
	});
});

describe("pluginHasUpdate", () => {
	it("offers only a semver-newer catalog version", () => {
		expect(pluginHasUpdate("1.2.0", "1.3.0")).toBe(true);
		expect(pluginHasUpdate("1.3.0", "1.3.0")).toBe(false);
		// A stale catalog must never offer a downgrade.
		expect(pluginHasUpdate("1.3.0", "1.2.0")).toBe(false);
	});

	it("stays within the installed build's channel", () => {
		expect(pluginHasUpdate("1.3.0-beta.1", "1.3.0")).toBe(false);
		expect(pluginHasUpdate("1.2.0", "1.3.0-beta.1")).toBe(false);
		expect(pluginHasUpdate("1.3.0-beta.1", "1.3.0-beta.2")).toBe(true);
	});

	it("needs both versions", () => {
		expect(pluginHasUpdate(null, "1.3.0")).toBe(false);
		expect(pluginHasUpdate("1.2.0", undefined)).toBe(false);
	});
});

describe("withAppUpdateLast", () => {
	it("moves the app update after every other update, keeping their order", () => {
		const updates = [
			{ key: "plugin:a", kind: "plugin" },
			{ key: "app:ryu", kind: "app" },
			{ key: "engine:b", kind: "engine" },
			{ key: "skill:c", kind: "skill" },
		];
		expect(withAppUpdateLast(updates).map((update) => update.key)).toEqual([
			"plugin:a",
			"engine:b",
			"skill:c",
			"app:ryu",
		]);
		expect(updates[1]?.key).toBe("app:ryu");
	});
});
