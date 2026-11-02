import { isExpandable, type NotebookRow } from "./notebook-model.ts";

export type NotebookTreeMove =
	| { type: "collapse"; id: string }
	| { type: "expand"; id: string }
	| { type: "focus"; id: string }
	| { type: "open"; threadId: string }
	| { type: "toggle"; id: string };

/** What a key does at the focused row, per the WAI-ARIA tree pattern. */
export function notebookTreeMove(
	rows: readonly NotebookRow[],
	currentId: string,
	key: string
): NotebookTreeMove | null {
	const index = rows.findIndex((row) => row.id === currentId);
	const row = rows[index];
	if (!row) {
		const first = rows[0];
		return first ? { id: first.id, type: "focus" } : null;
	}
	const focus = (target: NotebookRow | undefined): NotebookTreeMove | null =>
		target ? { id: target.id, type: "focus" } : null;
	switch (key) {
		case "ArrowDown":
			return focus(rows[index + 1]);
		case "ArrowUp":
			return focus(rows[index - 1]);
		case "Home":
			return focus(rows[0]);
		case "End":
			return focus(rows.at(-1));
		case "ArrowRight": {
			if (!isExpandable(row.node)) {
				return null;
			}
			if (!row.expanded) {
				return { id: row.id, type: "expand" };
			}
			const child = rows[index + 1];
			return child?.parentId === row.id ? focus(child) : null;
		}
		case "ArrowLeft": {
			if (row.expanded) {
				return { id: row.id, type: "collapse" };
			}
			return focus(rows.find((candidate) => candidate.id === row.parentId));
		}
		case "Enter":
		case " ":
			return row.node.kind === "page"
				? { threadId: row.node.threadId, type: "open" }
				: { id: row.id, type: "toggle" };
		default:
			return null;
	}
}
