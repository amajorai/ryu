// The cover caption is the booklet sense of "Cover", keyed apart from the
// catalog's image-fit "Cover" so no locale shows "fill" on a passport.
import { describe, expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import { spreadCaption } from "./passport-interface-pages.tsx";

const GERMAN: Record<string, string> = {
	Cover: "Füllen",
	"Page {first} of {last}": "Seite {first} von {last}",
	"Passport cover": "Passumschlag",
};

const german: LiteralMessage = (source, values) =>
	formatMessage(GERMAN[source] ?? source, values);

const COVER = { left: null, right: 0 } as never;

describe("spreadCaption cover", () => {
	test("German shows the passport-cover translation, not image fit", () => {
		expect(spreadCaption(COVER, 6, german)).toBe("Passumschlag");
		expect(spreadCaption(undefined, 6, german)).toBe("Passumschlag");
	});

	test("English keeps the short caption", () => {
		expect(spreadCaption(COVER, 6)).toBe("Cover");
	});

	test("an untranslated locale falls back to the English caption", () => {
		const japanese: LiteralMessage = (source, values) =>
			formatMessage(source, values);
		expect(spreadCaption(COVER, 6, japanese)).toBe("Cover");
	});

	test("inside pages still use the page messages", () => {
		const page = { left: null, right: 4 } as never;
		expect(spreadCaption(page, 6, german)).toBe("Seite 4 von 5");
	});
});
