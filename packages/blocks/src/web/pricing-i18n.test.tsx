import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

// The pricing cards format their figures for the page language and keep each
// line one whole message, so nothing English trails a translated sentence.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { ProPlanCard, TeamsPlanCard } = await import("./pricing.tsx");
const { SubscriptionAgreement } = await import("./subscription-agreement.tsx");
const { PriceBlock } = await import("./pricing-card-parts.tsx");

const DE: Record<string, string> = {
	"<amount>{amount}</amount>/month AI usage included":
		"<amount>{amount}</amount> KI-Nutzung pro Monat inklusive",
	"<amount>{amount}</amount>/month shared AI credits":
		"<amount>{amount}</amount> geteilte KI-Guthaben pro Monat",
	"<amount>{price}</amount><suffix>/mo</suffix>":
		"<amount>{price}</amount><suffix>/Monat</suffix>",
	"Agent Inboxes, {monthlyEmails} monthly emails, and {storageGib} GiB mail storage":
		"Agent-Postfächer, {monthlyEmails} E-Mails pro Monat und {storageGib} GiB Mailspeicher",
	"{monthlyEmails} monthly emails and {storageGib} GiB mail storage":
		"{monthlyEmails} E-Mails pro Monat und {storageGib} GiB Mailspeicher",
};

const JA: Record<string, string> = {
	"I agree to automatic renewal and the <terms>subscription terms</terms>":
		"自動更新と<terms>サブスクリプション規約</terms>に同意します",
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

async function renderIn(
	locale: string,
	catalog: Record<string, string>,
	node: ReactNode
): Promise<HTMLElement> {
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
				{node}
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return container;
}

test("the Pro card formats its email allowance and AI usage for German", async () => {
	const container = await renderIn("de", DE, <ProPlanCard />);
	const text = container.textContent ?? "";
	expect(text).toContain("5.000 E-Mails pro Monat");
	expect(text).not.toContain("5,000");
	expect(text).toContain("KI-Nutzung pro Monat inklusive");
	expect(text).not.toContain("/month AI usage included");
	expect(text).toContain("/Monat");
});

test("the Teams card formats its shared credits and email allowance for German", async () => {
	const container = await renderIn("de", DE, <TeamsPlanCard />);
	const text = container.textContent ?? "";
	expect(text).toContain("100.000 E-Mails pro Monat");
	expect(text).toContain("geteilte KI-Guthaben pro Monat");
	expect(text).not.toContain("/month shared AI credits");
});

test("English keeps the published card copy", async () => {
	const container = await renderIn("en", {}, <ProPlanCard />);
	const text = container.textContent ?? "";
	expect(text).toContain("5,000 monthly emails");
	expect(text).toContain("$14/month AI usage included");
});

test("the consent line is one sentence with the terms link inside it", async () => {
	const container = await renderIn(
		"ja",
		JA,
		<SubscriptionAgreement terms="Renews automatically.">
			{() => null}
		</SubscriptionAgreement>
	);
	const link = container.querySelector("label a");
	expect(link?.textContent).toBe("サブスクリプション規約");
	expect(link?.getAttribute("href")).toContain("/docs/legal/terms");
	expect(link?.parentElement?.textContent).toBe(
		"自動更新とサブスクリプション規約に同意します"
	);
});

test("the English consent wording is unchanged", async () => {
	const container = await renderIn(
		"en",
		{},
		<SubscriptionAgreement terms="Renews automatically.">
			{() => null}
		</SubscriptionAgreement>
	);
	const link = container.querySelector("label a");
	expect(link?.textContent).toBe("subscription terms");
	expect(link?.parentElement?.textContent).toBe(
		"I agree to automatic renewal and the subscription terms"
	);
});

const SEAT_TOTAL =
	"{seats, plural, one {<amount>{price}</amount>/mo for # seat} other {<amount>{price}</amount>/mo for # seats}}";
const SEAT_ANNUAL =
	"{seats, plural, one {Billed <amount>{price}</amount> per year for # seat} other {Billed <amount>{price}</amount> per year for # seats}}";

test("English keeps the seat total lines", async () => {
	const container = await renderIn(
		"en",
		{},
		<PriceBlock isYearly monthly={20} perSeat seats={5} />
	);
	const text = container.textContent ?? "";
	expect(text).toContain("/mo for 5 seats");
	expect(text).toContain("per year for 5 seats");
	expect(text).toContain("/seat/mo");
});

test("the seat total lines take the language's plural form", async () => {
	const AR: Record<string, string> = {
		[SEAT_TOTAL]:
			"{seats, plural, one {<amount>{price}</amount> شهريًا لمقعد واحد} two {<amount>{price}</amount> شهريًا لمقعدين} few {<amount>{price}</amount> شهريًا لـ # مقاعد} many {<amount>{price}</amount> شهريًا لـ # مقعدًا} other {<amount>{price}</amount> شهريًا لـ # مقعد}}",
		[SEAT_ANNUAL]:
			"{seats, plural, one {يُدفع <amount>{price}</amount> سنويًا لمقعد واحد} two {يُدفع <amount>{price}</amount> سنويًا لمقعدين} few {يُدفع <amount>{price}</amount> سنويًا لـ # مقاعد} many {يُدفع <amount>{price}</amount> سنويًا لـ # مقعدًا} other {يُدفع <amount>{price}</amount> سنويًا لـ # مقعد}}",
	};
	const container = await renderIn(
		"ar",
		AR,
		<PriceBlock isYearly monthly={20} perSeat seats={2} />
	);
	const text = container.textContent ?? "";
	expect(text).toContain("شهريًا لمقعدين");
	expect(text).toContain("سنويًا لمقعدين");
	expect(text).not.toContain("seats");
});
