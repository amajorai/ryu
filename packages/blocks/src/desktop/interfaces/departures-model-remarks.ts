import { translate as tr } from "@ryu/i18n/lite";
import type { InterfaceEvent } from "@ryuhq/protocol/interfaces";
import { flightDuration, parseTime } from "./departures-model-format.ts";
import type { RemarkPart } from "./departures-model-types.ts";

/** Remark parts for scheduled runs on the board, split from departures-model.ts. */

export const plain = (text: string): RemarkPart => ({ emphasis: false, text });
export const strong = (text: string): RemarkPart => ({ emphasis: true, text });

function runsThatDay(count: number): RemarkPart {
	return plain(
		tr("{count, plural, one {# run that day} other {# runs that day}}", {
			count,
		})
	);
}

export function eventRemark(event: InterfaceEvent): RemarkPart[] {
	const parts: RemarkPart[] = [];
	const label = event.label?.trim();
	if (label) {
		parts.push(plain(label));
	}
	if (event.count && event.count > 1) {
		parts.push(runsThatDay(event.count));
	}
	return parts;
}

/** A past run's remark: a failure is the news; a success says how long it took. */
export function pastEventRemark(event: InterfaceEvent): RemarkPart[] {
	if (event.outcome === "failure") {
		return [strong("Run failed")];
	}
	const start = parseTime(event.start);
	const end = parseTime(event.end);
	const parts = [plain("Done")];
	if (start !== null && end !== null && end > start) {
		parts.push(
			plain(tr("Ran {duration}", { duration: flightDuration(end - start) }))
		);
	}
	if (event.count && event.count > 1) {
		parts.push(runsThatDay(event.count));
	}
	return parts;
}
