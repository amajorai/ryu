import { describe, expect, it } from "bun:test";
import { formatMessage } from "@ryu/i18n";
import type { LiteralMessage } from "@ryu/i18n/react";
import type { HookInventoryItem } from "@/src/lib/api/hooks.ts";
import { groupHookInventory, hookPhaseCopy } from "./hooks-view.ts";

const tl: LiteralMessage = (source, values) => formatMessage(source, values);

const hook = (
	overrides: Partial<HookInventoryItem> = {}
): HookInventoryItem => ({
	effectiveEnabled: false,
	enabled: true,
	handler: { display: "Sandboxed JavaScript", kind: "sandbox_js" },
	hookKey: "com.example.security::review",
	id: "review",
	localOverrides: {},
	ownerId: "com.example.security",
	ownerName: "Security Guidance",
	phase: "post_assistant_turn",
	pluginEnabled: true,
	priority: 0,
	reviewRequired: true,
	source: "plugin",
	trusted: false,
	...overrides,
});

describe("groupHookInventory", () => {
	it("groups by source and owner while preserving review counts", () => {
		const groups = groupHookInventory(tl, [
			hook(),
			hook({
				hookKey: "com.example.security::start",
				id: "start",
				phase: "session_start",
				reviewRequired: false,
				trusted: true,
			}),
			hook({
				hookKey: "config::lint",
				id: "lint",
				ownerId: "user-config",
				ownerName: "User config",
				source: "config",
			}),
		]);

		expect(groups.map((group) => group.source)).toEqual(["config", "plugin"]);
		expect(groups[1]?.owners[0]?.hookCount).toBe(2);
		expect(groups[1]?.owners[0]?.reviewCount).toBe(1);
		expect(groups[1]?.owners[0]?.phases.map((phase) => phase.phase)).toEqual([
			"post_assistant_turn",
			"session_start",
		]);
	});
});

describe("hookPhaseCopy", () => {
	it("uses plain-language copy for known phases", () => {
		expect(hookPhaseCopy(tl, "post_tool_use")).toEqual({
			description: "After a tool finishes",
			title: "Post tool use",
		});
	});

	it("humanizes future phases instead of hiding their hooks", () => {
		expect(hookPhaseCopy(tl, "agent_handoff")).toEqual({
			description: "When agent handoff runs",
			title: "Agent handoff",
		});
	});
});
