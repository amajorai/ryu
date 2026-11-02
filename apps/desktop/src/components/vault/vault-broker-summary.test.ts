import { expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import type { VaultCardApproval } from "@/src/lib/api/vault.ts";
import { cardApprovalSummary, proposalDetail } from "./vault-broker-summary.ts";

// A German stub catalog: each fragment is its own whole message, so the
// joined row carries no English connective words around localized values.
const GERMAN: Record<string, string> = {
	"agent request": "Agent-Anfrage",
	"at {host}": "bei {host}",
	card: "Karte",
	"expires {date}": "läuft am {date} ab",
	"field {field}": "Feld {field}",
	reveal: "Anzeigen",
};
const german = (message: string, values?: MessageValuesInput) =>
	formatMessage(GERMAN[message] ?? message, values);
const english = (message: string, values?: MessageValuesInput) =>
	formatMessage(message, values);

const approval: VaultCardApproval = {
	agent: "agent-1",
	channel: "reveal",
	environment: "prod",
	field: "cvc",
	id: "c-1",
	key: "CARD",
	last4: "4242",
	merchantHost: "shop.example",
	requestExpiresAt: "not-a-date",
	requestedAt: "not-a-date",
	requester: "ops",
	status: "pending",
};

test("a card approval row under de has no English fragments", () => {
	const row = cardApprovalSummary(approval, german);
	expect(row).toBe(
		"Karte •••• 4242 · bei shop.example · Anzeigen · Feld cvc · ops · läuft am not-a-date ab"
	);
	for (const word of [" at ", "field", "expires", "reveal", "card "]) {
		expect(row).not.toContain(word);
	}
});

test("the broker channel reads as a translated agent request, brand kept", () => {
	const row = cardApprovalSummary(
		{ ...approval, brand: "Visa", channel: "broker", field: undefined },
		german
	);
	expect(row).toBe(
		"Visa •••• 4242 · bei shop.example · Agent-Anfrage · ops · läuft am not-a-date ab"
	);
});

test("English keeps the original row wording", () => {
	expect(cardApprovalSummary(approval, english)).toBe(
		"card •••• 4242 · at shop.example · reveal · field cvc · ops · expires not-a-date"
	);
});

test("the proposal detail line translates its expiry", () => {
	expect(proposalDetail("Services: api", "ops", "not-a-date", german)).toBe(
		"Services: api · ops · läuft am not-a-date ab"
	);
});
