import {
	deriveEditedFiles,
	type EditedFile,
} from "@ryu/blocks/desktop/agent-elements/turn-end-cards.ts";
import type {
	MissionStreamMessage,
	MissionStreamPart,
} from "@/src/lib/mission-control/turn-groups.ts";
import { deriveTodoProgress } from "@/src/lib/todo-progress.ts";

export type TurnChangedFile = EditedFile;

export interface TurnTodoProgress {
	current: number;
	items: { label: string; status: "completed" | "in_progress" | "pending" }[];
	total: number;
}

export interface TurnComposerProgress {
	deletions: number;
	files: TurnChangedFile[];
	insertions: number;
	todos?: TurnTodoProgress;
}

function partsWithInspectableInFlightEdits(
	parts: MissionStreamPart[]
): unknown[] {
	return parts.map((part) => {
		if (!(part && "state" in part)) {
			return part;
		}
		const state = part.state;
		if (
			state !== "input-available" &&
			state !== "input-streaming" &&
			state !== "streaming"
		) {
			return part;
		}
		const { state: _state, ...withoutState } = part;
		return withoutState;
	});
}

function readTodos(parts: MissionStreamPart[]): TurnTodoProgress | undefined {
	const snapshot = deriveTodoProgress([{ parts }]);
	if (!snapshot) {
		return undefined;
	}
	return {
		current: snapshot.current,
		items: snapshot.items,
		total: snapshot.total,
	};
}

/** Derive the live todo list and file edits made after the latest user message. */
export function deriveTurnComposerProgress(
	messages: MissionStreamMessage[]
): TurnComposerProgress | undefined {
	let turnStart = -1;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index]?.role === "user") {
			turnStart = index;
			break;
		}
	}
	if (turnStart < 0) {
		return undefined;
	}
	const parts = messages
		.slice(turnStart + 1)
		.filter((message) => message.role === "assistant")
		.flatMap((message) => message.parts ?? []);
	const changedFiles = deriveEditedFiles(
		partsWithInspectableInFlightEdits(parts)
	);
	const todos = readTodos(parts);
	if (changedFiles.length === 0 && !todos) {
		return undefined;
	}
	return {
		files: changedFiles,
		todos,
		insertions: changedFiles.reduce((sum, file) => sum + file.insertions, 0),
		deletions: changedFiles.reduce((sum, file) => sum + file.deletions, 0),
	};
}
