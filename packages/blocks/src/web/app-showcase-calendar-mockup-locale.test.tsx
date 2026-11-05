// The website's Calendar mockup under a German and a US English UI: its weekday
// header uses the reader's narrow weekday names from the reader's first weekday.

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
const { CalendarMockup } = await import("./app-showcase-workspace-mockups.tsx");

const roots: Root[] = [];

async function renderHeader(locale: string): Promise<string> {
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
				<CalendarMockup />
			</I18nProvider>
		);
	});
	const header = mount.querySelector(".grid-cols-7");
	return Array.from(header?.children ?? [], (cell) => cell.textContent).join(
		" "
	);
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

describe("CalendarMockup weekday header", () => {
	test("German starts on Monday with German initials", async () => {
		expect(await renderHeader("de")).toBe("M D M D F S S");
	});

	test("US English starts on Sunday", async () => {
		expect(await renderHeader("en-US")).toBe("S M T W T F S");
	});
});
