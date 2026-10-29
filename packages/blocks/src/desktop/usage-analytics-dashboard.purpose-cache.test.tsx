import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { UsageEvent } from "./usage-analytics.ts";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(Element.prototype, "getAnimations", () => []);
const { createRoot } = await import("react-dom/client");
const { UsageAnalyticsDashboard } = await import(
	"./usage-analytics-dashboard.tsx"
);
const { aggregateUsageEvents } = await import("./usage-analytics.ts");

const RANGE = {
	from: new Date("2026-08-17T00:00:00.000Z"),
	to: new Date("2026-08-18T00:00:00.000Z"),
};

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
	document.body.replaceChildren();
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function mountWith(events: UsageEvent[]): Promise<HTMLElement> {
	const analytics = aggregateUsageEvents({
		caption: "Node traffic",
		events,
		from: RANGE.from,
		granularity: "hourly",
		scope: "node",
		scopeLabel: "This node",
		to: RANGE.to,
	});
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<UsageAnalyticsDashboard
				analytics={analytics}
				granularity="hourly"
				loading={false}
				model={null}
				onGranularityChange={() => undefined}
				onModelChange={() => undefined}
				onProviderChange={() => undefined}
				onRangeChange={() => undefined}
				onScopeChange={() => undefined}
				provider={null}
				range={RANGE}
				scope="node"
			/>
		);
	});
	return container;
}

const PURPOSE = '[data-testid="usage-analytics-chart-purpose"]';
const CACHE = '[data-testid="usage-analytics-chart-prompt-cache"]';

test("hides the purpose and prompt-cache cards for hosts that do not report them", async () => {
	const container = await mountWith([
		{ requestCount: 2, timestamp: "2026-08-17T09:00:00.000Z" },
	]);

	expect(
		container.querySelector('[data-testid="usage-analytics-chart-feature-mix"]')
	).not.toBeNull();
	expect(container.querySelector(PURPOSE)).toBeNull();
	expect(container.querySelector(CACHE)).toBeNull();
});

test("shows request counts by purpose and the cache reuse ratio", async () => {
	const container = await mountWith([
		{
			cacheReadTokens: 30,
			cacheWriteTokens: 10,
			purpose: null,
			requestCount: 4,
			timestamp: "2026-08-17T09:00:00.000Z",
		},
		{
			purpose: "plugin:@ryu/foo",
			requestCount: 1,
			timestamp: "2026-08-17T10:00:00.000Z",
		},
	]);

	const purpose = container.querySelector(PURPOSE);
	expect(purpose?.textContent).toContain("Model calls by purpose");
	expect(purpose?.textContent).toContain("Chat and agent turns");
	expect(purpose?.textContent).toContain("Plugin · @ryu/foo");
	expect(purpose?.textContent).toContain("80%");
	const cache = container.querySelector(CACHE);
	expect(cache).not.toBeNull();
	expect(
		container.querySelector('[data-testid="usage-prompt-cache-reuse"]')
			?.textContent
	).toBe("75%");
});

test("does not claim a reuse ratio when the provider reports no cache writes", async () => {
	const container = await mountWith([
		{
			cacheReadTokens: 30,
			timestamp: "2026-08-17T09:00:00.000Z",
		},
	]);

	expect(container.querySelector(CACHE)?.textContent).toContain(
		"no reuse ratio is shown"
	);
	expect(
		container.querySelector('[data-testid="usage-prompt-cache-reuse"]')
	).toBeNull();
});
