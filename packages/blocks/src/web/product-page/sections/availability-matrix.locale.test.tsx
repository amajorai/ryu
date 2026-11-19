// The availability tile's "Watch" is the wrist device (de "Uhr") and reads
// through the keyed `hardware.deviceWatch`. The bare catalog "Watch" is the
// observe verb (de "Beobachten").
import { expect, test } from "bun:test";
import { I18nProvider } from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProductProfile } from "../profile-types.ts";
import {
	DEVICES_PROFILE,
	MOBILE_PROFILE,
} from "../profiles-preview-surfaces.ts";
import { ProductAvailabilityMatrix } from "./availability-matrix.tsx";

/** Stand-in for the verb sense of the bare catalog row. */
const OVERLAYS = { de: { Watch: "Beobachten" } };

function render(
	locale: string,
	profile: ProductProfile = DEVICES_PROFILE
): string {
	const row = profile.availability?.find((entry) => entry.platform === "Watch");
	if (!row) {
		throw new Error("no Watch availability row");
	}
	return renderToStaticMarkup(
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale={locale}
			manageDocument={false}
			overlays={OVERLAYS}
		>
			<ProductAvailabilityMatrix rows={[row]} />
		</I18nProvider>
	);
}

test("the German devices page names the watch tile Uhr, not the verb", () => {
	const html = render("de");
	expect(html).toContain(">Uhr</h3>");
	expect(html).not.toContain("Beobachten");
});

test("the German mobile page names the watch tile Uhr too", () => {
	expect(render("de", MOBILE_PROFILE)).toContain(">Uhr</h3>");
});

test("the Japanese devices page names the watch tile ウォッチ", () => {
	expect(render("ja")).toContain(">ウォッチ</h3>");
});

test("English keeps the Watch tile", () => {
	expect(render("en")).toContain(">Watch</h3>");
});
