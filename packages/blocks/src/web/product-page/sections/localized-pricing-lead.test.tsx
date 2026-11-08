import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// The price lead is rebuilt from typed pricing data in the reader's number
// format; an unknown slug keeps the server's English lead, and only the
// Pricing fact of a fact sheet is replaced.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { LocalizedFactSheet, LocalizedPricingLead } = await import(
	"./localized-pricing-lead.tsx"
);

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

async function renderText(
	locale: string,
	node: React.ReactNode
): Promise<string> {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				{node}
			</I18nProvider>
		);
	});
	return container.textContent ?? "";
}

test("a known product's lead is formatted for the reader", async () => {
	const fr = await renderText(
		"fr",
		<LocalizedPricingLead fallback="server lead" slug="box" />
	);
	expect(fr).toMatch(/0,025\s\$/u);
	expect(fr).not.toContain("server lead");
});

test("an unknown slug keeps the server's English lead", async () => {
	const text = await renderText(
		"fr",
		<LocalizedPricingLead fallback="From $5 a month" slug="no-such-product" />
	);
	expect(text).toBe("From $5 a month");
});

test("only the Pricing fact of the sheet is replaced", async () => {
	const text = await renderText(
		"fr",
		<LocalizedFactSheet
			facts={[
				{ label: "Pricing", value: "$0.025 per hour" },
				{ label: "Region", value: "EU West" },
			]}
			slug="box"
		/>
	);
	expect(text).toMatch(/0,025\s\$/u);
	expect(text).not.toContain("$0.025 per hour");
	expect(text).toContain("EU West");
});
