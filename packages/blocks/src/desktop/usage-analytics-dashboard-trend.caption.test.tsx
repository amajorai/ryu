import { afterAll, afterEach, expect, setSystemTime, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { UsageEvent, UsageGranularity } from "./usage-analytics.ts";

// The trend caption must describe what the chart draws: it names a forecast
// only when one is drawn, not whenever the Forecast switch is on.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(Element.prototype, "getAnimations", () => []);
const { createRoot } = await import("react-dom/client");
const { UsageTrend } = await import("./usage-analytics-dashboard-trend.tsx");
const { aggregateUsageEvents } = await import("./usage-analytics.ts");

const EVENTS: UsageEvent[] = [
	{ requestCount: 4, timestamp: "2026-08-17T22:00:00.000Z" },
	{ requestCount: 2, timestamp: "2026-08-17T22:15:00.000Z" },
];

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
	setSystemTime();
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function renderTrend(
	granularity: UsageGranularity,
	from: string,
	to: string
): Promise<string> {
	const data = aggregateUsageEvents({
		caption: "Proof",
		events: EVENTS,
		from: new Date(from),
		granularity,
		scope: "you",
		scopeLabel: "You",
		to: new Date(to),
	});
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(<UsageTrend data={data} />);
	});
	return container.textContent ?? "";
}

test("a too-detailed resolution captions the chart without a forecast", async () => {
	setSystemTime(new Date("2026-08-17T23:00:00.000Z"));
	const text = await renderTrend(
		"15m",
		"2026-08-01T00:00:00.000Z",
		"2026-08-18T00:00:00.000Z"
	);
	expect(text).toContain("Choose a coarser resolution to see a forecast.");
	expect(text).toContain("Requests at 15 min resolution.");
	expect(text).not.toContain("with a trend forecast");
});

test("a range that has ended captions the chart without a forecast", async () => {
	setSystemTime(new Date("2026-11-01T00:00:00.000Z"));
	const text = await renderTrend(
		"daily",
		"2026-08-11T00:00:00.000Z",
		"2026-08-18T00:00:00.000Z"
	);
	expect(text).toContain("Requests at daily resolution.");
	expect(text).not.toContain("with a trend forecast");
});
