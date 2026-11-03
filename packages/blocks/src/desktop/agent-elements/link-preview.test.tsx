// The file-link hover card's "Preview unavailable" fallback. The DOM localizer
// skips <pre>, so the fallback must translate itself and sit outside the <pre>
// that holds a file's snippet.

import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { I18nProvider } = await import("@ryu/i18n/react");
const { FilePreviewCard } = await import("./link-preview.tsx");

const AR: Record<string, string> = {
	"Preview unavailable": "المعاينة غير متاحة",
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

async function renderIn(locale: string, node: ReactNode): Promise<HTMLElement> {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("ar") ? AR : {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				{node}
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return container;
}

test("a missing snippet shows the translated fallback outside the <pre>", async () => {
	const container = await renderIn(
		"ar",
		<FilePreviewCard data={null} path="/tmp/notes.md" />
	);
	expect(container.textContent).toContain("المعاينة غير متاحة");
	expect(container.textContent).not.toContain("Preview unavailable");
	expect(container.querySelector("pre")).toBeNull();
});

test("a snippet renders verbatim inside the <pre>", async () => {
	const container = await renderIn(
		"ar",
		<FilePreviewCard data={{ snippet: "const x = 1;" }} path="/tmp/a.ts" />
	);
	expect(container.querySelector("pre")?.textContent).toBe("const x = 1;");
	expect(container.textContent).not.toContain("المعاينة غير متاحة");
});
