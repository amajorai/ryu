// The "Activity over time" caption and forecast labels are whole translated
// messages: the metric and the horizon reach the reader in their language
// instead of English labels spliced into a translated frame.

import {
	afterAll,
	afterEach,
	describe,
	expect,
	setSystemTime,
	test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { LiteralMessage } from "@ryu/i18n/react";
import type { Root } from "react-dom/client";
import type { UsageEvent, UsageGranularity } from "./usage-analytics.ts";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(Element.prototype, "getAnimations", () => []);
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { formatMessage, registerLiteralCatalogLoader } = await import(
	"@ryu/i18n/core"
);
const { I18nProvider } = await import("@ryu/i18n/react");
const { aggregateUsageEvents } = await import("./usage-analytics.ts");
const { USAGE_FORECAST_HORIZON_LABELS } = await import(
	"./usage-analytics-buckets.ts"
);
const { TREND_METRICS, formatBreakdownValue } = await import(
	"./usage-analytics-dashboard-shared.tsx"
);
const { UsageTrend } = await import("./usage-analytics-dashboard-trend.tsx");
const { trendHorizonLabel, trendMetricLabel, usageTrendCaption } = await import(
	"./usage-analytics-trend-labels.ts"
);

const GRANULARITIES: UsageGranularity[] = [
	"15m",
	"hourly",
	"daily",
	"weekly",
	"monthly",
];
const english: LiteralMessage = (source, values = {}) =>
	formatMessage(source, values, "en");

const DE: Record<string, string> = {
	"{metric} at daily resolution, with a trend forecast for the next 14 days.":
		"{metric} in Tagesauflösung, mit Trendprognose für die nächsten 14 Tage.",
	"{metric} at hourly resolution.": "{metric} in Stundenauflösung.",
	"Forecast · {horizonLabel}": "Prognose · {horizonLabel}",
	"next 14 days": "nächste 14 Tage",
	Requests: "Anfragen",
	"{requests} req": "{requests} Anfr.",
};
const AR: Record<string, string> = {
	"{metric} at weekly resolution, with a trend forecast for the next 4 weeks.":
		"{metric} بدقة أسبوعية، مع توقع للاتجاه خلال الأسابيع الأربعة القادمة.",
	"{metric} at weekly resolution.": "{metric} بدقة أسبوعية.",
	"Forecast · {horizonLabel}": "التوقع · {horizonLabel}",
	"next 4 weeks": "الأسابيع الأربعة القادمة",
	Requests: "الطلبات",
};
const JA: Record<string, string> = {
	"{metric} at 15 min resolution.": "15 分単位の{metric}。",
	Requests: "リクエスト",
};

describe("trend label helpers", () => {
	test("every trend metric resolves to its English source label", () => {
		for (const metric of TREND_METRICS) {
			expect(trendMetricLabel(metric.key, english)).toBe(metric.label);
		}
	});

	test("every horizon matches the forecast horizon the chart draws", () => {
		for (const granularity of GRANULARITIES) {
			expect(trendHorizonLabel(granularity, english)).toBe(
				USAGE_FORECAST_HORIZON_LABELS[granularity]
			);
			const caption = usageTrendCaption(
				{ forecast: true, granularity, metric: "requests" },
				english
			);
			expect(caption).toStartWith("Requests at ");
			expect(caption).toEndWith(
				`trend forecast for the ${USAGE_FORECAST_HORIZON_LABELS[granularity]}.`
			);
			expect(
				usageTrendCaption(
					{ forecast: false, granularity, metric: "spend" },
					english
				)
			).toMatch(/^Credit spend at [\w ]+ resolution\.$/);
		}
	});
});

const DAY_MS = 24 * 60 * 60 * 1000;
const FROM = new Date("2026-09-14T00:00:00.000Z");
const TO = new Date("2026-10-14T00:00:00.000Z");

function dailyEvents(): UsageEvent[] {
	return Array.from({ length: 30 }, (_, day) => ({
		requestCount: 10 + day,
		timestamp: new Date(
			FROM.getTime() + day * DAY_MS + 3_600_000
		).toISOString(),
	}));
}

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
	setSystemTime();
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function renderTrendIn(
	locale: string,
	granularity: UsageGranularity
): Promise<string> {
	registerLiteralCatalogLoader((requested) => {
		if (requested.startsWith("de")) {
			return DE;
		}
		if (requested.startsWith("ar")) {
			return AR;
		}
		return requested.startsWith("ja") ? JA : {};
	});
	const data = aggregateUsageEvents({
		caption: "Proof",
		events: dailyEvents(),
		from: FROM,
		granularity,
		scope: "you",
		scopeLabel: "You",
		to: TO,
	});
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				<UsageTrend data={data} />
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return container.textContent ?? "";
}

describe("translated trend caption", () => {
	test("German names the metric and horizon in German", async () => {
		setSystemTime(new Date("2026-10-13T12:00:00.000Z"));
		const text = await renderTrendIn("de", "daily");
		expect(text).toContain(
			"Anfragen in Tagesauflösung, mit Trendprognose für die nächsten 14 Tage."
		);
		expect(text).toContain("Prognose · nächste 14 Tage");
		expect(text).not.toContain("Requests");
		expect(text).not.toContain("next 14 days");
	});

	test("German reads the resolution grammatically mid-sentence", async () => {
		setSystemTime(new Date("2026-10-13T12:00:00.000Z"));
		const text = await renderTrendIn("de", "hourly");
		expect(text).toContain("Anfragen in Stundenauflösung.");
		expect(text).not.toContain("Stündlich");
		expect(text).not.toContain("next 24 hours");
	});

	test("Arabic names the metric and horizon in Arabic", async () => {
		setSystemTime(new Date("2026-10-13T12:00:00.000Z"));
		const text = await renderTrendIn("ar", "weekly");
		expect(text).toContain("الطلبات بدقة أسبوعية");
		expect(text).not.toContain("Requests");
		expect(text).not.toContain("next 4 weeks");
		expect(text).not.toContain("Weekly");
	});

	test("German breakdown rows count requests in German", async () => {
		setSystemTime(new Date("2026-10-13T12:00:00.000Z"));
		await renderTrendIn("de", "daily");
		expect(
			formatBreakdownValue({
				key: "openai",
				label: "OpenAI",
				requests: 12,
				spendMicroUsd: null,
				tokens: 0,
			})
		).toBe("12 Anfr.");
	});

	test("Japanese names the metric in Japanese", async () => {
		setSystemTime(new Date("2026-10-13T12:00:00.000Z"));
		const text = await renderTrendIn("ja", "15m");
		expect(text).toContain("15 分単位のリクエスト。");
		expect(text).not.toContain("Requests");
	});
});

test("breakdown rows label their request count through the catalog", () => {
	expect(
		formatBreakdownValue({
			key: "openai",
			label: "OpenAI",
			requests: 12,
			spendMicroUsd: null,
			tokens: 0,
		})
	).toBe("12 req");
});
