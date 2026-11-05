// The read-only StarRating under a German and an Arabic UI: the average inside
// its accessible name uses the locale's decimal separator and digits, the same
// as the visible average beside the stars.

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
const { StarRating } = await import("./star-rating.tsx");

const roots: Root[] = [];

async function renderLabel(locale: string, value: number): Promise<string> {
	registerLiteralCatalogLoader(() => ({}));
	const mount = document.createElement("div");
	document.body.append(mount);
	const root = createRoot(mount);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale={locale}
				initialPackId={null}
			>
				<StarRating value={value} />
			</I18nProvider>
		);
	});
	return mount.querySelector("[role=img]")?.getAttribute("aria-label") ?? "";
}

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await act(async () => {
			root.unmount();
		});
	}
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

describe("StarRating accessible name under de and ar", () => {
	test("German uses a decimal comma", async () => {
		const label = await renderLabel("de", 4.25);
		expect(label).toContain("4,3");
		expect(label).not.toContain("4.3");
	});

	test("Arabic uses Arabic digits", async () => {
		const label = await renderLabel("ar-EG", 4.25);
		expect(label).toContain("٤٫٣");
		expect(label).not.toContain("4.3");
	});

	test("a whole rating keeps no trailing decimal", async () => {
		const label = await renderLabel("de", 4);
		expect(label).toContain(" 4 ");
		expect(label).not.toContain("4,0");
	});
});
