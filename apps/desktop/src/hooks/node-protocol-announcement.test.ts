import { describe, expect, test } from "bun:test";
import { formatMessage, type LiteralMessage } from "@ryu/i18n";
import {
	assessNodeProtocol,
	CLIENT_ACCEPTED_RANGE,
	CORE_PROTOCOL_RANGE,
	negotiateProtocol,
} from "@ryuhq/core-client/node-protocol.ts";
import { nodeProtocolAnnouncement } from "./node-protocol-announcement.ts";

// A stand-in translator that marks every sentence it was asked for, so the
// assertions prove each message went through `tl()` as one whole sentence.
const tl: LiteralMessage = (source, values) =>
	`[${formatMessage(source, values ?? {}, "en")}]`;

describe("nodeProtocolAnnouncement", () => {
	test("shows no card for a node on a shared protocol", () => {
		expect(
			nodeProtocolAnnouncement(assessNodeProtocol(CORE_PROTOCOL_RANGE), tl)
		).toBeNull();
	});

	test("shows no card for a node too old to report a range in this release", () => {
		expect(
			nodeProtocolAnnouncement(assessNodeProtocol(undefined), tl)
		).toBeNull();
	});

	test("tells the user to update the app when the node is above its range", () => {
		const node = {
			max: CLIENT_ACCEPTED_RANGE.max + 3,
			min: CLIENT_ACCEPTED_RANGE.max + 1,
		};
		const card = nodeProtocolAnnouncement(assessNodeProtocol(node), tl);
		expect(card?.id).toBe("system:app-outdated");
		expect(card?.title).toBe("[App needs updating]");
		expect(card?.body).toBe(
			`[Update this app. This node needs Ryu protocol ${node.min} or newer and this app speaks up to protocol ${CLIENT_ACCEPTED_RANGE.max}.]`
		);
		expect(card?.accent).toBe("var(--destructive)");
	});

	test("tells the user to update Core when the node is below the app's range", () => {
		// A later app that no longer accepts protocol 0, against a node without a range.
		const verdict = negotiateProtocol({ max: 3, min: 2 }, { max: 0, min: 0 });
		const card = nodeProtocolAnnouncement(verdict, tl);
		expect(card?.id).toBe("system:node-outdated");
		expect(card?.title).toBe("[Node needs updating]");
		expect(card?.body).toBe(
			"[Update Ryu Core on this node. It speaks Ryu protocol 0 and this app needs protocol 2 or newer.]"
		);
	});
});
