import { describe, expect, test } from "bun:test";
import { createDefaultWorkbench } from "@ryu/workbench/model";
import { reduceWorkbench } from "@ryu/workbench/reducer";
import {
	findOpenToolItem,
	isConversationPanelKind,
	scopeMatchesFolder,
	shellPanelKind,
	workbenchToolItem,
} from "./shell-panels.ts";

const TERMINAL = {
	id: "terminal",
	label: "Terminal",
	region: "bottom" as const,
};
const APP_PANEL = {
	id: "plugin:com.ryu.browser:browser",
	label: "Browser",
	region: "right" as const,
};

describe("workbench tool items", () => {
	test("scopes project tools to the open folder and app panels to the window", () => {
		const terminal = workbenchToolItem(TERMINAL, "/work/ryu/", "t1");
		expect(terminal.scope).toEqual({ kind: "project", folder: "/work/ryu/" });
		expect(terminal.source).toEqual({ kind: "shell", panel: "terminal" });
		expect(terminal.preferredRegion).toBe("bottom");
		const noFolder = workbenchToolItem(TERMINAL, null, "t2");
		expect(noFolder.scope).toEqual({ kind: "window" });
		const app = workbenchToolItem(APP_PANEL, "/work/ryu", "p1");
		expect(app.scope).toEqual({ kind: "window" });
		expect(app.source).toEqual({
			kind: "plugin",
			panelId: "browser",
			pluginId: "com.ryu.browser",
		});
		expect(shellPanelKind(app)).toBe(APP_PANEL.id);
	});

	test("matches project scope by normalized folder only", () => {
		const scope = { kind: "project" as const, folder: "/work/ryu/" };
		expect(scopeMatchesFolder(scope, "/work/ryu")).toBe(true);
		expect(scopeMatchesFolder(scope, "/work/other")).toBe(false);
		expect(scopeMatchesFolder(scope, null)).toBe(false);
		expect(scopeMatchesFolder({ kind: "window" }, null)).toBe(true);
	});

	test("finds the existing instance for the same project instead of opening another", () => {
		let state = createDefaultWorkbench({
			bottomGroupId: "bottom-main",
			centerGroupId: "center-main",
			leftGroupId: "left-main",
			navigationId: "navigation",
			rightGroupId: "right-main",
		});
		state = reduceWorkbench(state, {
			type: "item/open",
			groupId: "bottom-main",
			item: workbenchToolItem(TERMINAL, "/work/ryu", "t1"),
		});
		expect(findOpenToolItem(state, TERMINAL, "/work/ryu/")?.id).toBe("t1");
		expect(findOpenToolItem(state, TERMINAL, "/work/other")).toBeUndefined();
		expect(findOpenToolItem(state, APP_PANEL, "/work/ryu")).toBeUndefined();
	});

	test("keeps chat-bound panels out of the page-agnostic tool set", () => {
		expect(isConversationPanelKind("context")).toBe(true);
		expect(isConversationPanelKind("terminal")).toBe(false);
	});
	test("scopes chat panels to their conversation and names the chat", () => {
		const option = {
			conversation: { id: "conv-a", title: "Plan the week" },
			id: "context",
			label: "Context",
			region: "right" as const,
		};
		const item = workbenchToolItem(option, "/work/ryu", "ctx-1");
		expect(item.scope).toEqual({
			kind: "conversation",
			conversationId: "conv-a",
		});
		expect(item.title).toBe("Context: Plan the week");
		let state = createDefaultWorkbench({
			bottomGroupId: "bottom-main",
			centerGroupId: "center-main",
			leftGroupId: "left-main",
			navigationId: "navigation",
			rightGroupId: "right-main",
		});
		state = reduceWorkbench(state, {
			type: "item/open",
			groupId: "right-main",
			item,
		});
		expect(findOpenToolItem(state, option, null)?.id).toBe("ctx-1");
		expect(
			findOpenToolItem(
				state,
				{ ...option, conversation: { id: "conv-b", title: "Other" } },
				null
			)
		).toBeUndefined();
	});
});
