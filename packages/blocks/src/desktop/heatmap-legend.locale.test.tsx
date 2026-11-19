// A heatmap legend's "Less ... More" are intensity ends (ja "少", "多") and
// read through the keyed `heatmap.less` / `heatmap.more`. The bare catalog
// "Less" and "More" are show-less and overflow toggles (ja "閉じる", "その他").
import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { JournalStats } from "./interfaces/journal-model.ts";
import type { UsageAnalyticsData } from "./usage-analytics-types.ts";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}

const { ActivityHeatmap } = await import(
	"./usage-analytics-dashboard-breakdowns.tsx"
);
const { JournalStatsPage } = await import("./interfaces/journal-views.tsx");

afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

/** Stand-ins for the toggle senses of the bare catalog rows. */
const OVERLAYS = {
	de: { "Share of entries": "Anteil der Einträge" },
	ja: { Less: "閉じる", More: "その他" },
};

function render(locale: string, node: ReactNode): string {
	return renderToStaticMarkup(
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale={locale}
			manageDocument={false}
			overlays={OVERLAYS}
		>
			{node}
		</I18nProvider>
	);
}

const USAGE = { buckets: [] } as unknown as UsageAnalyticsData;

const STATS: JournalStats = {
	agents: [
		{
			agent: {
				avatarUrl: null,
				description: "Writes",
				id: "agent-ada",
				name: "Ada",
				status: "idle",
			} as JournalStats["agents"][number]["agent"],
			entries: 2,
			messages: 3,
		},
	],
	currentStreak: 1,
	daysJournaled: 2,
	entries: 2,
	longestStreak: 2,
	messages: 3,
	thisYear: 2,
};

function journal(locale: string): string {
	return render(
		locale,
		<JournalStatsPage
			byDay={new Map()}
			onSelectDay={() => undefined}
			stats={STATS}
			titleClass=""
			today={new Date(2026, 10, 13)}
		/>
	);
}

test("the usage heatmap legend reads as intensity in Japanese", () => {
	const html = render("ja", <ActivityHeatmap data={USAGE} />);
	expect(html).toContain("<span>少</span>");
	expect(html).toContain("<span>多</span>");
	expect(html).not.toContain("閉じる");
});

test("the journal heatmap legend reads as intensity in Russian", () => {
	const html = journal("ru");
	expect(html).toContain('<span class="me-1">Меньше</span>');
	expect(html).toContain('<span class="ms-1">Больше</span>');
});

test("English keeps Less and More", () => {
	const html = render("en", <ActivityHeatmap data={USAGE} />);
	expect(html).toContain("<span>Less</span>");
	expect(html).toContain("<span>More</span>");
});

test("the journal agent column names the share of entries", () => {
	expect(journal("de")).toContain('<th scope="col">Anteil der Einträge</th>');
	expect(journal("en")).toContain('<th scope="col">Share of entries</th>');
});
