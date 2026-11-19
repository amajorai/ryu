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
const { ComputeShareSurface } = await import("./ComputeShareSurface.tsx");

const JA: Record<string, string> = { "Intended contract": "想定される契約" };

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

test("the contract grid's trailing note follows the UI language", async () => {
	registerLiteralCatalogLoader((tag) => (tag.startsWith("ja") ? JA : {}));
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="ja"
				initialPackId={null}
			>
				<ComputeShareSurface mode="compute" />
			</I18nProvider>
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
	expect(container.textContent).toContain("想定される契約");
	expect(container.textContent).not.toContain("Intended contract");
});
