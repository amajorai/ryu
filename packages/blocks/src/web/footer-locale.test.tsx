// The footer's nav labels resolve to named catalog ids ("Marketplace" →
// common.marketplace), so the German named pack must carry the catalog's
// translation rather than repeating the English word.

import { afterAll, afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
// The build row looks up the latest release; keep the test offline.
const realFetch = globalThis.fetch;
Reflect.set(
	globalThis,
	"fetch",
	async () => new Response(null, { status: 404 })
);
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { I18nProvider } = await import("@ryu/i18n/react");
const { default: Footer } = await import("./footer.tsx");

const GERMAN_CATALOG: Record<string, string> = JSON.parse(
	readFileSync(
		new URL("../../../i18n/locales/de.json", import.meta.url),
		"utf8"
	)
);

let mounted: { container: HTMLElement; root: Root } | undefined;
afterEach(async () => {
	registerLiteralCatalogLoader(null);
	if (mounted) {
		const { container, root } = mounted;
		await act(async () => {
			root.unmount();
		});
		container.remove();
		mounted = undefined;
	}
});
afterAll(async () => {
	Reflect.set(globalThis, "fetch", realFetch);
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function footerLinksIn(locale: string): Promise<string[]> {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("de") ? GERMAN_CATALOG : {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				<Footer />
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return Array.from(container.querySelectorAll("a"), (link) =>
		(link.textContent ?? "").trim()
	);
}

test("German footer translates Marketplace, Skills and Academy", async () => {
	const links = await footerLinksIn("de");
	expect(links).toContain("Marktplatz");
	expect(links).toContain("Fähigkeiten");
	expect(links).toContain("Akademie");
	expect(links).not.toContain("Marketplace");
	expect(links).not.toContain("Skills");
});

test("English footer keeps the source labels", async () => {
	const links = await footerLinksIn("en");
	expect(links).toContain("Marketplace");
	expect(links).toContain("Skills");
});
