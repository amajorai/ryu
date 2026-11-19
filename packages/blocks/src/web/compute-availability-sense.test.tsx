import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

// The compute-share schedule picker ("When idle" or "On a schedule") reads
// "Availability" as the hours a node is offered (ja 提供可能時間); the bare
// catalog word is a product's availability status (ja 提供状況).
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { ComputeExchangeVisual } = await import("./visuals-desktop.tsx");
const { ProductRealmScene } = await import("./product-realm-scenes.tsx");

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

async function renderJapanese(node: ReactNode): Promise<HTMLElement> {
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
				{node}
			</I18nProvider>
		);
	});
	return container;
}

/** The keyed sense spans, which the DOM localizer leaves alone. */
const senseLabels = (container: HTMLElement) =>
	[...container.querySelectorAll('[data-ryu-i18n="off"]')].map(
		(node) => node.textContent
	);

test("the share setup visual names its schedule picker in the hours sense", async () => {
	const container = await renderJapanese(
		<ComputeExchangeVisual mode="share" />
	);
	expect(senseLabels(container)).toContain("提供可能時間");
});

test("the share realm scene names its schedule in the hours sense", async () => {
	const container = await renderJapanese(<ProductRealmScene id="share" />);
	expect(senseLabels(container)).toContain("提供可能時間");
});
