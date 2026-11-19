import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { I18nProvider } from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivationOfferStep } from "./ActivationOfferStep.tsx";

// The Teams offer sentence selects on `{includedSeatsWord, select, five {...}
// other {...}}`. Passing the translated word (de "fünf") picked every
// locale's "several seats" arm instead of the five-seat one.

function shippedCatalog(locale: string): Record<string, string> {
	const path = fileURLToPath(
		new URL(
			`../../../../../packages/i18n/locales/${locale}.json`,
			import.meta.url
		)
	);
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
}

function renderOffer(locale: string): string {
	return renderToStaticMarkup(
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale={locale}
			initialPackId={null}
			manageDocument={false}
			overlays={{ [locale]: shippedCatalog(locale) }}
		>
			<ActivationOfferStep
				dialog={null}
				onConfirmCheckout={() => undefined}
				onContinue={() => undefined}
				onSkip={() => undefined}
				onStartCheckout={() => undefined}
				organizationPlan
				subscribed={false}
			/>
		</I18nProvider>
	);
}

test("the German Teams offer names the five-seat floor", () => {
	const html = renderOffer("de");
	expect(html).toContain("5 Plätze");
	expect(html).not.toContain("mehrere Plätze");
});

test("the Japanese Teams offer names the five-seat floor", () => {
	const html = renderOffer("ja");
	expect(html).toContain("5 シート");
	expect(html).not.toContain("複数シート");
});
