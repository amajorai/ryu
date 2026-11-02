import { describe, expect, test } from "bun:test";
import { officialCliLiteralCatalog } from "@ryu/i18n/official-catalog/cli";
import { createCliTranslator } from "../i18n/translate.ts";
import { chatPartsSchema } from "./chatTranscript.ts";
import { localizeCoreError } from "./coreErrorText.ts";

const german = createCliTranslator("de", officialCliLiteralCatalog("de"));
const english = createCliTranslator(null, null);

const CREDITS_BODY =
	"Your organization's Ryu credits are exhausted. Open Credits in Settings to top up, or choose a BYOK or local model, then retry.";

// The persisted part Core writes for an ACP credits-exhausted turn
// (parts_accumulator.rs `error`, AcpFailure::i18n_wire).
const creditsPart = {
	type: "error",
	code: "ryu_credits_exhausted",
	title: "Ryu credits exhausted",
	message: CREDITS_BODY,
	i18n: {
		title: { message: "Ryu credits exhausted", args: {} },
		body: [{ message: CREDITS_BODY, args: {} }],
		join: "sentences",
	},
};

describe("localizeCoreError", () => {
	test("renders a persisted ACP failure from its Core messages in German", () => {
		const [part] = chatPartsSchema.parse([creditsPart]);
		if (part?.type !== "error") {
			throw new Error("expected an error part");
		}
		const localized = localizeCoreError(part, german);
		expect(localized.message).toContain("Ryu-Credits");
		expect(localized.message).not.toContain("exhausted");
		expect(localized.title).not.toBe("Ryu credits exhausted");
	});

	test("fills a templated body's raw detail verbatim", () => {
		const localized = localizeCoreError(
			{
				message: "unused English",
				i18n: {
					title: { message: "Agent failed to start" },
					body: [
						{
							message:
								"The agent could not start, so the message was not sent. Send it again to retry. (details: {detail})",
							args: { detail: "spawn ENOENT" },
						},
					],
					join: "sentences",
				},
			},
			german
		);
		expect(localized.title).toBe("Agent konnte nicht gestartet werden");
		expect(localized.message).toContain("spawn ENOENT");
		expect(localized.message).toContain("Der Agent");
	});

	test("translates a live frame's static English body as a literal", () => {
		expect(localizeCoreError({ message: CREDITS_BODY }, german).message).toBe(
			german.tr(CREDITS_BODY)
		);
		expect(german.tr(CREDITS_BODY)).not.toBe(CREDITS_BODY);
	});

	test("keeps the stored English for raw errors and malformed wires", () => {
		expect(
			localizeCoreError({ message: "HTTP 503 · upstream overloaded" }, german)
				.message
		).toBe("HTTP 503 · upstream overloaded");
		expect(
			localizeCoreError(
				{
					message: "stored",
					title: "Stored title",
					i18n: { title: { message: "" }, body: [{ args: {} }] },
				},
				english
			)
		).toEqual({ message: "stored", title: "Stored title" });
	});

	test("joins line bodies with newlines", () => {
		expect(
			localizeCoreError(
				{
					message: "x",
					i18n: {
						title: { message: "T" },
						body: [{ message: "one" }, { message: "two" }],
						join: "lines",
					},
				},
				english
			).message
		).toBe("one\ntwo");
	});
});
