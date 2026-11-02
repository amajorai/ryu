import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

// End to end: a real `<ReactFlow>` and MapLibre string table under a
// translated locale show the translated chrome, and English is unchanged.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { Controls, MiniMap, ReactFlow, ReactFlowProvider } = await import(
	"@xyflow/react"
);
const { useReactFlowAriaLabels } = await import("./react-flow-labels.ts");
const { useMaplibreLocale } = await import("./maplibre-labels.ts");

const LIVE =
	"{direction, select, up {Moved selected node up. New position, x: {x}, y: {y}} down {Moved selected node down. New position, x: {x}, y: {y}} left {Moved selected node left. New position, x: {x}, y: {y}} right {Moved selected node right. New position, x: {x}, y: {y}} other {Moved selected node. New position, x: {x}, y: {y}}}";

const CATALOGS: Record<string, Record<string, string>> = {
	ar: {
		"Fit View": "ملاءمة العرض",
		[LIVE]:
			"{direction, select, up {نُقلت العقدة المحددة إلى الأعلى. الموضع الجديد، x: {x}، y: {y}} down {نُقلت العقدة المحددة إلى الأسفل. الموضع الجديد، x: {x}، y: {y}} left {نُقلت العقدة المحددة إلى اليسار. الموضع الجديد، x: {x}، y: {y}} right {نُقلت العقدة المحددة إلى اليمين. الموضع الجديد، x: {x}، y: {y}} other {نُقلت العقدة المحددة. الموضع الجديد، x: {x}، y: {y}}}",
	},
	de: {
		"Zoom in": "Vergrößern",
		"Zoom In": "Vergrößern",
	},
	ja: {
		"Control Panel": "コントロールパネル",
		"Fit View": "全体を表示",
		"Mini Map": "ミニマップ",
	},
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
	const catalog = CATALOGS[locale] ?? {};
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith(locale) ? catalog : {}
	);
	const container = document.createElement("div");
	container.style.width = "400px";
	container.style.height = "300px";
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

const probe: {
	live?: (params: { direction: string; x: number; y: number }) => string;
	map?: Record<string, string>;
} = {};

function Flow() {
	const labels = useReactFlowAriaLabels();
	probe.live = labels[
		"node.a11yDescription.ariaLiveMessage"
	] as typeof probe.live;
	probe.map = useMaplibreLocale();
	return (
		<ReactFlowProvider>
			<div style={{ height: 300, width: 400 }}>
				<ReactFlow ariaLabelConfig={labels} edges={[]} nodes={[]}>
					<Controls />
					<MiniMap />
				</ReactFlow>
			</div>
		</ReactFlowProvider>
	);
}

function attr(container: HTMLElement, selector: string, name: string) {
	return container.querySelector(selector)?.getAttribute(name) ?? null;
}

test("Japanese: React Flow's controls and minimap read in Japanese", async () => {
	const container = await renderIn("ja", <Flow />);
	expect(attr(container, ".react-flow__controls", "aria-label")).toBe(
		"コントロールパネル"
	);
	expect(attr(container, ".react-flow__controls-fitview", "title")).toBe(
		"全体を表示"
	);
	expect(container.innerHTML).toContain("ミニマップ");
	expect(container.innerHTML).not.toContain("Fit View");
});

test("Arabic: the keyboard-move announcement is one translated sentence", async () => {
	const container = await renderIn("ar", <Flow />);
	expect(attr(container, ".react-flow__controls-fitview", "title")).toBe(
		"ملاءمة العرض"
	);
	const sentence = probe.live?.({ direction: "left", x: 12, y: 4 }) ?? "";
	expect(sentence).toContain("نُقلت العقدة المحددة إلى اليسار");
	expect(sentence).not.toContain("left");
});

test("German: MapLibre and React Flow zoom labels are translated", async () => {
	const container = await renderIn("de", <Flow />);
	expect(attr(container, ".react-flow__controls-zoomin", "title")).toBe(
		"Vergrößern"
	);
	expect(probe.map?.["NavigationControl.ZoomIn"]).toBe("Vergrößern");
});

test("English keeps the library's own wording", async () => {
	const container = await renderIn("en", <Flow />);
	expect(attr(container, ".react-flow__controls-fitview", "title")).toBe(
		"Fit View"
	);
	expect(probe.live?.({ direction: "up", x: 1, y: 2 })).toBe(
		"Moved selected node up. New position, x: 1, y: 2"
	);
	expect(probe.map?.["Popup.Close"]).toBe("Close popup");
});
