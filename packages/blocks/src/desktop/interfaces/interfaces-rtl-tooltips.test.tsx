// Hover tooltips over bar and column rows follow the reading direction: the
// rows mirror under `dir="rtl"`, so the tooltip is placed with logical insets
// measured from the inline start, never a physical `left`/`right`. The Island
// command bar's Back chevron mirrors with the layout.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfaceAgent,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { StatusUptime } = await import("./status-uptime.tsx");
const { ActivityChart: DashboardActivityChart } = await import(
	"./dashboard-activity.tsx"
);
const { ActivityChart: MissionActivityChart } = await import(
	"./mission-control-activity.tsx"
);
const { BackChevron } = await import("../../command/command-bar.tsx");
const { DIRECTIONAL_ICON_CLASS } = await import(
	"@ryu/ui/components/directional-icon.tsx"
);

const DAY_MS = 24 * 60 * 60 * 1000;
const START = Date.parse("2026-10-01T00:00:00Z");

const agent = { id: "agent-1", name: "Scout" } as InterfaceAgent;
const component = {
	agent,
	days: Array.from({ length: 4 }, (_, index) => ({
		active: 1,
		key: `2026-10-0${index + 1}`,
		level: "operational" as const,
		problems: [],
		start: START + index * DAY_MS,
		successfulRuns: 1,
	})),
	state: "operational" as const,
	uptime: 1,
};

const HOUR_MS = 60 * 60 * 1000;
const snapshot = { threads: [] } as unknown as InterfaceSnapshot;
const buckets = Array.from({ length: 24 }, (_, index) => ({
	count: 1,
	start: START + index * HOUR_MS,
	threadIds: [`thread-${index}`],
}));
const activity = { buckets, max: 1, peak: buckets[0] ?? null, total: 24 };

/** Mount `node` inside a right-to-left container and focus its nth bar. */
async function mountRtlAndFocus(node: ReactNode, nth: number) {
	const container = document.createElement("div");
	container.dir = "rtl";
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(node);
	});
	const bars = container.querySelectorAll("button");
	await act(async () => {
		bars[nth]?.focus();
	});
	return container;
}

/** The inline style of the hovered column's tooltip popover. */
function tooltipStyle(container: HTMLElement): string {
	const popover = [
		...container.querySelectorAll<HTMLElement>('[aria-hidden="true"]'),
	].find((element) => element.className.includes("bg-popover"));
	return popover?.getAttribute("style") ?? "";
}

const PHYSICAL_INSET = /(?:^|[;\s])(?:left|right)\s*:/;

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

describe("direction-aware tooltips and chevrons", () => {
	test("the uptime tooltip is placed from the inline start", async () => {
		const container = document.createElement("div");
		container.dir = "rtl";
		document.body.append(container);
		const root = createRoot(container);
		mounted = { container, root };
		await act(async () => {
			root.render(<StatusUptime component={component} />);
		});
		const bars = container.querySelectorAll("button");
		await act(async () => {
			bars[0]?.focus();
		});
		const tooltip = container.querySelector<HTMLElement>('[role="tooltip"]');
		expect(tooltip).not.toBeNull();
		const style = tooltip?.getAttribute("style") ?? "";
		expect(style).toContain("inset-inline-start");
		expect(style).toContain("12.5%");
		expect(style).not.toMatch(/(?:^|[;\s])(?:left|right)\s*:/);
	});

	test("dashboard activity tooltips use logical insets on both sides", async () => {
		const early = await mountRtlAndFocus(
			<DashboardActivityChart
				activity={activity}
				onOpen={() => undefined}
				snapshot={snapshot}
			/>,
			2
		);
		const startStyle = tooltipStyle(early);
		expect(startStyle).toContain("inset-inline-start");
		expect(startStyle).not.toMatch(PHYSICAL_INSET);
		const { container, root } = mounted ?? {};
		await act(async () => {
			root?.unmount();
		});
		container?.remove();
		const late = await mountRtlAndFocus(
			<DashboardActivityChart
				activity={activity}
				onOpen={() => undefined}
				snapshot={snapshot}
			/>,
			20
		);
		const endStyle = tooltipStyle(late);
		expect(endStyle).toContain("inset-inline-end");
		expect(endStyle).not.toMatch(PHYSICAL_INSET);
	});

	test("mission control activity tooltips use logical insets", async () => {
		const container = await mountRtlAndFocus(
			<MissionActivityChart
				activity={{ ...activity, runs: [] }}
				onOpen={() => undefined}
				snapshot={snapshot}
			/>,
			20
		);
		const style = tooltipStyle(container);
		expect(style).toContain("inset-inline-end");
		expect(style).not.toMatch(PHYSICAL_INSET);
	});

	test("the command bar Back chevron mirrors under right-to-left", () => {
		const html = renderToStaticMarkup(
			<div dir="rtl">
				<BackChevron />
			</div>
		);
		expect(html).toContain(DIRECTIONAL_ICON_CLASS);
		expect(html).not.toContain("rotate-180");
		expect(html).toContain('d="M15 18l-6-6 6-6"');
	});
});
