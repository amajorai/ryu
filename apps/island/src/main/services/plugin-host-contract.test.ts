import { expect, test } from "bun:test";
import {
	hostErrorSchema,
	hostStreamPartSchema,
	pluginContributionsSchema,
} from "./plugin-host-contract.ts";

test("contributions retain raw future and malformed specs for renderer fallback", () => {
	const views = [
		{
			id: "future",
			view: "hologram",
			spec: { view: "hologram", shader: [1, 2] },
		},
		{ id: "malformed", view: "list-detail", spec: "invalid" },
	];
	expect(pluginContributionsSchema.parse({ views }).views).toEqual(views);
});

test("companions preserve deny-safe defaults and ignore invalid sibling rows", () => {
	const parsed = pluginContributionsSchema.parse({
		companions: [{ id: "plugin", approved_grants: [42] }, { id: 42 }],
	});
	expect(parsed.companions?.[0]).toEqual({
		id: "plugin",
		approved_grants: [],
		default_csp_enforced: true,
		has_ui: false,
		icon: null,
		plugin_id: "",
		shortcut: null,
	});
	expect(parsed.companions?.[1]).toBeNull();
});

test("host errors retain known codes and default malformed stream error text", () => {
	expect(
		hostErrorSchema.parse({ error: { code: "denied", message: "blocked" } })
			.error
	).toEqual({ code: "denied", message: "blocked" });
	expect(
		hostErrorSchema.parse({ error: { code: "future", message: "blocked" } })
			.error?.code
	).toBeUndefined();
	expect(hostStreamPartSchema.parse({ type: "error" })).toEqual({
		type: "error",
		errorText: "agent stream error",
	});
	expect(
		hostStreamPartSchema.safeParse({ type: "text-delta", delta: 42 }).success
	).toBe(false);
});
