import { expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import { CrmError } from "@/src/lib/api/crm.ts";
import { crmValidationText } from "./crm-validation-text.ts";

const DE: Record<string, string> = {
	"{field} is not a valid email address.":
		"{field} ist keine gültige E-Mail-Adresse.",
	"{field} must be a number.": "{field} muss eine Zahl sein.",
	"{error} {count, plural, one {# more field also needs fixing.} other {# more fields also need fixing.}}":
		"{error} {count, plural, one {# weiteres Feld muss ebenfalls korrigiert werden.} other {# weitere Felder müssen ebenfalls korrigiert werden.}}",
	"Close date (deal)": "Abschlussdatum",
	Email: "E-Mail",
};

function stubTl(catalog: Record<string, string>): LiteralMessage {
	return (source, values) =>
		formatMessage(catalog[source] ?? source, values, "de");
}

const FIELDS = [
	{ name: "Email", slug: "email" },
	{ name: "Close date", slug: "close_date" },
	{ name: "Score", slug: "score" },
];

test("a known field rejection reads as a whole sentence naming the field", () => {
	const tl = stubTl(DE);
	expect(
		crmValidationText(
			new CrmError(422, "email: not a valid email address"),
			FIELDS,
			tl
		)
	).toBe("E-Mail ist keine gültige E-Mail-Adresse.");
	expect(
		crmValidationText(
			new CrmError(422, "close_date: expected a number"),
			FIELDS,
			tl
		)
	).toBe("Abschlussdatum muss eine Zahl sein.");
	expect(
		crmValidationText(
			new CrmError(422, "score: expected a number"),
			FIELDS,
			stubTl({})
		)
	).toBe("Score must be a number.");
});

test("other failed fields are counted after the first", () => {
	expect(
		crmValidationText(
			new CrmError(
				422,
				"email: not a valid email address (and 2 more field errors)"
			),
			FIELDS,
			stubTl(DE)
		)
	).toBe(
		"E-Mail ist keine gültige E-Mail-Adresse. 2 weitere Felder müssen ebenfalls korrigiert werden."
	);
});

test("an unknown reason or field keeps the backend message", () => {
	const tl = stubTl(DE);
	expect(
		crmValidationText(
			new CrmError(422, 'stage: "Maybe" is not one of this field\'s options'),
			FIELDS,
			tl
		)
	).toBe('stage: "Maybe" is not one of this field\'s options');
	expect(
		crmValidationText(new CrmError(422, "phone: expected a number"), FIELDS, tl)
	).toBe("phone: expected a number");
	expect(crmValidationText("Network down", FIELDS, tl)).toBe("Network down");
});
