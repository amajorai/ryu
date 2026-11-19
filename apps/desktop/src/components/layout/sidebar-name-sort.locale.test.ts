import { afterEach, describe, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import type { Conversation } from "@/types/chat.ts";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../../packages/i18n/src/active-locale.ts";
import { type ChatGroupContext, groupChats } from "./sidebar-chat-view.ts";
import { sortItems } from "./sidebar-sort-paging.ts";

// Name sorts follow the UI language: pinyin under zh-CN (阿明 before 张三, not
// code-point order) and numbers by value ("Notiz 2" before "Notiz 10").
const chinese = {
	direction: "ltr" as const,
	locale: "zh-CN",
	translate(id: string, values?: MessageValuesInput, fallback?: string) {
		return formatMessage(fallback ?? id, values, "zh-CN");
	},
};

afterEach(() => {
	unregisterActiveI18nRuntime(chinese);
});

interface Named {
	name: string;
}

const accessors = {
	created: () => 0,
	name: (item: Named) => item.name,
	updated: () => 0,
};

function names(items: Named[]): string[] {
	return items.map((item) => item.name);
}

describe("sidebar name sort", () => {
	test("orders Chinese names by pinyin under a zh-CN UI", () => {
		registerActiveI18nRuntime(chinese);
		const items = [{ name: "张三" }, { name: "阿明" }];
		expect(names(sortItems(items, "name-asc", accessors))).toEqual([
			"阿明",
			"张三",
		]);
		expect(names(sortItems(items, "name-desc", accessors))).toEqual([
			"张三",
			"阿明",
		]);
	});

	test("orders numbered names by value", () => {
		const items = [{ name: "Notiz 10" }, { name: "Notiz 2" }];
		expect(names(sortItems(items, "name-asc", accessors))).toEqual([
			"Notiz 2",
			"Notiz 10",
		]);
		expect(names(sortItems(items, "name-desc", accessors))).toEqual([
			"Notiz 10",
			"Notiz 2",
		]);
	});
});

describe("chat project groups", () => {
	function chat(id: string, folderPath: string | null): Conversation {
		return {
			createdAt: 0,
			folderPath,
			id,
			messages: [],
			title: id,
			updatedAt: 0,
		} as Conversation;
	}
	const context: ChatGroupContext = {
		agentName: (id) => id,
		customGroupOf: () => ({ id: "none", label: "" }),
		customGroups: [],
		projectName: (path) => path.split("/").pop() ?? path,
		unreadIds: new Set<string>(),
	};

	test("sort project labels by pinyin under a zh-CN UI, No project last", () => {
		registerActiveI18nRuntime(chinese);
		const groups = groupChats(
			[chat("a", "/w/张三"), chat("b", null), chat("c", "/w/阿明")],
			"project",
			context
		);
		expect(groups.map((group) => group.label)).toEqual([
			"阿明",
			"张三",
			"No project",
		]);
	});

	test("sort numbered project labels by value", () => {
		const groups = groupChats(
			[chat("a", "/w/Notiz 10"), chat("b", "/w/Notiz 2")],
			"project",
			context
		);
		expect(groups.map((group) => group.label)).toEqual(["Notiz 2", "Notiz 10"]);
	});
});
