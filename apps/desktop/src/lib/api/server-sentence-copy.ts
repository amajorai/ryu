import { translate as tl } from "@ryu/i18n/core";

// Recognises the Teams seat verdicts the control plane still writes as
// finished English with spliced plurals (`validateSeatChange` in
// packages/api/src/lib/billing-scope.ts, sent as the `error` of a refused seat
// checkout or seat change) and returns them as whole ICU plural messages in
// the reader's language. Any other text is returned unchanged. The web client
// keeps a matching copy (apps/web/src/lib/server-sentence-copy.ts);
// both tests run the real `validateSeatChange` output through it, so a change
// to the server English fails here instead of showing English to readers.

const OVER_MEMBERS =
	/^Your organization has (\d+) members?(?: and (\d+) pending seat claims?)?(?:, with (\d+) negotiated seats? included)?\. Allocate at least (\d+) billed seats? or remove members first\.$/u;
const BELOW_PLAN_MINIMUM = /^The Teams plan requires at least (\d+) seats?\.$/u;
const ABOVE_SELF_SERVE =
	/^Self-serve Teams covers up to (\d+) seats?\. Talk to sales for (\d+) — enterprise pricing is lower per seat at that size\.$/u;
const NOT_A_SEAT_COUNT = "Seat count must be a positive whole number.";

function overMembers(
	members: number,
	pending: number | null,
	bonus: number | null,
	minRequired: number
): string {
	const values = {
		bonus: bonus ?? 0,
		members,
		minRequired,
		pending: pending ?? 0,
	};
	if (pending !== null && bonus !== null) {
		return tl(
			"Your organization has {members, plural, one {# member} other {# members}} and {pending, plural, one {# pending seat claim} other {# pending seat claims}}, with {bonus, plural, one {# negotiated seat} other {# negotiated seats}} included. Allocate at least {minRequired, plural, one {# billed seat} other {# billed seats}} or remove members first.",
			values
		);
	}
	if (pending !== null) {
		return tl(
			"Your organization has {members, plural, one {# member} other {# members}} and {pending, plural, one {# pending seat claim} other {# pending seat claims}}. Allocate at least {minRequired, plural, one {# billed seat} other {# billed seats}} or remove members first.",
			values
		);
	}
	if (bonus !== null) {
		return tl(
			"Your organization has {members, plural, one {# member} other {# members}}, with {bonus, plural, one {# negotiated seat} other {# negotiated seats}} included. Allocate at least {minRequired, plural, one {# billed seat} other {# billed seats}} or remove members first.",
			values
		);
	}
	return tl(
		"Your organization has {members, plural, one {# member} other {# members}}. Allocate at least {minRequired, plural, one {# billed seat} other {# billed seats}} or remove members first.",
		values
	);
}

const count = (digits: string | undefined): number | null =>
	digits === undefined ? null : Number(digits);

function localizeSentence(message: string): string {
	if (message === NOT_A_SEAT_COUNT) {
		return tl("Seat count must be a positive whole number.");
	}
	const over = OVER_MEMBERS.exec(message);
	if (over) {
		return overMembers(
			Number(over[1]),
			count(over[2]),
			count(over[3]),
			Number(over[4])
		);
	}
	const below = BELOW_PLAN_MINIMUM.exec(message);
	if (below) {
		return tl(
			"The Teams plan requires at least {seats, plural, one {# seat} other {# seats}}.",
			{ seats: Number(below[1]) }
		);
	}
	const above = ABOVE_SELF_SERVE.exec(message);
	if (above) {
		return tl(
			"Self-serve Teams covers up to {max, plural, one {# seat} other {# seats}}. Talk to sales for {requested} — enterprise pricing is lower per seat at that size.",
			{ max: Number(above[1]), requested: Number(above[2]) }
		);
	}
	return message;
}

/** The server's seat-verdict sentence in the reader's language; other values
 * (and any unrecognised text) unchanged. */
export function localizeServerSentence<T>(message: T): T | string {
	return typeof message === "string" ? localizeSentence(message) : message;
}
