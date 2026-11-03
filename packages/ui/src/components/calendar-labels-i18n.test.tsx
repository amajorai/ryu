import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { messageIdForLiteral } = await import("@ryu/i18n/core");
const { I18nProvider } = await import("@ryu/i18n/react");
const { Calendar } = await import("./calendar.tsx");

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

/** Render on the client (the display locale is a client-only store) and return the markup. */
async function render(node: ReactNode): Promise<string> {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(node);
	});
	return container.innerHTML;
}

// DayPicker's navigation names (the previous/next month buttons, the nav
// region and the month/year dropdowns) are accessible labels, so they follow
// the display language like the localized month and day names beside them.
const JAPANESE: Record<string, string> = {
	"Choose the Month": "月を選択",
	"Choose the Year": "年を選択",
	"Go to the Next Month": "次の月へ",
	"Go to the Previous Month": "前の月へ",
	"Navigation bar": "ナビゲーション",
};

const PACK = {
	baseLocale: "ja",
	direction: "ltr" as const,
	id: "community/calendar-ja",
	locale: "ja",
	messages: Object.fromEntries(
		Object.entries(JAPANESE).map(([english, japanese]) => [
			messageIdForLiteral(english),
			japanese,
		])
	),
	name: "Calendar labels",
	schemaVersion: 1 as const,
	version: "1.0.0",
};

const june = new Date(2026, 5, 1);

describe("Calendar navigation labels", () => {
	test("read in the display language", async () => {
		const html = await render(
			<I18nProvider initialPackId={PACK.id} packs={[PACK]}>
				<Calendar
					captionLayout="dropdown"
					defaultMonth={june}
					endMonth={new Date(2027, 11, 1)}
					startMonth={new Date(2025, 0, 1)}
				/>
			</I18nProvider>
		);
		for (const label of [
			"前の月へ",
			"次の月へ",
			"ナビゲーション",
			"月を選択",
			"年を選択",
		]) {
			expect(html).toContain(`aria-label="${label}"`);
		}
		for (const english of Object.keys(JAPANESE)) {
			expect(html).not.toContain(`aria-label="${english}"`);
		}
	});

	test("are literal calls the catalog extractor collects", async () => {
		// A variable argument (`useLocalizedString(english.nextMonth)`) left the
		// labels out of every catalog, so no language pack could translate them.
		const extractor: {
			extractFromSource: (path: string, source: string) => Iterable<string>;
		} = await import(
			new URL("../../../../tools/i18n-extract/visitor.mjs", import.meta.url)
				.href
		);
		const source = await Bun.file(
			new URL("./calendar.tsx", import.meta.url)
		).text();
		const collected = new Set(
			extractor.extractFromSource(
				"packages/ui/src/components/calendar.tsx",
				source
			)
		);
		for (const english of Object.keys(JAPANESE)) {
			expect(collected.has(english)).toBe(true);
		}
	});

	test("keep DayPicker's English names without a language pack", async () => {
		const html = await render(<Calendar defaultMonth={june} />);
		expect(html).toContain('aria-label="Go to the Previous Month"');
		expect(html).toContain('aria-label="Go to the Next Month"');
	});
});
