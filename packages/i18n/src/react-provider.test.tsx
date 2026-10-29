import { afterEach, expect, test } from "bun:test";
import { act } from "react";

import { registerTestDom } from "./test-dom-env.ts";

await registerTestDom();
const { loadReactDomClient } = await import("./test-dom-env.ts");
const { createRoot } = await loadReactDomClient();
const { I18nProvider, useI18n } = await import("./react.tsx");
const { registerLiteralCatalogLoader } = await import("./literal-catalog.ts");

registerLiteralCatalogLoader((locale) =>
	locale.startsWith("de") ? { "Ripple mode": "Ripple-Modus" } : null
);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForText(element: Element, text: string): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (element.textContent === text) {
			return;
		}
		await act(async () => {
			await wait(10);
		});
	}
}

function LocaleProbe() {
	const { locale } = useI18n();
	return <b data-locale={locale}>Ripple mode</b>;
}

afterEach(() => {
	document.body.innerHTML = "";
	document.documentElement.removeAttribute("lang");
	document.documentElement.removeAttribute("dir");
	document.documentElement.style.removeProperty("--ryu-locale");
});

test("manageDocument={false} with domRoot localizes only the shadow root", async () => {
	document.documentElement.lang = "xx";
	const shadowHost = document.createElement("div");
	document.body.append(shadowHost);
	const shadow = shadowHost.attachShadow({ mode: "open" });
	const mount = document.createElement("div");
	shadow.append(mount);
	const outside = document.createElement("p");
	outside.textContent = "Ripple mode";
	document.body.append(outside);
	const root = createRoot(mount);
	await act(async () => {
		root.render(
			<I18nProvider
				domRoot={shadow}
				initialLocale="de"
				initialPackId={null}
				manageDocument={false}
			>
				<LocaleProbe />
			</I18nProvider>
		);
	});
	expect(document.documentElement.lang).toBe("xx");
	expect(document.documentElement.style.getPropertyValue("--ryu-locale")).toBe(
		""
	);
	const probe = mount.querySelector("b");
	if (!probe) {
		throw new Error("probe did not render");
	}
	await waitForText(probe, "Ripple-Modus");
	expect(probe.textContent).toBe("Ripple-Modus");
	expect(outside.textContent).toBe("Ripple mode");
	await act(async () => root.unmount());
});

test("the default provider manages the document and defers its first scan", async () => {
	const mount = document.createElement("div");
	document.body.append(mount);
	const root = createRoot(mount);
	await act(() => {
		root.render(
			<I18nProvider initialLocale="de" initialPackId={null}>
				<i>Ripple mode</i>
			</I18nProvider>
		);
	});
	expect(document.documentElement.lang).toBe("de");
	const text = mount.querySelector("i");
	if (!text) {
		throw new Error("text did not render");
	}
	// Committed but not yet scanned: hydration gets the first moment.
	expect(text.textContent).toBe("Ripple mode");
	await waitForText(text, "Ripple-Modus");
	expect(text.textContent).toBe("Ripple-Modus");
	await act(async () => root.unmount());
});

test('autoLocalizeDom="immediate" scans on mount', async () => {
	const mount = document.createElement("div");
	document.body.append(mount);
	const root = createRoot(mount);
	await act(() => {
		root.render(
			<I18nProvider
				autoLocalizeDom="immediate"
				initialLocale="de"
				initialPackId={null}
			>
				<i>Ripple mode</i>
			</I18nProvider>
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
	expect(mount.querySelector("i")?.textContent).toBe("Ripple-Modus");
	await act(async () => root.unmount());
});
