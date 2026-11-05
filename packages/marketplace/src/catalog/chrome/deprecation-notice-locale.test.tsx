// The deprecation notice under ja and de: "Use {replacement} instead." is one
// rich message, so a verb-final language reads one grammatical sentence with
// the replacement id inside the code chip, never two stitched fragments.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { default: DeprecationNotice } = await import("./deprecation-notice.tsx");

const CATALOGS: Record<string, Record<string, string>> = {
	de: {
		// The old fragment keys: a split sentence would render these.
		"instead.": "verwenden.",
		Use: "Verwenden Sie",
		"Use <code>{replacement}</code> instead.":
			"Verwenden Sie stattdessen <code>{replacement}</code>.",
	},
	ar: {
		// Old fragments again: the DOM localizer must not stitch them back in.
		"instead.": "بدلاً من ذلك.",
		Use: "لعناصر نائبة مسماة",
		"Use <code>{replacement}</code> instead.":
			"استخدم <code>{replacement}</code> بدلاً من ذلك.",
	},
	ja: {
		Use: "名前付きプレースホルダーには",
		"Use <code>{replacement}</code> instead.":
			"代わりに <code>{replacement}</code> を使用してください。",
	},
};

const roots: Root[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await act(async () => {
			root.unmount();
		});
	}
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

async function mount(
	locale: string,
	autoLocalizeDom: false | "immediate" = false
): Promise<HTMLDivElement> {
	registerLiteralCatalogLoader(() => CATALOGS[locale] ?? {});
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={autoLocalizeDom}
				initialLocale={locale}
				initialPackId={null}
			>
				<DeprecationNotice
					message="Superseded."
					name="Old Tool"
					replacement="@acme/new"
				/>
			</I18nProvider>
		);
	});
	return host;
}

describe("DeprecationNotice replacement sentence", () => {
	test("ja renders one translated sentence around the code chip", async () => {
		const host = await mount("ja");
		expect(host.textContent).toContain(
			"代わりに @acme/new を使用してください。"
		);
		expect(host.textContent).not.toContain("名前付きプレースホルダー");
		expect(host.querySelector("code")?.textContent).toBe("@acme/new");
	});

	test("de keeps one grammatical sentence, not stitched fragments", async () => {
		const host = await mount("de");
		expect(host.textContent).toContain("Verwenden Sie stattdessen @acme/new.");
		expect(host.textContent).not.toContain("verwenden.");
		expect(host.querySelector("code")?.textContent).toBe("@acme/new");
	});

	test("ar under the live DOM localizer keeps one sentence", async () => {
		const host = await mount("ar", "immediate");
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
		expect(host.textContent).toContain("استخدم @acme/new بدلاً من ذلك.");
		expect(host.textContent).not.toContain("لعناصر نائبة مسماة");
		expect(host.querySelector("code")?.textContent).toBe("@acme/new");
	});

	test("en keeps the source sentence", async () => {
		const host = await mount("en");
		expect(host.textContent).toContain("Use @acme/new instead.");
	});
});
