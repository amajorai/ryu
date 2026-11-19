import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

// The Dashboards mockup's credit tile reads "this week" as a plain period (ja
// 今週); the bare catalog row is a pitch's deadline fragment (ja 今週中に).
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { DashboardsMockup } = await import("./app-showcase-mockups.tsx");

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

test("the dashboards mockup names a plain week, not a deadline", async () => {
	const container = await renderJapanese(<DashboardsMockup />);
	expect(senseLabels(container)).toContain("今週");
	expect(container.textContent).not.toContain("今週中に");
});
