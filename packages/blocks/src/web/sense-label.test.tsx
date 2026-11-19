import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const { I18nProvider } = await import("@ryu/i18n/react");
const { SenseLabel } = await import("./sense-label.tsx");

let mounted: { container: HTMLElement; root: Root } | undefined;
afterEach(async () => {
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
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

test("outside a provider the English word renders, opted out of the localizer", () => {
	expect(
		renderToStaticMarkup(<SenseLabel id="kb.guideKind">Guide</SenseLabel>)
	).toBe('<span data-ryu-i18n="off">Guide</span>');
});

test("a Japanese pack reads the guide article noun, not the bare verb", async () => {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="ja"
				initialPackId="official/ja"
			>
				<SenseLabel id="kb.guideKind">Guide</SenseLabel>
			</I18nProvider>
		);
	});
	expect(container.textContent).toBe("ガイド");
});
