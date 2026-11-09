import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(Element.prototype, "getAnimations", () => []);
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { UsageAnalyticsDashboard } = await import(
	"./usage-analytics-dashboard.tsx"
);
const { aggregateUsageEvents } = await import("./usage-analytics.ts");

const RANGE = {
	from: new Date("2026-08-17T00:00:00.000Z"),
	to: new Date("2026-08-18T00:00:00.000Z"),
};

// The five sentences the desktop analytics client returns when a scope cannot
// be charted (apps/desktop/src/lib/api/usage-analytics-availability-copy.ts).
const JA: Record<string, string> = {
	"Personal fine-grained history is not reported by the profile rollup yet. Choose daily, weekly, or monthly, or inspect This node for interval traffic.":
		"個人の細かい履歴はまだプロファイル集計に含まれません。日別・週別・月別を選ぶか、「このノード」で間隔ごとのトラフィックを確認してください。",
	"Personal rollups do not retain provider and model dimensions yet. Clear the filter or switch to Organization or This node for a filtered breakdown.":
		"個人集計はまだプロバイダーとモデルの内訳を保持しません。フィルターを解除するか、「組織」または「このノード」に切り替えてください。",
	"Select a node to view node analytics.":
		"ノードを選択するとノードの分析を表示できます。",
	"Select an organization to view organization analytics.":
		"組織を選択すると組織の分析を表示できます。",
	"This node is offline or its audit history is unavailable.":
		"このノードはオフラインか、監査履歴を利用できません。",
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
	registerLiteralCatalogLoader(null);
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function availabilityText(message: string): Promise<string> {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
	const analytics = {
		...aggregateUsageEvents({
			caption: "Node traffic",
			events: [],
			from: RANGE.from,
			granularity: "daily",
			scope: "node",
			scopeLabel: "This node",
			to: RANGE.to,
		}),
		availability: { message, supported: false },
	};
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="ja"
				initialPackId={null}
			>
				<UsageAnalyticsDashboard
					analytics={analytics}
					granularity="daily"
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
			</I18nProvider>
		);
	});
	await act(async () => {
		await Bun.sleep(50);
	});
	return (
		container.querySelector('[data-testid="usage-analytics-availability"]')
			?.textContent ?? ""
	);
}

for (const [english, japanese] of Object.entries(JA)) {
	test(`renders "${english.slice(0, 32)}…" in Japanese`, async () => {
		const text = await availabilityText(english);
		expect(text).toBe(japanese);
		expect(text).not.toContain(english.slice(0, 12));
	});
}

test("an uncatalogued availability message still renders as given", async () => {
	expect(await availabilityText("Custom host note.")).toBe("Custom host note.");
});
