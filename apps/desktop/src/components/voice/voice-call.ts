/** Format the small elapsed-time readout used by the desktop voice call. */
export function formatVoiceCallDuration(totalSeconds: number): string {
	const seconds = Number.isFinite(totalSeconds)
		? Math.max(0, Math.floor(totalSeconds))
		: 0;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

/** Turn an agent display name into a compact call-avatar label. */
export function getVoiceCallInitials(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) {
		return "R";
	}
	if (words.length === 1) {
		return words[0]?.slice(0, 2).toUpperCase() ?? "R";
	}
	const first = words[0]?.[0] ?? "R";
	const last = words.at(-1)?.[0] ?? "Y";
	return `${first}${last}`.toUpperCase();
}

/** The summary row Core saves when a call ends (`Call ended · 01:24`). */
const CALL_SUMMARY_RE = /^Call ended · \d{2,}:\d{2}$/;

interface StoredCallRow {
	content: string;
	id: string;
	role: string;
}

function isCallSummaryRow(row: StoredCallRow): boolean {
	return row.role === "user" && CALL_SUMMARY_RE.test(row.content.trim());
}

/**
 * The stored rows that belong to the call ending at `summaryId`: the run of
 * rows just before that summary, back to the first row already on screen or an
 * earlier call's summary. Empty when the summary is not in `stored`.
 */
export function finishedCallRows<T extends StoredCallRow>(
	stored: readonly T[],
	onScreenIds: ReadonlySet<string>,
	summaryId: string
): T[] {
	const summaryIndex = stored.findIndex((row) => row.id === summaryId);
	const rows: T[] = [];
	for (let index = summaryIndex - 1; index >= 0; index -= 1) {
		const row = stored[index];
		if (!row || onScreenIds.has(row.id) || isCallSummaryRow(row)) {
			break;
		}
		rows.push(row);
	}
	return rows.reverse();
}

/**
 * Fold a finished call's stored turns into a transcript whose other turns Core
 * does not keep (the Ask Ryu builder chats with `persist: false`). The call's
 * rows land just before its summary, in stored order; every row already on
 * screen stays where it is. Returns `current` unchanged when there is nothing
 * to add.
 */
export function foldFinishedCall<
	T extends { id: string },
	R extends StoredCallRow,
>(
	current: T[],
	stored: readonly R[],
	summaryId: string,
	toMessage: (row: R) => T
): T[] {
	const rows = finishedCallRows(
		stored,
		new Set(current.map((message) => message.id)),
		summaryId
	);
	if (rows.length === 0) {
		return current;
	}
	const added = rows.map(toMessage);
	const summaryIndex = current.findIndex((message) => message.id === summaryId);
	if (summaryIndex === -1) {
		return [...current, ...added];
	}
	return [
		...current.slice(0, summaryIndex),
		...added,
		...current.slice(summaryIndex),
	];
}
