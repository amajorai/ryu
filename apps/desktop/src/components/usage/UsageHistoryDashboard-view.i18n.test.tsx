import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
import type {
	HistoryTokenTotals,
	UsageHistoryReport,
} from "@/src/lib/api/usage-history.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { UsageHistoryView } = await import("./UsageHistoryDashboard-view.tsx");

const ESTIMATE =
	"List-price estimate. Subscription charges and invoices are separate.";
const UNPRICED =
	"{count, plural, one {# record has an unknown price.} other {# records have unknown prices.}}";
const COUNTERS =
	"Some records omit token counters. Totals include only reported values.";
const CATALOGS: Record<string, Record<string, string>> = {
	ja: {
		[ESTIMATE]:
			"定価による見積もりです。サブスクリプション料金と請求書は別です。",
		[UNPRICED]: "{count, plural, other {#件の記録は価格が不明です。}}",
		[COUNTERS]:
			"一部の記録にはトークン数がありません。合計は報告された値のみです。",
	},
};

const totals = (missingInputRecords: number): HistoryTokenTotals => ({
	cachedOutputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	inputTokens: 10,
	missingCachedOutputRecords: 0,
	missingCacheReadRecords: 0,
	missingCacheWriteRecords: 0,
	missingInputRecords,
	missingOutputRecords: 0,
	missingReasoningRecords: 0,
	outputTokens: 5,
	reasoningTokens: 0,
});

const report = (
	unpricedRecords: number,
	missingInputRecords = 0
): UsageHistoryReport => ({
	sources: [],
	summary: {
		billedCostUsd: null,
		cacheSavingsUsd: null,
		daily: [],
		estimatedCostUsd: 0.5,
		models: [],
		records: 4,
		reportedCostUsd: null,
		sessions: 1,
		sourceEstimatedCostUsd: null,
		sources: [],
		totals: totals(missingInputRecords),
		unpricedRecords,
	},
});

const roots: Root[] = [];

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	registerLiteralCatalogLoader(null);
});

async function renderView(
	locale: string,
	value: UsageHistoryReport
): Promise<HTMLElement> {
	registerLiteralCatalogLoader((tag) => CATALOGS[tag.split("-")[0]] ?? {});
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale={locale}
				initialPackId={null}
			>
				<UsageHistoryView
					days={null}
					error={null}
					importError={null}
					importing={false}
					importReport={null}
					loading={false}
					onDaysChange={() => undefined}
					onImport={async () => undefined}
					onRefresh={() => undefined}
					refreshing={false}
					report={value}
					scope="session"
				/>
			</I18nProvider>
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
	return container;
}

/** The caption's sentence spans, in order. */
function captionSentences(container: HTMLElement, first: string): string[] {
	const span = [...container.querySelectorAll("span")].find(
		(node) => node.textContent?.trim() === first
	);
	if (!span?.parentElement) {
		throw new Error(`caption sentence not rendered: ${first}`);
	}
	return [...span.parentElement.children].map(
		(node) => node.textContent?.trim() ?? ""
	);
}

test("a Japanese overview caption is whole translated sentences", async () => {
	const container = await renderView("ja", report(3, 2));
	expect(
		captionSentences(
			container,
			"定価による見積もりです。サブスクリプション料金と請求書は別です。"
		)
	).toEqual([
		"定価による見積もりです。サブスクリプション料金と請求書は別です。",
		"3件の記録は価格が不明です。",
		"一部の記録にはトークン数がありません。合計は報告された値のみです。",
	]);
	expect(container.textContent).not.toContain("unknown prices");
});

test("one unpriced record reads in the singular", async () => {
	const container = await renderView("en", report(1));
	expect(captionSentences(container, ESTIMATE)).toEqual([
		ESTIMATE,
		"1 record has an unknown price.",
	]);
});

test("several unpriced records read in the plural", async () => {
	const container = await renderView("en", report(12));
	expect(captionSentences(container, ESTIMATE)).toEqual([
		ESTIMATE,
		"12 records have unknown prices.",
	]);
});
