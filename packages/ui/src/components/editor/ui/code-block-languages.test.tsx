import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { LiteralMessage } from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";

// Language names ("Less", "Reason", "Flow") are proper names: the DOM
// localizer must not swap in the ordinary word. "Auto" and "Plain Text" are
// worded choices and do translate.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
const { I18nRuntime, registerLiteralCatalogLoader } = await import(
	"@ryu/i18n/core"
);
const { localizeDomRoot } = await import("@ryu/i18n/react");
const { codeBlockLanguageText, codeBlockLanguages, getCodeBlockLanguageLabel } =
	await import("./code-block-languages.tsx");

const JA: Record<string, string> = {
	Auto: "自動",
	Flow: "流れ",
	Less: "少なく",
	"Plain Text": "プレーンテキスト",
	Reason: "理由",
};

let cleanup: (() => void) | undefined;
afterEach(() => {
	registerLiteralCatalogLoader(null);
	cleanup?.();
	cleanup = undefined;
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

function language(value: string) {
	const found = codeBlockLanguages.find((entry) => entry.value === value);
	if (!found) {
		throw new Error(`no language ${value}`);
	}
	return found;
}

async function localized(html: string) {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
	const container = document.createElement("div");
	container.innerHTML = html;
	document.body.append(container);
	const runtime = new I18nRuntime([], {
		initialLocale: "ja",
		initialPackId: null,
	});
	const stop = localizeDomRoot(runtime, container);
	cleanup = () => {
		stop();
		container.remove();
	};
	await new Promise((resolve) => setTimeout(resolve, 20));
	return container;
}

test("language names stay as written while Auto translates", async () => {
	const values = ["auto", "plaintext", "less", "reasonml", "flow"];
	const html = values
		.map(
			(value) =>
				`<li id="${value}">${renderToStaticMarkup(
					codeBlockLanguageText(language(value))
				)}</li>`
		)
		.join("");
	const container = await localized(`<ul>${html}</ul>`);
	const text = (id: string) => container.querySelector(`#${id}`)?.textContent;
	expect(text("auto")).toBe("自動");
	expect(text("plaintext")).toBe("プレーンテキスト");
	expect(text("less")).toBe("Less");
	expect(text("reasonml")).toBe("Reason");
	expect(text("flow")).toBe("Flow");
});

test("a given tl translates only the worded choices", () => {
	const tl: LiteralMessage = (source) => JA[source] ?? source;
	expect(codeBlockLanguageText(language("auto"), tl)).toBe("自動");
	expect(codeBlockLanguageText(language("plaintext"), tl)).toBe(
		"プレーンテキスト"
	);
	const less = renderToStaticMarkup(
		codeBlockLanguageText(language("less"), tl)
	);
	expect(less).toBe('<span data-ryu-i18n="off">Less</span>');
});

test("an unknown language falls back to its raw value", () => {
	expect(getCodeBlockLanguageLabel("zig")).toBe("zig");
	expect(getCodeBlockLanguageLabel("  ")).toBeNull();
	expect(getCodeBlockLanguageLabel("less")).toBe("Less");
});
