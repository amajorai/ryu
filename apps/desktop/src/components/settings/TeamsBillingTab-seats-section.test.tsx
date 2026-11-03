import { afterEach, describe, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import { renderToStaticMarkup } from "react-dom/server";
import { formatWholeUsd } from "@/src/lib/billing-amounts.ts";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../../packages/i18n/src/active-locale.ts";
import { TeamsBillingSeatsSection } from "./TeamsBillingTab-seats-section.tsx";

const runtime = {
	direction: "ltr" as const,
	locale: "de",
	translate(source: string, values?: MessageValuesInput, fallback?: string) {
		return formatMessage(fallback ?? source, values, "de");
	},
};

afterEach(() => {
	unregisterActiveI18nRuntime(runtime);
});

function renderSeats(): string {
	return renderToStaticMarkup(
		<TeamsBillingSeatsSection
			currentSeats={5}
			includedCreditBundle={1000}
			organizationPlanId="teams"
			seatStatus={{
				allocatedSeats: 3,
				availableSeats: 2,
				billedSeats: 5,
				bonusExpiresAt: null,
				bonusSeats: 0,
				canInvite: true,
				includedCreditPoolMicroUsd: null,
				includedSeats: 5,
				invitationBlockedReason: null,
				memberCount: 2,
				minRequired: 3,
				minSeats: 5,
				organizationId: "org-1",
				overAllocated: false,
				pendingInvitations: 1,
				pendingSeatReservations: 0,
				plan: "teams",
			}}
		/>
	);
}

describe("Teams billing seats section", () => {
	test("the shared pool amount is the locale's currency form", () => {
		registerActiveI18nRuntime(runtime);
		const markup = renderSeats();
		const amount = formatWholeUsd(1000);
		expect(amount).toMatch(/^1\.000\s\$$/u);
		expect(markup).toContain(`the shared pool adds ${amount} for`);
		expect(markup).not.toContain("$1000");
	});

	test("the allocation counter is one whole message", () => {
		expect(renderSeats()).toContain(">3 of 5</span>");
	});
});
