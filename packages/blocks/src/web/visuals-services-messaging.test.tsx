import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

// The Ryu Messaging product visual's status column reads every state in the
// reader's language: "held" and "settled" are catalog keys like "delivered".
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { MessagingVisual } = await import("./visuals-services.tsx");

const JA: Record<string, string> = {
	delivered: "配信済み",
	held: "保留",
	settled: "精算済み",
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

async function statesIn(locale: string): Promise<string[]> {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("ja") ? JA : {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				<MessagingVisual />
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return [
		...container.querySelectorAll(".font-mono.text-muted-foreground\\/70"),
	].map((node) => node.textContent ?? "");
}

test("Japanese translates every message state", async () => {
	expect(await statesIn("ja")).toEqual(["配信済み", "保留", "精算済み"]);
});

test("English keeps the state words", async () => {
	expect(await statesIn("en")).toEqual(["delivered", "held", "settled"]);
});
