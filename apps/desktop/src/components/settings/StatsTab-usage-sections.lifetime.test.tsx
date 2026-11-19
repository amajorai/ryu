// The Stats tab's "Lifetime" heading is an all-time total and reads through
// the keyed `usage.lifetime` (ja 累計). The bare catalog "Lifetime" is the
// one-time purchase Billing shows (ja 買い切り).

import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const ownsDom = globalThis.document === undefined;
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { StatsUsageSections } = await import("./StatsTab-usage-sections.tsx");

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

async function renderStats(locale: string): Promise<string> {
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
				<StatsUsageSections
					agentHours={0}
					costMicroUsd={0}
					heatmapData={[]}
					insights={undefined}
					requestCount={0}
					stats={undefined}
					totalTokens={0}
					usageDays={[]}
				/>
			</I18nProvider>
		);
	});
	return container.textContent ?? "";
}

test("the Japanese Stats tab heads the all-time totals 累計, not the purchase", async () => {
	const text = await renderStats("ja");
	expect(text).toContain("累計");
	expect(text).not.toContain("買い切り");
});

test("English keeps Lifetime", async () => {
	expect(await renderStats("en")).toContain("Lifetime");
});
