import { describe, expect, test } from "bun:test";
import { I18nProvider } from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";
import { WrappedPass } from "./wrapped-pass.tsx";

function narrowUnit(locale: string, unit: string, value: number): string {
	return new Intl.NumberFormat(locale, {
		maximumFractionDigits: 1,
		minimumFractionDigits: unit === "hour" ? 1 : 0,
		style: "unit",
		unit,
		unitDisplay: "narrow",
		useGrouping: false,
	}).format(value);
}

describe("WrappedPass stats", () => {
	test("keep English hours and days unchanged", () => {
		const markup = renderToStaticMarkup(
			<WrappedPass agentHours={12.5} name="Ada" still streakLongest={30} />
		);
		expect(markup).toContain(">12.5h<");
		expect(markup).toContain(">30d<");
	});

	test("format hours and days in the UI locale", () => {
		const markup = renderToStaticMarkup(
			<I18nProvider initialLocale="de" initialPackId={null}>
				<WrappedPass agentHours={12.5} name="Ada" still streakLongest={30} />
			</I18nProvider>
		);
		const hours = narrowUnit("de", "hour", 12.5);
		expect(hours).toContain("12,5");
		expect(markup).toContain(`>${hours}<`);
		expect(markup).toContain(`>${narrowUnit("de", "day", 30)}<`);
		expect(markup).not.toContain(">12.5h<");
	});
});
