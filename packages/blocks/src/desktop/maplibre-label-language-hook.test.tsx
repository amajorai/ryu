// The label-language hook follows the UI language on a live map: a language
// switch rewrites the labels at once (even while tiles are still loading), and
// a later style swap is localized again on its style.load.

import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider, useOptionalI18n } from "@ryu/i18n/react";
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { useMaplibreLabelLanguage } = await import("./maplibre-labels.ts");
type LabelLanguageMap = import("./maplibre-labels.ts").LabelLanguageMap;

const ORIGINAL = ["coalesce", ["get", "name_en"], ["get", "name"]];

function fakeMap() {
	let layout: Record<string, unknown> = { "text-field": ORIGINAL };
	const listeners = new Set<() => void>();
	const map: LabelLanguageMap = {
		getLayoutProperty: (_id, name) => layout[name],
		getStyle: () => ({ layers: [{ id: "place", type: "symbol" }] }),
		off: (_type, listener) => listeners.delete(listener),
		on: (_type, listener) => listeners.add(listener),
		setLayoutProperty: (_id, name, value) => {
			layout = { ...layout, [name]: value };
		},
	};
	return {
		field: () => JSON.stringify(layout["text-field"]),
		listeners,
		map,
		swapStyle: () => {
			layout = { "text-field": ORIGINAL };
			for (const listener of listeners) {
				listener();
			}
		},
	};
}

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

test("follows language switches and style swaps, and detaches on unmount", async () => {
	const fake = fakeMap();
	let switchTo: (locale: string) => void = () => undefined;
	function Host() {
		const ref = useRef<LabelLanguageMap | null>(fake.map);
		const i18n = useOptionalI18n();
		switchTo = (locale) => i18n?.setLocale(locale);
		useMaplibreLabelLanguage(ref);
		return null;
	}
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale="ja" initialPackId={null}>
				<Host />
			</I18nProvider>
		);
	});
	expect(fake.field()).toContain('"name:ja"');

	await act(async () => {
		switchTo("ar");
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	expect(fake.field()).toContain('"name:ar"');
	expect(fake.listeners.size).toBe(1);

	fake.swapStyle();
	expect(fake.field()).toContain('"name:ar"');

	await act(async () => {
		root.unmount();
	});
	mounted = undefined;
	container.remove();
	expect(fake.listeners.size).toBe(0);
});
