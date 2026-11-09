import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CloudHostingTier } from "./pricing-plan-prices.ts";

// The hosted-compute add-on rows are whole messages with a locale-formatted
// price, so a German page never reads "$29 per month".
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { CloudUpgradePanel } = await import("./pricing-cloud-upgrade-panel.tsx");

const TIERS: readonly CloudHostingTier[] = [
	{
		cores: 4,
		diskGb: 80,
		id: "2X",
		includedWithMax: false,
		includedWithPlan: false,
		memoryGb: 8,
		monthlyAddUsd: 29,
		name: "2X",
		perfLabel: "twice as fast",
		slug: "cloud-2x",
	},
];

const DE: Record<string, string> = {
	"{amount} per month": "{amount} pro Monat",
	"{cores} vCPU, {memoryGb} GB RAM, and {diskGb} GB SSD":
		"{cores} vCPU, {memoryGb} GB RAM und {diskGb} GB SSD",
	"{name} is {perf}": "{name} ist {perf}",
};

/** Intl separates the amount and the sign with a no-break space. */
const plainSpaces = (text: string): string =>
	text.replaceAll(" ", " ").replaceAll(" ", " ");

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

async function renderExpanded(
	locale: string,
	catalog: Record<string, string>
): Promise<string> {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith(locale) ? catalog : {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				<CloudUpgradePanel
					loadingPlan={null}
					onCheckout={() => undefined}
					tiers={TIERS}
				/>
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	const toggle = container.querySelector("button[aria-expanded]");
	await act(async () => {
		toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return plainSpaces(container.textContent ?? "");
}

test("German reads the add-on as a whole message with a German price", async () => {
	const text = await renderExpanded("de", DE);
	expect(text).toContain("29 $ pro Monat");
	expect(text).toContain("2X ist twice as fast");
	expect(text).toContain("4 vCPU, 8 GB RAM und 80 GB SSD");
	expect(text).not.toContain("per month");
	expect(text).not.toContain("$29");
});

test("English keeps the published add-on copy", async () => {
	const text = await renderExpanded("en", {});
	expect(text).toContain("$29 per month");
	expect(text).toContain("2X is twice as fast");
	expect(text).toContain("4 vCPU, 8 GB RAM, and 80 GB SSD");
});
