import { afterEach, describe, expect, test } from "bun:test";
import { I18nProvider, I18nText } from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	resolveVisibleTabKeys,
	Tabs,
	TabsContent,
	TabsIndicator,
	TabsList,
	TabsTrigger,
} from "./tabs.tsx";

describe("shared tab selection indicators", () => {
	for (const manageLayout of [true, false]) {
		test(`renders one automatic indicator with layout management ${manageLayout}`, () => {
			const html = renderToStaticMarkup(
				<Tabs defaultValue="plan">
					<TabsList manageLayout={manageLayout}>
						<TabsTrigger value="plan">Plan</TabsTrigger>
						<TabsTrigger value="debug">Debug</TabsTrigger>
					</TabsList>
				</Tabs>
			);
			expect(html.match(/data-slot="tabs-indicator"/g)).toHaveLength(1);
			expect(html).toContain('aria-selected="true"');
			expect(html).toContain('aria-selected="false"');
		});
	}

	test("uses an explicitly styled indicator without adding another", () => {
		const html = renderToStaticMarkup(
			<Tabs defaultValue="yearly">
				<TabsList manageLayout={false}>
					<TabsIndicator className="bg-foreground" />
					<TabsTrigger value="monthly">Monthly</TabsTrigger>
					<TabsTrigger value="yearly">Yearly</TabsTrigger>
				</TabsList>
			</Tabs>
		);
		expect(html.match(/data-slot="tabs-indicator"/g)).toHaveLength(1);
	});

	for (const variant of ["text", "stepper"] as const) {
		test(`preserves the ${variant} treatment without a pill`, () => {
			const html = renderToStaticMarkup(
				<Tabs defaultValue="plan">
					<TabsList variant={variant}>
						<TabsTrigger value="plan">Plan</TabsTrigger>
						<TabsTrigger value="debug">Debug</TabsTrigger>
					</TabsList>
				</Tabs>
			);
			expect(html).not.toContain('data-slot="tabs-indicator"');
		});
	}
});

describe("sticky tab placement", () => {
	test("pins horizontal tabs to the bottom on mobile and the top on desktop", () => {
		const html = renderToStaticMarkup(
			<Tabs defaultValue="overview">
				<TabsList sticky stickyOffset="2rem" variant="pills">
					<TabsTrigger value="overview">Overview</TabsTrigger>
					<TabsTrigger value="activity">Activity</TabsTrigger>
				</TabsList>
				<div>
					<TabsContent value="overview">Overview panel.</TabsContent>
					<TabsContent value="activity">Activity panel.</TabsContent>
				</div>
			</Tabs>
		);

		expect(html).toContain(
			"has-[[data-slot=tabs-list-sticky]]:flex-col-reverse"
		);
		expect(html).toContain("md:has-[[data-slot=tabs-list-sticky]]:flex-col");
		expect(html).toContain("sticky bottom-0 z-20 min-w-0 shrink-0 border-t");
		expect(html).toContain("md:top-[var(--tabs-sticky-offset)] md:bottom-auto");
		expect(html).toContain("--tabs-sticky-offset:2rem");
		expect(html).toContain("bottom-full h-10 bg-linear-to-t");
		expect(html).toContain("md:top-full md:bottom-auto md:bg-linear-to-b");
	});
});

describe("managed tab row fitting", () => {
	const originalGetComputedStyle = globalThis.getComputedStyle;
	afterEach(() => {
		globalThis.getComputedStyle = originalGetComputedStyle;
	});

	test("keeps every tab in a content-sized row whose width is fractional", () => {
		// Measured from the Code Review companion's segmented Summary/Changes row:
		// the row is exactly as wide as its tabs (205.33px) but `clientWidth`
		// rounds it to 205, which used to overflow Changes into "1 more".
		globalThis.getComputedStyle = (() => ({
			borderLeftWidth: "0px",
			borderRightWidth: "0px",
			columnGap: "8px",
			paddingLeft: "3.84px",
			paddingRight: "3.84px",
		})) as unknown as typeof getComputedStyle;
		const list = {
			clientHeight: 36,
			clientWidth: 205,
			getBoundingClientRect: () => ({ height: 36, width: 205.328_125 }),
			querySelector: () => null,
		} as unknown as HTMLDivElement;

		const resolution = resolveVisibleTabKeys(list, {
			activeKey: "string:summary",
			hiddenKeys: new Set(),
			order: ["string:summary", "string:code"],
			orientation: "horizontal",
			reserveMore: false,
			widths: new Map([
				["string:summary", 82],
				["string:code", 107.671_875],
			]),
		});

		expect(resolution.keys).toEqual(["string:summary", "string:code"]);
	});

	test("still overflows a tab that misses the row by more than a sub-pixel", () => {
		globalThis.getComputedStyle = (() => ({
			borderLeftWidth: "0px",
			borderRightWidth: "0px",
			columnGap: "8px",
			paddingLeft: "4px",
			paddingRight: "4px",
		})) as unknown as typeof getComputedStyle;
		const list = {
			clientHeight: 36,
			clientWidth: 190,
			getBoundingClientRect: () => ({ height: 36, width: 190 }),
			querySelector: () => null,
		} as unknown as HTMLDivElement;

		const resolution = resolveVisibleTabKeys(list, {
			activeKey: "string:summary",
			hiddenKeys: new Set(),
			order: ["string:summary", "string:code"],
			orientation: "horizontal",
			reserveMore: true,
			widths: new Map([
				["string:summary", 82],
				["string:code", 108],
			]),
		});

		expect(resolution.keys).toEqual(["string:summary"]);
	});

	test("fits a filled row by layout size while a dialog's zoom-in scales it", () => {
		// Measured from the Security companion's two-column scan-type grid while
		// its dialog was still scaling in: the row's rect is 95% of its layout
		// size, but gap and padding come from computed style unscaled.
		globalThis.getComputedStyle = (() => ({
			borderLeftWidth: "1px",
			borderRightWidth: "1px",
			boxSizing: "border-box",
			columnGap: "3.84px",
			height: "58px",
			paddingLeft: "3.84px",
			paddingRight: "3.84px",
			width: "417.281px",
		})) as unknown as typeof getComputedStyle;
		const list = {
			clientHeight: 56,
			clientWidth: 415,
			getBoundingClientRect: () => ({ height: 55.1, width: 396.417 }),
			querySelector: () => null,
		} as unknown as HTMLDivElement;

		const resolution = resolveVisibleTabKeys(list, {
			activeKey: "string:codebase",
			hiddenKeys: new Set(),
			order: ["string:codebase", "string:changes"],
			orientation: "horizontal",
			reserveMore: false,
			widths: new Map([
				["string:codebase", 201.891],
				["string:changes", 201.891],
			]),
		});

		expect(resolution.keys).toEqual(["string:codebase", "string:changes"]);
	});
});

describe("tab overflow trigger copy", () => {
	const managedTabs = (
		<Tabs defaultValue="plan">
			<TabsList manageLayout>
				<TabsTrigger value="plan">Plan</TabsTrigger>
				<TabsTrigger value="debug">Debug</TabsTrigger>
			</TabsList>
		</Tabs>
	);

	test("stays English without an i18n provider", () => {
		const html = renderToStaticMarkup(managedTabs);
		expect(html).toContain('aria-label="Show more tabs"');
		expect(html).toContain(">More</span>");
	});

	test("follows the host language pack", () => {
		const html = renderToStaticMarkup(
			<I18nProvider autoLocalizeDom={false} initialPackId="official/de">
				{managedTabs}
			</I18nProvider>
		);
		expect(html).toContain('aria-label="Weitere Tabs anzeigen"');
		expect(html).toContain(">Mehr</span>");
	});

	test("formats the overflow count in the host language", () => {
		const html = renderToStaticMarkup(
			<I18nProvider autoLocalizeDom={false} initialPackId="official/de">
				<I18nText id="common.more-count" values={{ count: 29 }} />|
				<I18nText id="common.show-more-tabs-count" values={{ count: 29 }} />
			</I18nProvider>
		);
		expect(html).toBe("29 weitere|29 weitere Tabs anzeigen");
	});
});
