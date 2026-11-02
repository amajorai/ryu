import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import type { CloudTaskBackendView } from "@/src/lib/api/cloud-task-backends.ts";
import { subscriptionBackendDescription } from "./subscription-backend-description.ts";

const german: Record<string, string> = JSON.parse(
	readFileSync(
		new URL("../../../../../packages/i18n/locales/de.json", import.meta.url),
		"utf8"
	)
);

const englishTl = (source: string, values?: MessageValuesInput) =>
	formatMessage(source, values, "en");
const germanTl = (source: string, values?: MessageValuesInput) =>
	formatMessage(german[source] ?? source, values, "de");

const backend = (
	overrides: Partial<CloudTaskBackendView>
): CloudTaskBackendView => ({
	backend: "anthropic-subscription-cli",
	billing: "user-plan",
	cooldownSecondsRemaining: null,
	features: {
		diffInRyu: false,
		followUp: false,
		liveScreen: false,
		liveStatus: false,
		pullRequestInRyu: false,
		runLog: false,
		ryuCredits: false,
		stopFromRyu: false,
	},
	installed: true,
	signIn: "subscription",
	signInCommand: "claude login",
	...overrides,
});

describe("subscription backend row description", () => {
	test("keeps the English row text", () => {
		expect(
			subscriptionBackendDescription(
				backend({ cooldownSecondsRemaining: 270 }),
				englishTl
			)
		).toBe("Signed in with your plan · Usage limit reached; skipped for 5 min");
		expect(
			subscriptionBackendDescription(backend({ installed: false }), englishTl)
		).toBe("Not installed on this node · Install it, then run `claude login`");
	});

	test("translates each part on its own under de", () => {
		const cooling = subscriptionBackendDescription(
			backend({ cooldownSecondsRemaining: 270 }),
			germanTl
		);
		const [signIn, cooldown] = cooling.split(" · ");
		expect(signIn).toBe(german["Signed in with your plan"]);
		expect(cooldown).toBe(
			formatMessage(
				german["Usage limit reached; skipped for {minutes} min"] ?? "",
				{ minutes: 5 },
				"de"
			)
		);
		expect(cooldown).not.toContain("Usage limit");
		const missing = subscriptionBackendDescription(
			backend({ installed: false }),
			germanTl
		);
		expect(missing.split(" · ")[0]).toBe(german["Not installed on this node"]);
		expect(missing).toContain("`claude login`");
	});
});
