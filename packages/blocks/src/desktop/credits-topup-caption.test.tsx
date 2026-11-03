import { describe, expect, test } from "bun:test";
import {
	DEPOSIT_FEE_FIXED_MICRO_USD,
	DEPOSIT_MARGIN_CAP_MICRO_USD,
} from "@ryu/auth/lib/plans";
import { formatMessage } from "@ryu/i18n/core";
import { I18nProvider, type LiteralMessage } from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";
import { CreditsView } from "./credits.tsx";
import { topupFeeCaption } from "./credits-topup-caption.ts";

const english: LiteralMessage = (source, values = {}) =>
	formatMessage(source, values, "en");

/** Intl separates the amount and the sign with a no-break space. */
const plainSpaces = (text: string): string => text.replaceAll(" ", " ");

describe("topupFeeCaption", () => {
	test("keeps the published English amounts", () => {
		const caption = topupFeeCaption(english, "en");
		expect(caption).toContain("or $5 minimum deposit fee");
		expect(caption).toContain("Ryu keeps at most $10 of it");
	});

	test("formats the policy amounts for German", () => {
		const caption = plainSpaces(topupFeeCaption(english, "de"));
		expect(caption).toContain("or 5 $ minimum deposit fee");
		expect(caption).toContain("at most 10 $ of it");
		expect(caption).not.toContain("$5");
	});

	test("reads the amounts from the plan constants", () => {
		expect(DEPOSIT_FEE_FIXED_MICRO_USD).toBe(5_000_000);
		expect(DEPOSIT_MARGIN_CAP_MICRO_USD).toBe(10_000_000);
		const caption = topupFeeCaption((source) => source, "en");
		expect(caption).toContain("{minimumFee}");
		expect(caption).toContain("{marginCap}");
	});
});

describe("CreditsView Add credits caption", () => {
	test("renders the German amounts under the German pack", () => {
		const html = plainSpaces(
			renderToStaticMarkup(
				<I18nProvider initialPackId="official/de">
					<CreditsView />
				</I18nProvider>
			)
		);
		expect(html).toContain("5 $");
		expect(html).toContain("10 $");
		expect(html).not.toContain("$5 minimum");
		expect(html).not.toContain("at most $10");
	});
});
