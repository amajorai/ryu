import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../i18n/src/active-locale.ts";

// @pierre/diffs and @pierre/trees draw fixed English inside open shadow roots
// (the document's DOM localizer never enters them, and skips the diff `<pre>`).
// These shadow roots must follow the UI language without touching code lines
// or file names.
if (typeof document === "undefined") {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { localizePierreCopy, localizePierreShadowRoot } = await import(
	"./pierre-shadow-copy.ts"
);
const { usePierreShadowLocalizer } = await import(
	"./use-pierre-shadow-localizer.ts"
);
afterAll(async () => {
	await GlobalRegistrator.unregister();
});

const JA: Record<string, string> = {
	"{count, plural, one {# unmodified line} other {# unmodified lines}}":
		"{count} 行の変更なし",
	"{count, plural, one {# result} other {# results}}": "{count} 件の結果",
	"{current} of {total}": "{current} / {total}",
	"Expand all": "すべて展開",
	"No newline at end of file": "ファイル末尾に改行がありません",
	"No results": "結果なし",
	Options: "オプション",
	"Rename {name}": "{name} の名前を変更",
	Replace: "置換",
	Search: "検索",
	"Search…": "検索…",
};

function standIn(locale: string, messages: Record<string, string>) {
	return {
		direction: "ltr" as const,
		locale,
		translate(id: string, values?: MessageValuesInput, fallback?: string) {
			const source = fallback ?? id;
			return formatMessage(messages[source] ?? source, values, locale);
		},
	};
}

const registered: ReturnType<typeof standIn>[] = [];
function useLocale(locale: string, messages: Record<string, string> = {}) {
	const runtime = standIn(locale, messages);
	registered.push(runtime);
	registerActiveI18nRuntime(runtime);
}

afterEach(() => {
	for (const runtime of registered.splice(0)) {
		unregisterActiveI18nRuntime(runtime);
	}
	document.body.innerHTML = "";
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const DIFF_SHADOW = [
	"<pre><code>",
	'<div data-separator-content=""><span data-unmodified-lines="">12 unmodified lines</span></div>',
	'<div data-expand-button="" data-expand-all-button="" role="button">Expand all</div>',
	'<div data-no-newline=""><span>No newline at end of file</span></div>',
	"<span>Search</span>",
	"</code></pre>",
	'<div data-matches="">3 of 7</div>',
	'<input placeholder="Replace">',
	'<button data-search-icon="" title="Next" aria-label="Next"></button>',
].join("");

function shadowHost(markup: string): ShadowRoot {
	const host = document.createElement("div");
	document.body.append(host);
	const shadow = host.attachShadow({ mode: "open" });
	shadow.innerHTML = markup;
	return shadow;
}

const text = (root: ParentNode, selector: string) =>
	root.querySelector(selector)?.textContent;

describe("localizePierreCopy", () => {
	test("leave English intact and pluralize the counted strings", () => {
		useLocale("en");
		expect(localizePierreCopy("1 unmodified line")).toBe("1 unmodified line");
		expect(localizePierreCopy("12 unmodified lines")).toBe(
			"12 unmodified lines"
		);
		expect(localizePierreCopy("1 results")).toBe("1 result");
		expect(localizePierreCopy("some code")).toBe("some code");
	});

	test("translate fixed, counted and named copy", () => {
		useLocale("ja", JA);
		expect(localizePierreCopy("12 unmodified lines")).toBe("12 行の変更なし");
		expect(localizePierreCopy("4 results")).toBe("4 件の結果");
		expect(localizePierreCopy("3 of 7")).toBe("3 / 7");
		expect(localizePierreCopy("Rename a.ts")).toBe("a.ts の名前を変更");
		expect(localizePierreCopy("Options")).toBe("オプション");
	});
});

test("pluralize per locale: de and ar", () => {
	useLocale("de", {
		"{count, plural, one {# unmodified line} other {# unmodified lines}}":
			"{count, plural, one {# unveränderte Zeile} other {# unveränderte Zeilen}}",
	});
	expect(localizePierreCopy("1 unmodified line")).toBe("1 unveränderte Zeile");
	expect(localizePierreCopy("1234 unmodified lines")).toBe(
		"1.234 unveränderte Zeilen"
	);
	expect(localizePierreCopy("5 unmodified lines")).toBe(
		"5 unveränderte Zeilen"
	);
	useLocale("ar", {
		"{count, plural, one {# result} other {# results}}":
			"{count, plural, zero {لا نتائج} one {نتيجة واحدة} two {نتيجتان} few {# نتائج} other {# نتيجة}}",
	});
	expect(localizePierreCopy("2 results")).toBe("نتيجتان");
	expect(localizePierreCopy("3 results")).toBe("3 نتائج");
});

describe("localizePierreShadowRoot", () => {
	test("translate library chrome, never code, and follow language changes", async () => {
		useLocale("ja", JA);
		const shadow = shadowHost(DIFF_SHADOW);
		const localizer = localizePierreShadowRoot(shadow);
		expect(text(shadow, "[data-unmodified-lines]")).toBe("12 行の変更なし");
		expect(text(shadow, "[data-expand-all-button]")).toBe("すべて展開");
		expect(text(shadow, "[data-no-newline] > span")).toBe(
			"ファイル末尾に改行がありません"
		);
		expect(text(shadow, "code > span")).toBe("Search");
		expect(text(shadow, "[data-matches]")).toBe("3 / 7");
		expect(shadow.querySelector("input")?.getAttribute("placeholder")).toBe(
			"置換"
		);

		// The library rewrites the match counter as the user searches.
		const counter = shadow.querySelector("[data-matches]");
		if (counter) {
			counter.textContent = "No results";
		}
		await settle();
		expect(text(shadow, "[data-matches]")).toBe("結果なし");

		// Back to English: each rewritten value returns to its source.
		useLocale("en");
		localizer.refresh();
		expect(text(shadow, "[data-unmodified-lines]")).toBe("12 unmodified lines");
		expect(text(shadow, "[data-matches]")).toBe("No results");
		localizer.dispose();
	});

	test("translate the Files tree search field and row actions, not file names", () => {
		useLocale("ja", JA);
		const shadow = shadowHost(
			[
				'<input placeholder="Search…">',
				'<input data-item-rename-input="" aria-label="Rename Options">',
				'<button data-type="context-menu-trigger" aria-haspopup="menu" aria-label="Options"></button>',
				'<button data-type="item" aria-haspopup="menu" aria-label="Options"><span>Options</span></button>',
				'<button data-type="item" aria-haspopup="menu" aria-label="3 results"></button>',
			].join("")
		);
		const localizer = localizePierreShadowRoot(shadow);
		const inputs = shadow.querySelectorAll("input");
		expect(inputs[0]?.getAttribute("placeholder")).toBe("検索…");
		expect(inputs[1]?.getAttribute("aria-label")).toBe("Options の名前を変更");
		const buttons = shadow.querySelectorAll("button");
		expect(buttons[0]?.getAttribute("aria-label")).toBe("オプション");
		// A row for a file named "Options" keeps its name.
		expect(buttons[1]?.getAttribute("aria-label")).toBe("Options");
		expect(buttons[1]?.textContent).toBe("Options");
		expect(buttons[2]?.getAttribute("aria-label")).toBe("3 results");
		localizer.dispose();
	});
});

describe("usePierreShadowLocalizer", () => {
	test("localize a diffs host shadow root that mounts under ja", async () => {
		if (!customElements.get("diffs-container")) {
			customElements.define(
				"diffs-container",
				class extends HTMLElement {
					constructor() {
						super();
						this.attachShadow({ mode: "open" });
					}
				}
			);
		}
		useLocale("ja", JA);
		function Preview({ show }: { show: boolean }) {
			const ref = usePierreShadowLocalizer();
			return createElement(
				"div",
				{ ref },
				show ? createElement("diffs-container") : null
			);
		}
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		act(() => root.render(createElement(Preview, { show: false })));
		act(() => root.render(createElement(Preview, { show: true })));
		const host = container.querySelector("diffs-container");
		const shadow = host?.shadowRoot;
		expect(shadow).toBeTruthy();
		if (!shadow) {
			return;
		}
		await settle();
		shadow.innerHTML = DIFF_SHADOW;
		await settle();
		expect(text(shadow, "[data-unmodified-lines]")).toBe("12 行の変更なし");
		expect(text(shadow, "code > span")).toBe("Search");
		act(() => root.unmount());
	});
});
