// The install-time publisher-health card under a German UI: the verdicts
// beside the trust labels must translate with them, the capability count goes
// through a plural message, and the rating uses the locale's decimal comma.

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
const { PublisherHealthCard } = await import("./publisher-health-card.tsx");

const DE: Record<string, string> = {
	"Publisher identity": "Identität des Herausgebers",
	"Not verified": "Nicht verifiziert",
	"Not reviewed": "Nicht geprüft",
	"Checksum not reported": "Prüfsumme nicht angegeben",
	"{count, plural, one {# requested} other {# requested}}":
		"{count, plural, one {# angefordert} other {# angefordert}}",
	"{average} / 5 ({count})": "{average} / 5 ({count})",
};

const AR: Record<string, string> = {
	"Not verified": "غير موثّق",
	"{count, plural, one {# requested} other {# requested}}":
		"{count, plural, zero {لا شيء مطلوب} one {# مطلوب} two {# مطلوبان} few {# مطلوبة} many {# مطلوبًا} other {# مطلوب}}",
	"{average} / 5 ({count})": "{average} / ٥ ({count})",
};

const roots: Root[] = [];

async function renderCard(locale: string, catalog: Record<string, string>) {
	registerLiteralCatalogLoader(() => catalog);
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
				<PublisherHealthCard
					capabilities={["net", "fs", "tools"]}
					publisherTrust="dotted"
					ratingAverage={4.25}
					ratingCount={1200}
					reviewed={false}
				/>
			</I18nProvider>
		);
	});
	return mount.textContent ?? "";
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

describe("PublisherHealthCard under de and ar", () => {
	test("renders verdicts, counts and the rating in German", async () => {
		const text = await renderCard("de", DE);
		expect(text).toContain("Identität des Herausgebers");
		expect(text).toContain("Nicht verifiziert");
		expect(text).toContain("Nicht geprüft");
		expect(text).toContain("Prüfsumme nicht angegeben");
		expect(text).toContain("3 angefordert");
		expect(text).toContain("4,3 / 5 (1.200)");
		expect(text).not.toContain("Not verified");
		expect(text).not.toContain("requested");
	});

	test("uses the Arabic plural category and the ar number format", async () => {
		const text = await renderCard("ar", AR);
		expect(text).toContain("غير موثّق");
		expect(text).toContain("3 مطلوبة");
		expect(text).toContain("4.3 / ٥ (1,200)");
		expect(text).not.toContain("requested");
		expect(text).not.toContain("Not verified");
	});
});
