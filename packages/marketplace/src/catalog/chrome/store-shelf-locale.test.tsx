// A shelf's open button names its category: the category label is English
// catalog copy, so it is translated before it enters "Open {title}", and a
// German reader hears "Produktivität öffnen", never "Productivity öffnen".

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

const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { default: StoreShelf } = await import("./store-shelf.tsx");

const DE: Record<string, string> = {
	"Open {title}": "{title} öffnen",
	Productivity: "Produktivität",
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

async function openLabel(locale: string): Promise<string | null> {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("de") ? DE : {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale={locale}
				initialPackId={null}
			>
				<StoreShelf
					items={["one"]}
					onOpenCategory={() => undefined}
					renderItem={(item) => <span key={item}>{item}</span>}
					title="Productivity"
				/>
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	const button = container.querySelector("[aria-label]");
	return button?.getAttribute("aria-label") ?? null;
}

test("the category in the open button's name is translated", async () => {
	expect(await openLabel("de")).toBe("Produktivität öffnen");
});

test("English reads as before", async () => {
	expect(await openLabel("en")).toBe("Open Productivity");
});
