import { describe, expect, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";
import { waitlistRefusal } from "./access-message.ts";

// A German stub catalog, so the test does not depend on the generated packs.
const german = createCliTranslator("de", {
	"Sign in first with `ryu-cli login`.": "Zuerst mit `ryu-cli login` anmelden.",
	"Your account is still on the waitlist.":
		"Ihr Konto steht noch auf der Warteliste.",
	"Ryu could not verify waitlist access. Try again when the control plane is reachable.":
		"Ryu konnte den Zugang zur Warteliste nicht prüfen. Versuche es erneut, sobald die Steuerungsebene erreichbar ist.",
});
const english = createCliTranslator(null, null);

describe("waitlistRefusal", () => {
	test("each refusal is a whole German sentence under a German translator", () => {
		expect(waitlistRefusal("unauthenticated", german.tr)).toBe(
			"Zuerst mit `ryu-cli login` anmelden."
		);
		expect(waitlistRefusal("pending", german.tr)).toBe(
			"Ihr Konto steht noch auf der Warteliste."
		);
		expect(waitlistRefusal("unavailable", german.tr)).toBe(
			"Ryu konnte den Zugang zur Warteliste nicht prüfen. Versuche es erneut, sobald die Steuerungsebene erreichbar ist."
		);
	});

	test("English stays the source text", () => {
		expect(waitlistRefusal("unauthenticated", english.tr)).toBe(
			"Sign in first with `ryu-cli login`."
		);
		expect(waitlistRefusal("pending", english.tr)).toBe(
			"Your account is still on the waitlist."
		);
	});
});
