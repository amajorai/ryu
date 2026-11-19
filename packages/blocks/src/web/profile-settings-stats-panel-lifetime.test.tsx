import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { ProfileStatsSummary } from "./profile-settings-types.ts";

// The web profile's "Lifetime" section is an all-time total and reads through
// the keyed `usage.lifetime` (ja 累計). The bare catalog "Lifetime" is a
// one-time purchase (ja 買い切り).
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { ProfileStatsPanel } = await import(
	"./profile-settings-stats-panel.tsx"
);

const SUMMARY: ProfileStatsSummary = {
	level: 1,
	pointsBalance: 0,
	streak: { current: 0, longest: 0 },
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

async function renderPanel(locale: string): Promise<string> {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale={locale}
				initialPackId={locale === "en" ? null : `official/${locale}`}
				manageDocument={false}
				overlays={{ ja: { Lifetime: "買い切り" } }}
			>
				<ProfileStatsPanel summary={SUMMARY} />
			</I18nProvider>
		);
	});
	return container.textContent ?? "";
}

test("the Japanese profile heads the all-time totals 累計, not the purchase", async () => {
	const text = await renderPanel("ja");
	expect(text).toContain("累計");
	expect(text).not.toContain("買い切り");
});

test("English keeps Lifetime", async () => {
	expect(await renderPanel("en")).toContain("Lifetime");
});
