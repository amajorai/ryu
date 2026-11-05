// The Lifetime "Agent hours" readout follows the reader's number format: a
// German user sees "3,5" like the neighbouring Intl-formatted stats, not the
// ASCII "3.5" a hand-written toFixed shows.

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

async function agentHoursReadout(locale: string): Promise<string> {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				<StatsUsageSections
					agentHours={3.46}
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
	const label = [...container.querySelectorAll("p > span")].find(
		(node) => node.textContent === "Agent hours"
	);
	return label?.parentElement?.nextElementSibling?.textContent ?? "";
}

test("agent hours show a German decimal comma", async () => {
	expect(await agentHoursReadout("de")).toBe("3,5");
});

test("agent hours keep the English decimal point", async () => {
	expect(await agentHoursReadout("en")).toBe("3.5");
});
