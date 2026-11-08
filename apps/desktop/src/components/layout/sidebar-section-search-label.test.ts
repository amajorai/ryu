import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider, useI18n, useLiteralMessages } = await import(
	"@ryu/i18n/react"
);
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { searchLabelFor } = await import("./sidebar-section-search-label.ts");

// Fixture catalogs: the whole search sentences, plus the fragment values the
// bare nouns carried ("{n} tools" counters, an "of the agents" case form).
// The DOM localizer is off, so only the sentence lookup can translate.
const CATALOGS: Record<string, Record<string, string>> = {
	ar: {
		agents: "من الوكلاء",
		"Search agents": "البحث في الوكلاء",
		"Search chats": "البحث في المحادثات",
	},
	de: {
		chats: "chats",
		plugins: "plugins",
		"Search chats": "Chats durchsuchen",
	},
	ja: {
		"Search chats": "チャットを検索",
		"Search tools": "ツールを検索",
		tools: "個のツールが",
	},
	ko: {
		agents: "개",
		"Search agents": "에이전트 검색",
		"Search chats": "채팅 검색",
		"Search tools": "도구 검색",
		tools: "개 도구",
	},
};

const SECTIONS = ["chats", "tools", "agents", "plugins", "unknown section"];
const roots: Root[] = [];

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	registerLiteralCatalogLoader(null);
});

function Probe() {
	const { t } = useI18n();
	const tl = useLiteralMessages();
	return createElement(
		"ul",
		null,
		SECTIONS.map((section) =>
			createElement(
				"li",
				{ key: section },
				searchLabelFor(section, tl, () =>
					t("sidebar.search-section", { section })
				)
			)
		)
	);
}

async function renderLabels(locale: string): Promise<string[]> {
	registerLiteralCatalogLoader((requested) => CATALOGS[requested] ?? {});
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			createElement(I18nProvider, {
				autoLocalizeDom: false,
				children: createElement(Probe),
				initialLocale: locale,
				initialPackId: null,
			})
		);
	});
	await act(async () => {
		await Bun.sleep(30);
	});
	return [...container.querySelectorAll("li")].map(
		(item) => item.textContent ?? ""
	);
}

describe("searchLabelFor", () => {
	test("renders whole Japanese and Korean sentences, never the counter fragments", async () => {
		const ja = await renderLabels("ja");
		expect(ja.slice(0, 2)).toEqual(["チャットを検索", "ツールを検索"]);
		const ko = await renderLabels("ko");
		expect(ko[1]).toBe("도구 검색");
		expect(ko[2]).toBe("에이전트 검색");
		for (const label of [...ja, ...ko]) {
			expect(label).not.toContain("chats");
			expect(label).not.toContain("個のツールが");
			expect(label).not.toMatch(/(?:^|\s)개 /u);
		}
	});

	test("renders Arabic and German sentences instead of an interpolated noun", async () => {
		const ar = await renderLabels("ar");
		expect(ar[0]).toBe("البحث في المحادثات");
		expect(ar[2]).toBe("البحث في الوكلاء");
		expect(ar.join(" ")).not.toContain("من الوكلاء");
		const de = await renderLabels("de");
		expect(de[0]).toBe("Chats durchsuchen");
		// "Search plugins" is also the Marketplace's named message, whose
		// built-in German wins over the fixture.
		expect(de[3]).not.toContain("plugins");
		expect(de.join(" ")).not.toContain("chats durchsuchen");
	});

	test("falls back to the generic message for a label it does not know", async () => {
		const en = await renderLabels("en");
		expect(en).toEqual([
			"Search chats",
			"Search tools",
			"Search agents",
			"Search plugins",
			"Search unknown section",
		]);
		const de = await renderLabels("de");
		expect(de[4]).toBe("unknown section durchsuchen");
	});

	test("ignores inherited object keys", () => {
		const tl = (source: string) => `tl:${source}`;
		expect(searchLabelFor("constructor", tl, () => "fallback")).toBe(
			"fallback"
		);
		expect(searchLabelFor("toString", tl, () => "fallback")).toBe("fallback");
		expect(searchLabelFor("tools", tl, () => "fallback")).toBe(
			"tl:Search tools"
		);
	});
});
