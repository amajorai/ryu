import { afterEach, describe, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import { renderToStaticMarkup } from "react-dom/server";
import type { LibraryItemType } from "@/src/lib/library.ts";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../../../packages/i18n/src/active-locale.ts";
import type { LibraryItem } from "./library-sections.ts";
import { useLibraryVisibleItems } from "./use-library-visible-items.ts";

// The Library's name sorts follow the UI language: pinyin under zh-CN (阿明
// before 张三, not code-point order) and numbers by value.
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

const EMPTY: Record<LibraryItemType, LibraryItem[]> = {
	agent: [],
	channel: [],
	chat: [],
	identity: [],
	meeting: [],
	space: [],
	team: [],
	workflow: [],
};
const NOT_LOADING: Record<LibraryItemType, boolean> = {
	agent: false,
	channel: false,
	chat: false,
	identity: false,
	meeting: false,
	space: false,
	team: false,
	workflow: false,
};

function agent(name: string): LibraryItem {
	return { id: name, name, type: "agent", updatedAt: 0 } as LibraryItem;
}

function VisibleNames({ names, sort }: { names: string[]; sort: string }) {
	const { visibleItems } = useLibraryVisibleItems({
		anySourceLoading: false,
		favoriteItems: [],
		itemsByType: { ...EMPTY, agent: names.map(agent) },
		loadingByType: NOT_LOADING,
		query: "",
		recentItems: [],
		section: "agent",
		sort,
		typeFilter: null,
	});
	return (
		<ol>
			{visibleItems.map((item) => (
				<li key={item.id}>{item.name}</li>
			))}
		</ol>
	);
}

function rendered(names: string[], sort: string): string {
	return renderToStaticMarkup(<VisibleNames names={names} sort={sort} />);
}

describe("library name sort", () => {
	test("orders Chinese names by pinyin under a zh-CN UI", () => {
		registerActiveI18nRuntime(chinese);
		expect(rendered(["张三", "阿明"], "name-asc")).toBe(
			"<ol><li>阿明</li><li>张三</li></ol>"
		);
		expect(rendered(["阿明", "张三"], "name-desc")).toBe(
			"<ol><li>张三</li><li>阿明</li></ol>"
		);
	});

	test("orders numbered names by value", () => {
		expect(rendered(["Notiz 10", "Notiz 2"], "name-asc")).toBe(
			"<ol><li>Notiz 2</li><li>Notiz 10</li></ol>"
		);
		expect(rendered(["Notiz 2", "Notiz 10"], "name-desc")).toBe(
			"<ol><li>Notiz 10</li><li>Notiz 2</li></ol>"
		);
	});
});
