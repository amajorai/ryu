import { pickAllowlistedFields } from "@ryu/app-host/allowlist-projection";
import type { EventChannel } from "@/src/lib/api/eventStream.ts";

// Which node event channels an app frame may follow through
// `shell.eventsSubscribe`, and what one event looks like when it leaves the host.
//
// The method rides the grant `shell:integrate` (sidebar and navigation), which
// any app may hold. The channels are feeds with grants of their own, so the
// shell grant alone opens none of them. A channel is served only when the app
// also holds the grant that feed needs, among the grants the Gateway approved.

/** The grant each served channel needs on top of `shell:integrate`. */
const SHELL_EVENT_CHANNEL_GRANTS: ReadonlyMap<EventChannel, string> = new Map<
	EventChannel,
	string
>([
	["activity", "activity:read"],
	// The approvals read and the inbox read (`notifications.list`) share a grant.
	["approvals", "approvals:crud"],
	["notifications", "approvals:crud"],
	["monitors", "monitors:crud"],
]);
// Absent from the table, so never served to an app frame, whatever it holds.
// `downloads` has no grant that reads it, and its rows hold URLs and local file
// paths. The `quests` grant is open to any app, so it cannot be the gate here.
// `navigation` is the shell's own channel.

/** The fields of an event the frame receives. Core's row is not one of them. */
const SHELL_EVENT_FIELDS: readonly string[] = ["channel"];

/**
 * The channels of `requested` this app is served, in table order. An unknown
 * name, a channel that is never served and a channel whose grant the app does
 * not hold are all dropped without an error, as an unknown name was before.
 */
export function servedShellEventChannels(
	requested: readonly string[],
	approvedGrants: readonly string[]
): EventChannel[] {
	const served: EventChannel[] = [];
	for (const [channel, grant] of SHELL_EVENT_CHANNEL_GRANTS) {
		if (requested.includes(channel) && approvedGrants.includes(grant)) {
			served.push(channel);
		}
	}
	return served;
}

/**
 * The text of one event for the frame. It is a change signal that names the
 * channel and nothing else. The row Core sent stays on the host, and the app
 * reads rows through the feed's own method (for example `activity.list`),
 * which has its own grant, its own field list and its own redaction.
 */
export function shellEventSignal(event: {
	channel: EventChannel;
	data: unknown;
}): string {
	return JSON.stringify(pickAllowlistedFields(event, SHELL_EVENT_FIELDS));
}
