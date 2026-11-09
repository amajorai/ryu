import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { NewCampaignDialog } = await import("./new-campaign-dialog.tsx");

// The catalog's bare "Brief" is the adjective (簡潔, "concise"); the field is
// the campaign brief creators work from.
const JA: Record<string, string> = {
	Brand: "ブランド",
	Brief: "簡潔",
	"Campaign brief": "キャンペーン概要",
};

const roots: Root[] = [];

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	registerLiteralCatalogLoader(null);
});

test("the Japanese new-campaign dialog labels the brief as a campaign brief", async () => {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider initialLocale="ja" initialPackId={null}>
				<NewCampaignDialog
					onCreated={() => undefined}
					onOpenChange={() => undefined}
					open
					platforms={[]}
				/>
			</I18nProvider>
		);
	});
	// Let the catalog load and the DOM localizer pass settle.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});

	const label = document.querySelector('label[for="ugc-campaign-brief"]');
	expect(label?.textContent).toBe("キャンペーン概要");
	// The localizer did run: the brand label beside it is translated.
	expect(
		document.querySelector('label[for="ugc-campaign-brand"]')?.textContent
	).toBe("ブランド");
	expect(document.body.textContent).not.toContain("簡潔");
});
