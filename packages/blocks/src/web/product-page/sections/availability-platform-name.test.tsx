import { expect, test } from "bun:test";
import { I18nProvider } from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";
import { AvailabilityPlatformName } from "./availability-platform-name.tsx";

function render(locale: string, senseId?: string): string {
	return renderToStaticMarkup(
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale={locale}
			manageDocument={false}
		>
			<AvailabilityPlatformName platform="Watch" senseId={senseId} />
		</I18nProvider>
	);
}

test("a platform with a sense id reads through the keyed sense", () => {
	expect(render("de", "hardware.deviceWatch")).toBe("Uhr");
});

test("a platform without a sense id stays literal text", () => {
	expect(render("de")).toBe("Watch");
	expect(render("en", "hardware.deviceWatch")).toBe("Watch");
});
