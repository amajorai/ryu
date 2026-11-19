import { expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import { standaloneUnavailableDescription } from "./HostedStandaloneAppEntry-copy.ts";

const tl: LiteralMessage = (source) => `[${source}]`;

test("each unavailable reason is one whole catalogued description", () => {
	expect(standaloneUnavailableDescription("load-failed", tl)).toBe(
		"[Ryu could not load this app from the active node. The app and its data remain safe in Ryu.]"
	);
	expect(standaloneUnavailableDescription("missing", tl)).toBe(
		"[This app is disabled or no longer installed on the active node. The app and its data remain safe in Ryu.]"
	);
});
