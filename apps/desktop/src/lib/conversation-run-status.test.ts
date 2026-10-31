import { describe, expect, it } from "bun:test";
import { formatMessage } from "@ryu/i18n";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	conversationRunStatusDescription,
	conversationRunStatusMeta,
} from "./conversation-run-status.ts";

const tl: LiteralMessage = (source, values) =>
	formatMessage(source, values ?? {});

describe("conversationRunStatusMeta", () => {
	it("keeps a startup interruption distinct from a failure", () => {
		expect(conversationRunStatusMeta("interrupted")).toMatchObject({
			label: "Interrupted",
			needsAttention: true,
			isRunning: false,
		});
		expect(conversationRunStatusMeta("interrupted")?.description).toContain(
			"continue it manually"
		);
	});

	it("makes an input wait explicit and non-resumable", () => {
		expect(conversationRunStatusMeta("awaiting_input")).toMatchObject({
			label: "Needs input",
			needsAttention: true,
			isRunning: false,
		});
	});

	it("names a status it does not know yet", () => {
		const meta = conversationRunStatusMeta("waiting_on_quota");
		expect(meta).toMatchObject({ label: "waiting on quota" });
		expect(meta && conversationRunStatusDescription(meta, tl)).toBe(
			"Run status: waiting on quota."
		);
	});
});
