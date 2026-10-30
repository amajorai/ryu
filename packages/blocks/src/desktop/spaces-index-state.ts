import {
	CanvasIcon,
	DatabaseIcon,
	File01Icon,
} from "@hugeicons/core-free-icons";
import type { SpaceDocumentRow } from "./spaces-types.ts";

/**
 * What happened to a file's **contents**. Structurally identical to the desktop
 * client's `SpaceFileIndexState` (`apps/desktop/src/lib/api/spaces.ts`), restated
 * rather than imported because `@ryu/blocks` must not depend on `apps/desktop`.
 * Both are the wire spellings from `IndexState::as_str` plus the synthetic
 * `unattempted` that `unknown_json` returns for a document with no status row.
 */
export type SpaceFileIndexState =
	| "failed"
	| "indexed"
	| "pending"
	| "skipped"
	| "unattempted";

/**
 * The badge on a file row whose bytes were never turned into text.
 *
 * Two words, because it replaces the chunk count rather than joining it — see
 * {@link FILE_INDEX_NOTES} for why showing both would be worse than showing
 * neither. It names what IS indexed ("name only") instead of what is not, so the row
 * is readable without the note; the note carries the consequence.
 *
 * Deliberately the SAME badge for `skipped`, `failed` and `unattempted`: from where
 * the user is standing those three have one meaning ("a search will not find the
 * text in here"), and three different badge words at the end of a row would read as
 * three different severities. The three *actions* differ, and that is what the notes
 * are for.
 */
export const FILE_CONTENTS_NOT_INDEXED_BADGE = "Name only";

/** The badge while a reader is still working on the file. */
export const FILE_CONTENTS_PENDING_BADGE = "Reading…";

/**
 * One sentence per index state, saying what it means for searching and what the
 * reader can DO. Rendered under the document list, once per state present.
 *
 * ## The overclaim this replaces
 *
 * Every document row used to carry a `<n> chunks` badge, files included. A file
 * whose text was never extracted gets exactly one chunk — `title` + mime, the
 * descriptor `SpaceStore::create_file` embeds — so a 300-page PDF sat in this list
 * reading "1 chunk", beside pages whose badge counts real extracted text, under a
 * heading with a search box. Nothing anywhere said the PDF's prose had never been
 * read. A user searching for a phrase they knew was in that PDF got no result and no
 * reason.
 *
 * That is why the badge REPLACES the count instead of sitting next to it. "1 chunk ·
 * Name only" invites the reading that one chunk of the file's *text* is indexed,
 * which is the same wrong belief in a smaller font.
 *
 * ## Why there are four sentences and not one
 *
 * Because there are four different things to do, and the reason a file is not
 * searchable is not observable from the file. Core distinguishes them on purpose:
 * `skipped` is *"nothing on this node can read this format — not an error, a missing
 * install"*; `failed` is *"something attempted the parse and could not finish it"*;
 * `unattempted` is *"nobody looked, as opposed to nobody could read it"*, which is
 * every file stored before extraction shipped. Collapsing those into "not
 * searchable" would leave a user with a fixable problem no way to learn it is
 * fixable — which is the same shape of defect as the badge itself.
 *
 * `skipped` is the only one that names an install, and it may do so **because it is
 * now true**: `create_file_indexed` really does route every upload through the
 * `document.parse` facade, so binding a provider changes the outcome of the next
 * upload. Naming a specific app is avoided anyway — which providers exist is the
 * Store's business and this sentence should not go stale when a fifth one ships.
 *
 * `indexed` has no entry: a searchable file is the unremarkable case and gets the
 * ordinary chunk badge, like a page. Its {@link SpaceDocumentRow.indexWarnings} are
 * still surfaced — a parse that half-worked and says nothing is the silent-drop bug
 * wearing a hat.
 */
export const FILE_INDEX_NOTES = {
	unattempted:
		"Files marked “Name only” are stored and open normally, but a search of this space only matches their name and file type — not the text inside them. Nothing has tried to read these yet: upload one again to have it read now, or add it through the “Drop files here” zone above.",
	skipped:
		"Files marked “Name only” are stored and open normally, but nothing installed on this node can read their format, so a search only matches their name and file type. Install a document reader from the Store, then upload the file again to make its text searchable.",
	failed:
		"Files marked “Name only” are stored and open normally, but reading their text did not finish, so a search only matches their name and file type. Upload the file again to retry — the reason is shown on each file.",
	pending:
		"Files marked “Reading…” are being read now. Their text becomes searchable when that finishes; reopen this space to check.",
} as const satisfies Readonly<
	Record<Exclude<SpaceFileIndexState, "indexed">, string>
>;

/**
 * The badge at the end of a document row.
 *
 * `null` is not a state — it is what an untold surface renders, i.e. the chunk
 * count. Every branch that hides the count must be one the caller explicitly asked
 * for, never a fallback.
 *
 * `pending` is deliberately NOT badged "Name only": the text is on its way, and
 * calling a file unsearchable while a reader is mid-parse would be wrong within
 * seconds. The other three share one badge (see
 * {@link FILE_CONTENTS_NOT_INDEXED_BADGE}) and differ only in their note.
 */
export function indexBadgeLabel(
	state: SpaceFileIndexState | undefined
): string | null {
	if (state === undefined || state === "indexed") {
		return null;
	}
	return state === "pending"
		? FILE_CONTENTS_PENDING_BADGE
		: FILE_CONTENTS_NOT_INDEXED_BADGE;
}

/**
 * The notes to render under the list: one per distinct state actually present, in a
 * fixed order so the list does not reshuffle as files finish parsing.
 *
 * Per-list rather than per-row because the sentence is identical for every file in
 * the same state, and repeating it down an Uploads space full of PDFs would bury the
 * filenames the user came here to read.
 */
export function indexNotesFor(documents: SpaceDocumentRow[]): string[] {
	const order: Exclude<SpaceFileIndexState, "indexed">[] = [
		"pending",
		"skipped",
		"failed",
		"unattempted",
	];
	return order
		.filter((state) => documents.some((doc) => doc.indexState === state))
		.map((state) => FILE_INDEX_NOTES[state]);
}

/** The list icon for a document row, by kind. */
export function docIcon(kind: SpaceDocumentRow["kind"]) {
	if (kind === "database") {
		return DatabaseIcon;
	}
	if (kind === "whiteboard") {
		return CanvasIcon;
	}
	return File01Icon;
}

/**
 * The second line on a document row, or `null` for the common case of none.
 *
 * Exactly two things go here, and both are per-document — which is precisely why
 * they cannot live in the per-list notes:
 *
 * - a **`failed`** file's reason. A retry the user cannot diagnose is a retry they
 *   will make twice. Core guarantees `message` is never the document's contents.
 * - an **`indexed`** file's non-fatal warnings (a lossy decode, a missing OCR tool,
 *   a truncated result). This row's badge says the file IS searchable, and it is —
 *   just not completely. A degraded parse the user cannot see is the silent-drop bug
 *   wearing a hat, which is the same defect as the badge this whole change adds.
 */
export function rowDetail(doc: SpaceDocumentRow): string | null {
	if (doc.indexState === "failed") {
		return doc.indexMessage ?? null;
	}
	const warnings = doc.indexWarnings ?? [];
	if (doc.indexState === "indexed" && warnings.length > 0) {
		return warnings.join(" · ");
	}
	return null;
}
