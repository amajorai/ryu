// The Health tab's scorecard is translated when it is graded, so a memoized
// grade must follow the UI language: switching languages while the listing
// stays open regrades it instead of keeping the previous language's summary.

import { afterAll, afterEach, expect, test } from "bun:test";
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

const { I18nProvider, useI18n } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { ListingDetailTabs } = await import("./listing-detail-tabs.tsx");

const FAILED =
	"{failures, plural, one {# failed check} other {# failed checks}} — read them before installing.";
const DE: Record<string, string> = {
	[FAILED]:
		"{failures, plural, one {# fehlgeschlagene Prüfung} other {# fehlgeschlagene Prüfungen}} – vor der Installation lesen.",
};

const DESCRIPTION = "A plugin that does a specific, clearly explained thing.";
const ENTRY = {
	description: DESCRIPTION,
	id: "com.example.thing",
	kinds: ["tool"],
	name: "Thing",
	tags: [],
};
const DETAIL = { description: DESCRIPTION, origin: "community", stars: 1 };

const roots: Root[] = [];
let switchLocale: ((locale: string) => void) | null = null;

function LocaleSwitch() {
	switchLocale = useI18n().setLocale;
	return null;
}

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await act(async () => {
			root.unmount();
		});
	}
	registerLiteralCatalogLoader(null);
	switchLocale = null;
	document.body.innerHTML = "";
});

test("regrades the Health tab summary when the UI language changes", async () => {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("de") ? DE : {}));
	const mount = document.createElement("div");
	document.body.append(mount);
	const root = createRoot(mount);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="en"
				initialPackId={null}
			>
				<LocaleSwitch />
				<ListingDetailTabs
					activeTab="health"
					detail={DETAIL as never}
					entry={ENTRY as never}
					Markdown={({ content }) => <p>{content}</p>}
				/>
			</I18nProvider>
		);
	});
	expect(mount.textContent).toContain(
		"2 failed checks — read them before installing."
	);

	await act(async () => {
		switchLocale?.("de");
		await Bun.sleep(50);
	});
	expect(mount.textContent).toContain(
		"2 fehlgeschlagene Prüfungen – vor der Installation lesen."
	);
	expect(mount.textContent).not.toContain("read them before installing");
});
