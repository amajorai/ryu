import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register({ url: "https://ryu.test/" });
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { default: ScratchCard } = await import("./scratch-card.tsx");

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
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

test("the default reveal announcement is read in the reader's language", async () => {
	registerLiteralCatalogLoader((locale) =>
		locale === "ja"
			? { "Your offer is revealed.": "特典が表示されました。" }
			: null
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="ja"
				initialPackId={null}
			>
				<ScratchCard code="RYU10" discountLabel="10%" />
			</I18nProvider>
		);
	});
	const reveal = [...container.querySelectorAll("button")].find((button) =>
		button.textContent?.includes("Reveal code")
	);
	if (!reveal) {
		throw new Error("The card did not offer a reveal button");
	}
	await act(async () => {
		reveal.click();
	});
	expect(container.querySelector(".sr-only")?.textContent).toBe(
		"特典が表示されました。"
	);
});
