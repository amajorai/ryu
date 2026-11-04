// The Apps detail panel grades the listing once and hands that scorecard to the
// Health badge, the aside and the Health tab. The grade is translated when it
// runs, so the memo must follow the UI language: switching languages while a
// listing stays open regrades it instead of keeping the previous language's
// summary in the badge's accessible name and tooltip.

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
const { CatalogHostProvider } = await import("./host.tsx");
const { AppDetailPanel } = await import(
	"./apps-catalog-section-detail-panel.tsx"
);

const FAILED =
	"{failures, plural, one {# failed check} other {# failed checks}} — read them before installing.";
const DE: Record<string, string> = {
	[FAILED]:
		"{failures, plural, one {# fehlgeschlagene Prüfung} other {# fehlgeschlagene Prüfungen}} – vor der Installation lesen.",
};
const EN_SUMMARY = "2 failed checks — read them before installing.";
const DE_SUMMARY = "2 fehlgeschlagene Prüfungen – vor der Installation lesen.";

const DESCRIPTION = "A plugin that does a specific, clearly explained thing.";
const ITEM = {
	enabled: false,
	entry: {
		description: DESCRIPTION,
		id: "com.example.thing",
		kinds: ["tool"],
		name: "Thing",
		tags: [],
	},
	grants: [],
	installed: false,
};
const DETAIL = { description: DESCRIPTION, origin: "community", stars: 1 };

const HOST = {
	ActiveModelControl: () => null,
	install: null,
	Markdown: ({ content }: { content: string }) => <p>{content}</p>,
	openExternal: () => undefined,
	renderAffordance: () => null,
	useActiveNode: () => ({ token: null, url: "" }),
	useInterfaceLevel: () => "expert",
};

const roots: Root[] = [];
let switchLocale: ((locale: string) => void) | null = null;

function LocaleSwitch() {
	switchLocale = useI18n().setLocale;
	return null;
}

/** Every accessible name, tooltip and text run the panel rendered. */
function renderedCopy(mount: HTMLElement): string {
	const attributes = [...mount.querySelectorAll("[aria-label],[title]")].map(
		(node) =>
			`${node.getAttribute("aria-label") ?? ""}\n${node.getAttribute("title") ?? ""}`
	);
	return `${mount.textContent ?? ""}\n${attributes.join("\n")}`;
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

test("regrades the listing's Health summary when the UI language changes", async () => {
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
				<CatalogHostProvider host={HOST as never}>
					<LocaleSwitch />
					<AppDetailPanel
						detail={DETAIL as never}
						detailError={null}
						detailLoading={false}
						error={null}
						install={() => Promise.resolve()}
						installLayer={null}
						isInstalling={() => false}
						item={ITEM as never}
						lifecyclePending={false}
						noun="app"
						renderAffordance={() => null}
						selectedId={ITEM.entry.id}
						setEnabled={() => Promise.resolve()}
						settingsOpener={() => null}
					/>
				</CatalogHostProvider>
			</I18nProvider>
		);
	});
	expect(renderedCopy(mount)).toContain(EN_SUMMARY);

	await act(async () => {
		switchLocale?.("de");
		await Bun.sleep(50);
	});
	const copy = renderedCopy(mount);
	expect(copy).toContain(DE_SUMMARY);
	expect(copy).not.toContain("read them before installing");
});
