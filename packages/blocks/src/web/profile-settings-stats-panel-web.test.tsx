import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
	ProfileStatsInsights,
	ProfileStatsSummary,
} from "./profile-settings-types.ts";

// The website loads only the `web` catalog subset. The stats tiles' fallback
// copy must resolve from it, and the peak day reads as a localized date, not
// the API's raw ISO day.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { loadOfficialWebLiteralCatalog } = await import(
	"@ryu/i18n/official-catalog/web"
);
const { ProfileStatsPanel } = await import(
	"./profile-settings-stats-panel.tsx"
);

const INSIGHTS: ProfileStatsInsights = {
	activeDays: 2,
	averageRequestsPerActiveDay: 1,
	averageTokensPerActiveDay: 10,
	favoriteModel: null,
	peakDay: { day: "2026-03-14", tokens: 20 },
	peakHourUtc: null,
	topModels: [],
	topPlugins: [],
	topSkills: [],
	transport: { acp: 0, gateway: 0, openAiCompat: 0, other: 0 },
};

const SUMMARY: ProfileStatsSummary = {
	level: 1,
	pointsBalance: 0,
	streak: { current: 1, longest: 1 },
	totals: {
		agentSeconds: 0,
		costMicroUsd: 0,
		inputTokens: 0,
		outputTokens: 0,
		requestCount: 0,
		sessionCount: 0,
	},
	xp: 0,
};

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
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

test("Japanese stats tiles translate their fallbacks from the web catalog", async () => {
	const japanese = await loadOfficialWebLiteralCatalog("ja");
	const notEnoughData = japanese?.["Not enough data"];
	expect(notEnoughData).toBeString();
	expect(notEnoughData).not.toBe("Not enough data");
	registerLiteralCatalogLoader(loadOfficialWebLiteralCatalog);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale="ja" initialPackId={null}>
				<ProfileStatsPanel insights={INSIGHTS} summary={SUMMARY} />
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	const text = container.textContent ?? "";
	expect(text).toContain(notEnoughData ?? "");
	expect(text).not.toContain("2026-03-14");
	expect(text).toContain("3月14日");
});
