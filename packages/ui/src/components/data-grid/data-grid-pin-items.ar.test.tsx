// End-to-end check of the pin labels in Arabic. The shipped ar catalog
// translates "Pin to left" / "Pin to right" literally (اليسار / اليمين), and
// `getColumnPinningStyle` sticks TanStack's "left" (inline-start) pin to the
// right edge under dir="rtl". The label must therefore name the right edge
// for that row, or an Arabic reader is told the column goes to the opposite
// side from where it lands.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { GridColumnMetrics } from "@ryu/ui/lib/data-grid.ts";
import { getColumnPinningStyle } from "@ryu/ui/lib/data-grid.ts";
import { act } from "react";
import type { Root } from "react-dom/client";

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

const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { DataGridPinLabel } = await import("./data-grid-pin-items.tsx");

const PIN_KEYS = [
	"Pin to left",
	"Pin to right",
	"Unpin from left",
	"Unpin from right",
] as const;

/** The four pin entries exactly as the shipped ar catalog has them. */
function arPinMessages(): Record<string, string> {
	const catalog = JSON.parse(
		readFileSync(
			resolve(import.meta.dirname, "../../../../i18n/locales/ar.json"),
			"utf8"
		)
	) as Record<string, string>;
	const messages: Record<string, string> = {};
	for (const key of PIN_KEYS) {
		const value = catalog[key];
		if (typeof value === "string") {
			messages[key] = value;
		}
	}
	return messages;
}

const AR = arPinMessages();
const AR_LEFT = "اليسار";
const AR_RIGHT = "اليمين";

const roots: Root[] = [];
afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.innerHTML = "";
});

async function renderArabic(
	side: "left" | "right",
	pinned: boolean
): Promise<string> {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ar") ? AR : {}));
	const mount = document.createElement("div");
	document.body.append(mount);
	const root = createRoot(mount);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="ar"
				initialPackId={null}
			>
				<DataGridPinLabel dir="rtl" pinned={pinned} side={side} />
			</I18nProvider>
		);
		await Bun.sleep(50);
	});
	return mount.textContent ?? "";
}

/** The physical edge the pinning style sticks a `side` pin to under rtl. */
function rtlStyledEdge(side: "left" | "right"): "left" | "right" {
	const column = {
		getAfter: () => 0,
		getIsFirstColumn: () => true,
		getIsLastColumn: () => true,
		getIsPinned: () => side,
		getSize: () => 120,
		getStart: () => 0,
	} as unknown as GridColumnMetrics<unknown>;
	const style = getColumnPinningStyle({ column, dir: "rtl" });
	return style["--data-grid-pin-left"] === undefined ? "right" : "left";
}

describe("data-grid pin labels in Arabic", () => {
	test("the shipped ar catalog names the physical side literally", () => {
		expect(Object.keys(AR).sort()).toEqual([...PIN_KEYS].sort());
		expect(AR["Pin to left"]).toContain(AR_LEFT);
		expect(AR["Pin to right"]).toContain(AR_RIGHT);
	});

	for (const pinned of [false, true]) {
		for (const side of ["left", "right"] as const) {
			test(`${pinned ? "unpin" : "pin"} row for the ${side} pin names the edge it lands on`, async () => {
				const text = await renderArabic(side, pinned);
				const edge = rtlStyledEdge(side);
				const expected = edge === "left" ? AR_LEFT : AR_RIGHT;
				const wrong = edge === "left" ? AR_RIGHT : AR_LEFT;
				expect(text).toContain(expected);
				expect(text).not.toContain(wrong);
				expect(text).not.toMatch(/[A-Za-z]/);
			});
		}
	}
});
