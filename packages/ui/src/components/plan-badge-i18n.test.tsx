import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// The badge translates its mixed-case catalog label and lets CSS upper-case
// it, so a translated tier never falls back to "ENTERPRISE" in JavaScript.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { PlanBadge } = await import("./plan-badge.tsx");

const JA: Record<string, string> = {
	Enterprise: "エンタープライズ",
	"One-time": "買い切り",
	"Ryu Enterprise": "Ryu エンタープライズ",
};

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
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function renderJa(node: React.ReactNode): Promise<HTMLElement> {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale="ja" initialPackId={null}>
				{node}
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return container;
}

test("the Enterprise badge shows the Japanese tier name", async () => {
	const container = await renderJa(<PlanBadge plan="enterprise" size="md" />);
	expect(container.textContent).toBe("エンタープライズ");
	expect(container.textContent).not.toContain("ENTERPRISE");
	expect(container.querySelector("[title]")?.getAttribute("title")).toBe(
		"Ryu エンタープライズ"
	);
	expect(container.innerHTML).toContain("uppercase");
});

test("a caller's literal label is translated too", async () => {
	const container = await renderJa(
		<PlanBadge label="One-time" plan="desktop-license" size="md" />
	);
	expect(container.textContent).toBe("買い切り");
});
