import { describe, expect, test } from "bun:test";
import {
	DESKTOP_TRIAL_INCLUDES,
	DESKTOP_TRIAL_LABEL,
} from "@ryu/auth/lib/plans";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	desktopTrialEndedTitle,
	desktopTrialIncludes,
	desktopTrialLabel,
} from "./desktop-trial-copy.ts";

const DE: Record<string, string> = {
	"Lifetime Desktop trial": "Lifetime-Desktop-Testversion",
	"Full desktop app access. Managed inference, credits and cloud nodes are not included.":
		"Voller Zugriff auf die Desktop-App. Verwaltete Inferenz, Guthaben und Cloud-Knoten sind nicht enthalten.",
	"Lifetime Desktop trial ended": "Lifetime-Desktop-Testversion beendet",
};

const english: LiteralMessage = (source) => source;
const german: LiteralMessage = (source) => DE[source] ?? source;

describe("desktop trial copy", () => {
	test("keeps the English literals equal to the auth constants", () => {
		expect(desktopTrialLabel(english)).toBe(DESKTOP_TRIAL_LABEL);
		expect(desktopTrialIncludes(english)).toBe(DESKTOP_TRIAL_INCLUDES);
		expect(desktopTrialEndedTitle(english)).toBe(
			`${DESKTOP_TRIAL_LABEL} ended`
		);
	});

	test("returns whole translated sentences", () => {
		expect(desktopTrialLabel(german)).toBe("Lifetime-Desktop-Testversion");
		expect(desktopTrialIncludes(german)).toBe(
			"Voller Zugriff auf die Desktop-App. Verwaltete Inferenz, Guthaben und Cloud-Knoten sind nicht enthalten."
		);
		expect(desktopTrialEndedTitle(german)).toBe(
			"Lifetime-Desktop-Testversion beendet"
		);
	});
});
