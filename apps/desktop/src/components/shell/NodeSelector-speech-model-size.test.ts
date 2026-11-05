import { describe, expect, test } from "bun:test";

import { speechModelDetail } from "./NodeSelector-speech-model-size.ts";

describe("speechModelDetail", () => {
	test("keeps the English size", () => {
		expect(speechModelDetail("whisper", "en")).toBe("whisper · 484 MB");
	});

	test("uses the locale's unit name", () => {
		const russian = speechModelDetail("whisper", "ru");
		expect(russian).toStartWith("whisper · 484");
		expect(russian).not.toContain("MB");
		expect(russian).toBe(
			`whisper · ${new Intl.NumberFormat("ru", {
				maximumFractionDigits: 0,
				style: "unit",
				unit: "megabyte",
				unitDisplay: "short",
			}).format(484)}`
		);
	});
});
