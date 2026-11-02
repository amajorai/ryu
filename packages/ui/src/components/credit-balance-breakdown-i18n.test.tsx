import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// The info buttons' aria-labels are built in code, where the DOM localizer
// never reaches, so the label inside "About {label}" must be translated
// before it is spliced in (not lowercased English: "free creditについて").
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { CreditBalanceBreakdown } = await import(
	"./credit-balance-breakdown.tsx"
);

const JA: Record<string, string> = {
	"About {label}": "{label}について",
	"Free credit": "無料クレジット",
	"Gift balance": "ギフト残高",
	"On-demand credits": "オンデマンドクレジット",
	"Plan credits": "プランクレジット",
};

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
	registerLiteralCatalogLoader(null);
	await cleanup?.();
	cleanup = undefined;
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function mount(locale: string): Promise<HTMLElement> {
	registerLiteralCatalogLoader((tag) => (tag.startsWith("ja") ? JA : {}));
	const container = document.createElement("div");
	document.body.append(container);
	const root: Root = createRoot(container);
	cleanup = async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
	};
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				<CreditBalanceBreakdown
					giftCreditsMicroUsd={3_000_000}
					onDemandCreditsMicroUsd={20_000_000}
					planAllowanceMicroUsd={15_000_000}
					planCreditsMicroUsd={7_500_000}
					providerAllocations={[
						{
							expiresAt: "2026-12-31T00:00:00Z",
							expiresAtLabel: "Expires Dec 31, 2026",
							id: "fast",
							isFreeProvider: true,
							label: "Ryu Fast",
							remainingMicroUsd: 4_250_000,
						},
					]}
					totalMicroUsd={34_750_000}
				/>
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return container;
}

function aboutLabels(container: HTMLElement): string[] {
	return [...container.querySelectorAll("[aria-label]")]
		.map((element) => element.getAttribute("aria-label") ?? "")
		.filter((label) => label.includes("について") || label.startsWith("About"));
}

test("info-button labels splice the translated bucket name under ja", async () => {
	const labels = aboutLabels(await mount("ja"));
	expect(labels).toContain("プランクレジットについて");
	expect(labels).toContain("ギフト残高について");
	expect(labels).toContain("オンデマンドクレジットについて");
	for (const label of labels) {
		expect(label).not.toMatch(
			/free credit|plan credits|gift balance|on-demand credits/iu
		);
	}
});

test("English keeps the lowercased bucket name mid-sentence", async () => {
	const labels = aboutLabels(await mount("en"));
	expect(labels).toContain("About plan credits");
	expect(labels).toContain("About gift balance");
});
