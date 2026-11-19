import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	missingFeaturesList,
	subscriptionRunStatusSentence,
} from "./SubscriptionRunPanel-status.ts";

const tl: LiteralMessage = (source, values) =>
	`[${source}]${values ? JSON.stringify(values) : ""}`;

describe("subscriptionRunStatusSentence", () => {
	test("Core's run statuses are whole sentences", () => {
		expect(subscriptionRunStatusSentence("running", tl)).toBe(
			"[Status: Running]"
		);
		expect(subscriptionRunStatusSentence("done", tl)).toBe(
			"[Status: Completed]"
		);
		expect(subscriptionRunStatusSentence("error", tl)).toBe("[Status: Failed]");
		expect(subscriptionRunStatusSentence("stopped", tl)).toBe(
			"[Status: Stopped]"
		);
	});

	test("an unknown status still shows through the template", () => {
		expect(subscriptionRunStatusSentence("queued", tl)).toBe(
			'[Status: {status}]{"status":"queued"}'
		);
	});
});

describe("missingFeaturesList", () => {
	const ALL = {
		diffInRyu: true,
		followUp: true,
		liveScreen: true,
		liveStatus: true,
		pullRequestInRyu: true,
		runLog: true,
		ryuCredits: true,
		stopFromRyu: true,
	};

	test("each missing feature is translated before the list is joined", () => {
		expect(
			missingFeaturesList({ ...ALL, followUp: false, liveScreen: false }, tl)
		).toBe("[live screen] and [follow-up messages]");
	});

	test("nothing missing is no list", () => {
		expect(missingFeaturesList(ALL, tl)).toBeNull();
	});
});
