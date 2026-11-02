import { translate as tr } from "@ryu/i18n/lite";
import { threadStatusLabel } from "./interface-renderer.ts";
import { type QuizTile, threadTitle } from "./quiz-model.ts";

/** A tile's accessible name, by whether it is open, revealed or answering. */
export function tileLabel(
	tile: QuizTile,
	state: "answering" | "open" | "revealed",
	clueFirst = false
): string {
	const values = {
		category: tile.categoryName,
		state,
		status: tile.statusWord ?? threadStatusLabel(tile.status),
		title: threadTitle(tile.thread),
		value: String(tile.value),
	};
	if (clueFirst) {
		return state === "open"
			? tr("{value} clue, {category}: {title}. {status}.", values)
			: tr(
					"{state, select, answering {Clue answering} other {Clue revealed}}, {category}: {title}. {status}.",
					values
				);
	}
	if (state === "open") {
		return tr("{category} for {value}: {title}. {status}.", values);
	}
	return tr(
		"{state, select, answering {{category}, answering} other {{category}, revealed}}: {title}. {status}.",
		values
	);
}
