import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { I18nProvider } from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CommissionView } from "../../utils/api-client.ts";
import { RecentCommissionsSection } from "./cash-commission-sections.tsx";
import {
	commissionSourceLabel,
	commissionStatusLabel,
} from "./commission-labels.ts";

// A commission row printed the server's raw enums ("subscription", "paid") as
// its title and status, so a German affiliate saw lowercase English.

function shippedCatalog(locale: string): Record<string, string> {
	const path = fileURLToPath(
		new URL(`../../../../i18n/locales/${locale}.json`, import.meta.url)
	);
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
}

function commission(
	id: string,
	sourceType: string,
	status: string
): CommissionView {
	return {
		commissionAmountMinor: 1200,
		createdAt: "2026-10-01T00:00:00.000Z",
		currency: "usd",
		grossAmountMinor: 6000,
		id,
		occurredAt: "2026-10-01T00:00:00.000Z",
		payoutId: "",
		referredUserId: "referred",
		referrerUserId: "referrer",
		sourceRef: `ref-${id}`,
		sourceType,
		status,
	} as CommissionView;
}

const identity = (source: string) => source;

describe("commission labels", () => {
	test("known enums get title-case labels, unknown ones a generic label", () => {
		expect(commissionSourceLabel("subscription", identity)).toBe(
			"Subscription"
		);
		expect(commissionSourceLabel("marketplace", identity)).toBe("Marketplace");
		expect(commissionSourceLabel("subscription_invoice", identity)).toBe(
			"Other source"
		);
		expect(commissionStatusLabel("paid", identity)).toBe("Paid");
		expect(commissionStatusLabel("reversed", identity)).toBe("Reversed");
		expect(commissionStatusLabel("rejected", identity)).toBe("Rejected");
		expect(commissionStatusLabel("on_hold", identity)).toBe("Unknown status");
	});

	test("recent commission rows render in German", () => {
		const html = renderToStaticMarkup(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="de"
				initialPackId={null}
				manageDocument={false}
				overlays={{ de: shippedCatalog("de") }}
			>
				<RecentCommissionsSection
					commissions={[
						commission("a", "subscription", "paid"),
						commission("b", "marketplace", "reversed"),
						commission("c", "subscription", "rejected"),
					]}
				/>
			</I18nProvider>
		);
		for (const word of [
			"Abo",
			"Marktplatz",
			"Bezahlt",
			"Storniert",
			"Abgelehnt",
		]) {
			expect(html).toContain(word);
		}
		for (const raw of [
			">subscription<",
			">marketplace<",
			">paid<",
			">reversed<",
		]) {
			expect(html).not.toContain(raw);
		}
	});
});
