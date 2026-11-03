import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

// The canvas, mind-map and flow zoom readouts print their level through
// formatPercent: "150 %" for German readers instead of a hand-built "150%".
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { FlowZoomToolbar } = await import("./flow-interface-controls.tsx");
const { MindmapControls } = await import("./mindmap-parts.tsx");
const { CanvasToolbar } = await import("./canvas-toolbar.tsx");

const DE_ZOOM = "150 %";
const noop = () => undefined;

let mounted: { container: HTMLElement; root: Root } | undefined;
async function unmount(): Promise<void> {
	if (mounted) {
		const { container, root } = mounted;
		await act(async () => {
			root.unmount();
		});
		container.remove();
		mounted = undefined;
	}
}
afterEach(unmount);
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function renderIn(locale: string, node: ReactNode): Promise<string> {
	await unmount();
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
	return container.textContent ?? "";
}

test("flow zoom toolbar uses the reader's percent format", async () => {
	const node = (
		<FlowZoomToolbar
			fitToScreen={noop}
			shown={{ k: 1.5, x: 0, y: 0 }}
			zoomBy={noop}
		/>
	);
	expect(await renderIn("de", node)).toContain(DE_ZOOM);
	expect(await renderIn("en", node)).toContain("150%");
});

test("mind-map zoom readout uses the reader's percent format", async () => {
	const text = await renderIn(
		"de",
		<MindmapControls
			allFolded={false}
			modKey="Ctrl"
			onFit={noop}
			onResetZoom={noop}
			onToggleAll={noop}
			onZoomIn={noop}
			onZoomOut={noop}
			zoom={1.5}
		/>
	);
	expect(text).toContain(DE_ZOOM);
});

test("canvas zoom menu trigger uses the reader's percent format", async () => {
	const text = await renderIn(
		"de",
		<CanvasToolbar
			canReset={false}
			canZoomToSelection={false}
			disabled={false}
			onFit={noop}
			onNewThread={noop}
			onResetLayout={noop}
			onResetZoom={noop}
			onTool={noop}
			onZoom={noop}
			onZoomToSelection={noop}
			tool="select"
			zoom={1.5}
		/>
	);
	expect(text).toContain(DE_ZOOM);
});
