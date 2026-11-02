import { translate as tr } from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";
import type { PassportStamp, StampMarking } from "./passport-model.ts";
import { spokenDate } from "./passport-model-dates.ts";

/** A stamp marking as the stamp prints it ("ENTRY DENIED"), in the UI language. */
export function markingLabel(
	marking: StampMarking,
	tl: LiteralMessage = tr
): string {
	switch (marking) {
		case "applied":
			return tl("APPLIED");
		case "arrived":
			return tl("ARRIVED – AWAITING ENTRY");
		case "denied":
			return tl("ENTRY DENIED");
		case "exited":
			return tl("EXITED");
		default:
			return tl("VISA PROCESSING");
	}
}

/** The same marking in sentence case ("Entry denied"), for tables and speech. */
export function markingName(
	marking: StampMarking,
	tl: LiteralMessage = tr
): string {
	switch (marking) {
		case "applied":
			return tl("Applied");
		case "arrived":
			return tl("Arrived – awaiting entry");
		case "denied":
			return tl("Entry denied");
		case "exited":
			return tl("Exited");
		default:
			return tl("Visa processing");
	}
}

/** The marking in plain words, for the notes page and the record. */
export function markingMeaning(
	marking: StampMarking,
	tl: LiteralMessage = tr
): string {
	switch (marking) {
		case "applied":
			return tl("Sent; waiting on the agent");
		case "arrived":
			return tl("The agent replied; your turn");
		case "denied":
			return tl("The last run failed or stopped");
		case "exited":
			return tl("Nothing is pending");
		default:
			return tl("The agent is working now");
	}
}

/** "Unassigned": the country for conversations with no agent. */
export function unassignedLabel(tl: LiteralMessage = tr): string {
	return tl("Unassigned");
}

/** A sentence the stamp button reads out. */
export function stampLabel(
	stamp: PassportStamp,
	countryName: string | null,
	tl: LiteralMessage = tr
): string {
	const values = {
		country: countryName ?? unassignedLabel(tl),
		entered: spokenDate(stamp.entryAt),
		last: spokenDate(stamp.latestAt),
		marking: markingName(stamp.marking, tl),
		title: stamp.thread.title || tl("Untitled conversation"),
	};
	return stamp.latestAt === stamp.entryAt
		? tl("{title}, {country}, {marking}, entered {entered}", values)
		: tl(
				"{title}, {country}, {marking}, entered {entered}, last {last}",
				values
			);
}
