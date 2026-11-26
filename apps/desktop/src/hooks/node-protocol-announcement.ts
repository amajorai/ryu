// The sidebar card shown when this app and the active node share no protocol.
//
// The verdict comes from the protocol range in `/api/health`
// (`@ryuhq/core-client/node-protocol.ts`), not from release versions. It names
// the side that has to update, so the card says which one instead of a generic
// "something is incompatible". A node on a shared protocol gets no card.
//
// The card clamps its body to two lines, so each body starts with what to do.

import { AlertCircleIcon } from "@hugeicons/core-free-icons";
import type { LiteralMessage } from "@ryu/i18n/react";
import type { ProtocolVerdict } from "@ryuhq/core-client/node-protocol.ts";
import type { SystemAnnouncement } from "./useSystemAnnouncements.ts";

/** The card for `verdict`, or null when the two sides share a protocol. */
export function nodeProtocolAnnouncement(
	verdict: ProtocolVerdict,
	tl: LiteralMessage
): SystemAnnouncement | null {
	if (verdict.compatible) {
		return null;
	}
	if (verdict.update === "node") {
		return {
			accent: "var(--destructive)",
			body: tl(
				"Update Ryu Core on this node. It speaks Ryu protocol {nodeProtocol} and this app needs protocol {appProtocol} or newer.",
				{
					appProtocol: String(verdict.client.min),
					nodeProtocol: String(verdict.node.max),
				}
			),
			icon: AlertCircleIcon,
			id: "system:node-outdated",
			title: tl("Node needs updating"),
		};
	}
	return {
		accent: "var(--destructive)",
		body: tl(
			"Update this app. This node needs Ryu protocol {nodeProtocol} or newer and this app speaks up to protocol {appProtocol}.",
			{
				appProtocol: String(verdict.client.max),
				nodeProtocol: String(verdict.node.min),
			}
		),
		icon: AlertCircleIcon,
		id: "system:app-outdated",
		title: tl("App needs updating"),
	};
}
