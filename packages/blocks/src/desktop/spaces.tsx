"use client";

// Presentational layer of the desktop Spaces (RAG) page. The live app
// (`apps/desktop/src/pages/SpacesPage.tsx`) is a thin container that loads spaces
// via `useSpacesContext()` and owns the ingest/search form state; the storyboard
// renders the same component with mock data and no-op handlers. One source of
// truth, so editing this block changes the real desktop too.

import {
	Add01Icon,
	ArrowDown01Icon,
	CanvasIcon,
	DatabaseIcon,
	Download01Icon,
	File01Icon,
	FolderOpenIcon,
	Home01Icon,
	LibraryIcon,
	PinIcon,
	Search01Icon,
	Upload01Icon,
	UserMultiple02Icon,
	ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@ryu/ui/components/radio-group";
import { Skeleton } from "@ryu/ui/components/skeleton";
import { Spinner } from "@ryu/ui/components/spinner";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ryu/ui/components/table";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@ryu/ui/components/tabs";
import { useFriendlyMode } from "@ryu/ui/hooks/use-friendly-mode.ts";
import type { ChangeEvent, ReactNode, SyntheticEvent } from "react";
import { useMemo, useRef, useState } from "react";
import { z } from "zod";

const spaceVisibilitySchema = z.enum(["org", "private"]);
const spaceRetrievalModeSchema = z.enum(["graph", "vector"]);

/**
 * Which retrieval algorithm a Space uses. Structurally identical to the desktop
 * client's `RetrievalMode` (`apps/desktop/src/lib/api/spaces.ts`) — restated here
 * rather than imported because `@ryu/blocks` must not depend on `apps/desktop`.
 * Both are the wire spellings from `RetrievalMode::as_str` in Core.
 */
export type SpaceRetrievalMode = "graph" | "vector";

/** The user-facing sharing choices for a Space and its inherited pages. */
export type SpaceVisibility = "org" | "private";

const SPACE_VISIBILITY_OPTIONS: readonly {
	blurb: string;
	icon: typeof ViewOffSlashIcon;
	label: string;
	value: SpaceVisibility;
}[] = [
	{
		value: "private",
		label: "Private",
		blurb: "Only you can see this space and its pages.",
		icon: ViewOffSlashIcon,
	},
	{
		value: "org",
		label: "Team",
		blurb: "Everyone on this shared node can see this space and its pages.",
		icon: UserMultiple02Icon,
	},
];

/** Shared visibility choice used by the create dialog and future Space settings. */
export function SpaceVisibilityChoice({
	disabled,
	idPrefix,
	onVisibilityChange,
	visibility,
}: {
	disabled?: boolean;
	idPrefix: string;
	onVisibilityChange: (visibility: SpaceVisibility) => void;
	visibility: SpaceVisibility;
}) {
	return (
		<RadioGroup
			aria-label="Space visibility"
			disabled={disabled}
			onValueChange={(next) => {
				const parsed = spaceVisibilitySchema.safeParse(next);
				if (parsed.success) {
					onVisibilityChange(parsed.data);
				}
			}}
			value={visibility}
		>
			{SPACE_VISIBILITY_OPTIONS.map((option) => {
				const id = `${idPrefix}-${option.value}`;
				return (
					<div className="flex items-start gap-2.5" key={option.value}>
						<RadioGroupItem className="mt-0.5" id={id} value={option.value} />
						<HugeiconsIcon
							className="mt-0.5 size-4 shrink-0 text-muted-foreground"
							icon={option.icon}
						/>
						<div className="flex flex-col gap-0.5">
							<Label htmlFor={id} variant="choice">
								{option.label}
							</Label>
							<p className="text-muted-foreground text-xs">{option.blurb}</p>
						</div>
					</div>
				);
			})}
		</RadioGroup>
	);
}

/**
 * The ONE definition of how the two retrieval modes are named and explained.
 *
 * Exported because the choice appears twice — at Space creation
 * (`apps/desktop/src/components/spaces/CreateSpaceDialog.tsx`) and on an existing
 * Space (below) — and two hand-written copies of a tradeoff explanation drift into
 * two different promises about what the product does.
 *
 * The blurbs are deliberately about consequences a non-expert can act on (speed,
 * indexing cost, what kind of question each mode can answer), not about KNN or BFS.
 */
export const RETRIEVAL_MODE_OPTIONS: readonly {
	blurb: string;
	friendlyBlurb: string;
	friendlyLabel: string;
	label: string;
	value: SpaceRetrievalMode;
}[] = [
	{
		value: "vector",
		label: "Vector",
		friendlyLabel: "Quick search",
		blurb:
			"Fast similarity search. Finds the passages that most resemble your question.",
		friendlyBlurb:
			"Fast. Finds the passages that read most like your question.",
	},
	{
		value: "graph",
		label: "Graph",
		friendlyLabel: "Connected search",
		blurb:
			"Also extracts the entities in each document and how they relate, so it can answer questions that connect facts across documents. Indexing takes longer. An uploaded file is mapped by its name and file type unless its text has been extracted.",
		friendlyBlurb:
			"Also notes the people, places and things in each document and how they connect, so it can answer questions that join facts from across documents. Preparing it takes longer. An uploaded file is filed under its name and file type unless its text has been pulled out.",
	},
];

/**
 * The friendly-mode half of the copy above, and the rule it is written to.
 *
 * "Vector" and "Graph" are the names of the algorithms, not of the outcomes. A
 * user deciding how their own documents should be searched is not choosing a
 * retrieval architecture; they are choosing between "fast" and "joins facts up".
 * So friendly mode renames the OPTIONS — Quick search / Connected search — while
 * the wire values (`vector` / `graph`) and the technical labels are untouched, and
 * turning the toggle off puts the algorithm names straight back.
 *
 * The friendly blurbs are NOT shorter summaries. Friendly mode ships default-ON
 * (`DEFAULT_FRIENDLY_MODE`), which means this is the copy nearly every user reads,
 * so every consequence the technical blurb carries has to survive the rewrite:
 * Graph's cross-document reach, that preparing it takes longer, and that an
 * uploaded file whose text was never extracted is indexed by name and type alone.
 * Dropping one of those to sound friendlier would trade a hard word for a wrong
 * expectation, which is the opposite of the point. `spaces.test.ts` asserts each
 * of those three claims against the friendly blurb as well as the technical one.
 *
 * {@link RETRIEVAL_MODE_SCOPE} deliberately has NO friendly variant: it is already
 * plain language, it is the sentence this file has twice shipped wrong, and it is
 * pinned by name in three test suites. One sentence that both modes render is one
 * sentence that cannot drift into two different promises.
 */
export function retrievalModeLabel(
	mode: SpaceRetrievalMode,
	friendly: boolean
): string {
	const option = RETRIEVAL_MODE_OPTIONS.find((o) => o.value === mode);
	if (!option) {
		return String(mode);
	}
	return friendly ? option.friendlyLabel : option.label;
}

/**
 * WHERE the retrieval mode applies — the half of the story this UI has now got
 * wrong in both directions, and the half a user needs before picking Graph.
 *
 * `retrieval_mode` is read in exactly one place in Core: `SpaceStore::search_ext`
 * calls `space_mode()` and branches to `vector_search` or `graph_search`
 * (`crates/core/spaces/src/lib.rs`). What changed is how many paths reach that
 * function — two now do:
 *
 *  - `POST /api/spaces/:id/search` (`apps/core/src/server/mod.rs`), which a Spaces
 *    search box hits and which the `ryu_search_space` MCP tool calls when an agent
 *    is told to search a named space;
 *  - the automatic recall on a chat turn. `RetrievalStore::retrieve`
 *    (`crates/core/rag/src/store/retrieve.rs`) delegates the Spaces half of a recall back to
 *    `search_ext` via its `SpaceRecall` hook (implemented in
 *    `apps/core/src/rag_host.rs`), so an agent's allowlisted spaces are answered
 *    under their own mode.
 *
 * The history is worth keeping, because both failures were invisible from the UI:
 * the FIRST version of this copy claimed the setting decided "how this space finds
 * answers when an agent searches it" while chat recall never read the column
 * (overclaim); the correction then said chat "does not use this setting", which
 * became false the moment the delegate landed (underclaim). A control whose copy
 * understates it is not harmless — a user who wants graph recall in chat is told
 * to stop looking.
 *
 * So the sentence names WHERE it applies and does not enumerate what is excluded:
 * every path that searches a space now goes through the one branch point, and a
 * carve-out is exactly the kind of clause that rots when a new caller appears.
 *
 * Lives next to {@link RETRIEVAL_MODE_OPTIONS} and is rendered by
 * {@link RetrievalModeChoice} so both surfaces that offer the choice (the create
 * dialog and the Space detail card) state the same scope. Putting it in the
 * picker rather than in each caller is what stops one surface from drifting back
 * into a wider promise than the code keeps.
 */
export const RETRIEVAL_MODE_SCOPE =
	"Applies whenever this space is searched — from a Spaces search box, when an agent is told to search it, and during the automatic recall an agent does in a chat.";

/**
 * The Vector-vs-Graph picker, shared by the create dialog and the Space detail so
 * both surfaces offer the same two options with the same explanation.
 *
 * `idPrefix` scopes the generated ids: the label→radio association is by `htmlFor`
 * (a `<button role="radio">` is a labelable element), so two pickers mounted at
 * once with the same ids would make one label drive the other's radio.
 *
 * The picker also renders {@link RETRIEVAL_MODE_SCOPE}. That is deliberate: the
 * two blurbs say what each mode *does*, and the scope line says *where the choice
 * is honoured*. Shipping the first without the second is how this control first
 * ended up promising that Graph changed what an agent finds on a chat turn while
 * nothing on that path read the setting — and, later, how the corrected line kept
 * denying it after Core made it true. Carrying the line inside the picker means a
 * new surface that adopts the picker cannot forget it, and it is
 * `aria-describedby`-linked so the qualification is announced with the group
 * rather than read as unrelated trailing text.
 */
export function RetrievalModeChoice({
	disabled,
	idPrefix,
	mode,
	onModeChange,
}: {
	disabled?: boolean;
	idPrefix: string;
	mode: SpaceRetrievalMode;
	onModeChange: (mode: SpaceRetrievalMode) => void;
}) {
	const scopeId = `${idPrefix}-scope`;
	// The app-wide "Friendly names" toggle (Settings → Appearance). Read here, in
	// the picker, rather than passed down by each caller: both surfaces that offer
	// this choice get the same vocabulary automatically, exactly as they already
	// get RETRIEVAL_MODE_SCOPE, and a third surface adopting the picker cannot
	// forget to thread the preference through.
	const [friendly] = useFriendlyMode();
	return (
		<div className="flex flex-col gap-2">
			<RadioGroup
				aria-describedby={scopeId}
				disabled={disabled}
				onValueChange={(next) => {
					const parsed = spaceRetrievalModeSchema.safeParse(next);
					if (parsed.success) {
						onModeChange(parsed.data);
					}
				}}
				value={mode}
			>
				{RETRIEVAL_MODE_OPTIONS.map((option) => {
					const id = `${idPrefix}-${option.value}`;
					return (
						<div className="flex items-start gap-2.5" key={option.value}>
							<RadioGroupItem className="mt-0.5" id={id} value={option.value} />
							<div className="flex flex-col gap-0.5">
								<Label htmlFor={id} variant="choice">
									{friendly ? option.friendlyLabel : option.label}
								</Label>
								<p className="text-muted-foreground text-xs">
									{friendly ? option.friendlyBlurb : option.blurb}
								</p>
							</div>
						</div>
					);
				})}
			</RadioGroup>
			<p className="text-muted-foreground text-xs" id={scopeId}>
				{RETRIEVAL_MODE_SCOPE}
			</p>
		</div>
	);
}

/**
 * What changing the mode on an EXISTING Space actually does, stated where the
 * change is made.
 *
 * This is not decoration. Core's switch rebuilds the Space's entity graph from the
 * chunks already stored (→ graph) or drops it (→ vector) in the same transaction
 * as the column write. A control that silently implied either "this re-indexes
 * everything" or "this is just a label" would be wrong in opposite directions, so
 * the line names both directions and what is left alone.
 *
 * The last clause is the one that pairs with {@link FILE_CONTENTS_NOT_INDEXED_NOTE},
 * and it is here to head off a specific wrong action. A user who has just been told
 * a file's contents are not searchable will look for the nearest re-index button,
 * and this is it. It cannot help: `set_retrieval_mode` rebuilds from
 * `SELECT id, content FROM chunks` — the text Core already has — and never re-opens
 * a stored blob, so flipping the mode twice re-derives a file's name and type and
 * finds no more of its text than before. That is true both before and after Core
 * learns to extract file text, so the sentence does not need a third revision.
 */
const RETRIEVAL_MODE_SWITCH_DISCLOSURE =
	"Changing this rebuilds the entity graph from the documents already in this space; switching back to Vector discards that graph. Documents are never re-embedded, so you can switch back. Switching modes never re-reads an uploaded file's contents.";

/**
 * The same disclosure in friendly mode — every clause kept, no term of art.
 *
 * "Entity graph", "re-embedded" and the bare mode name "Vector" are the three
 * words in the sentence above that a non-developer cannot act on, and all three
 * are load-bearing: they are what tells the user this control is reversible, is
 * not free, and is NOT the re-index button they are probably looking for after
 * reading {@link FILE_CONTENTS_NOT_INDEXED_NOTE}. So each is replaced by what it
 * means rather than dropped — "map of how they connect", "read from scratch
 * again", and the friendly mode name from {@link RETRIEVAL_MODE_OPTIONS}.
 *
 * The final clause is the one worth protecting through any future rewrite: a user
 * who has just been told a file's text is not searchable will try this control
 * next, and it cannot help them.
 */
const RETRIEVAL_MODE_SWITCH_DISCLOSURE_FRIENDLY =
	"Changing this re-reads the documents already in this space to build a map of how they connect; switching back to Quick search throws that map away. Your documents are never read from scratch again, so you can switch back. Switching never re-opens an uploaded file's contents.";

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

/** A space row as the view needs it. */
export interface SpaceRow {
	description?: string | null;
	documentCount: number;
	id: string;
	name: string;
	/** Optional: surfaces that do not know a Space's mode (the storyboard's mock
	 *  data) omit it, and the detail's Retrieval card then does not render at all
	 *  rather than assert a default it has not been told. */
	retrievalMode?: SpaceRetrievalMode;
}

export interface SpaceDocumentRow {
	byteSize?: number | null;
	chunkCount: number;
	id: string;
	/**
	 * Why this file's text is not searchable, when the state is `failed`. Rendered as
	 * a second line on the row, because a retry the user cannot diagnose is a retry
	 * they will make twice. Core guarantees this is never the document's contents.
	 */
	indexMessage?: string | null;
	/**
	 * What happened to this document's **contents**.
	 *
	 * `undefined` is the important value and the default: it means *this surface has
	 * not been told*, and it renders exactly as the list always did — the chunk
	 * count, no searchability claim either way. That is the standing answer for a
	 * page, database, whiteboard or app document, which is chunked from its own
	 * source on every save: `GET /api/spaces/:id/documents` attaches the extraction
	 * record to `kind = 'file'` rows and deliberately omits it everywhere else, so
	 * those rows arrive here undefined and stay silent. The storyboard's mock rows
	 * omit it for the same reason — nothing has told them either.
	 *
	 * A real FILE row is told: the state arrives on the list response itself (see
	 * `DocumentWire` in `apps/desktop/src/lib/api/spaces.ts`), so the badges render
	 * from the same request that renders the filenames rather than from a per-row
	 * follow-up.
	 *
	 * Silence is the right default rather than a stub, because the alternative is a
	 * guess. There is no client-side derivation of this: "it is a file, therefore its
	 * contents are not searchable" was true only until Core started extracting, and
	 * is now wrong for every `.txt`/`.md`/`.csv` — those go through Core's in-process
	 * floor and are `indexed` before the upload response is written.
	 *
	 * A state rather than a boolean because the three not-searchable states carry
	 * three different user actions; see {@link FILE_INDEX_NOTES}.
	 */
	indexState?: SpaceFileIndexState;
	/**
	 * Non-fatal notes from a parse that DID work — a lossy decode, a missing OCR
	 * tool, a truncated result. Rendered on `indexed` rows, which is the only place
	 * they can appear: a degraded parse whose result is searchable but incomplete is
	 * otherwise indistinguishable from a clean one.
	 */
	indexWarnings?: string[];
	/** `"page"` (markdown), `"database"` (data grid), or `"whiteboard"`
	 * (Excalidraw scene). Defaults to a page. */
	kind?: "page" | "database" | "whiteboard";
	mime?: string | null;
	preview?: string;
	previewLoading?: boolean;
	rawKind?: string;
	title: string;
	updatedAt?: number;
}

export interface SpaceMatchRow {
	chunkId: string;
	content: string;
}

export interface SpacesDetailProps {
	backupPanel?: ReactNode;
	/** Node-scoped Marketplace cover controls owned by the desktop host. */
	bannerSlot?: ReactNode;
	documents: SpaceDocumentRow[];
	documentsError?: string | null;
	/** Desktop-owned import workflow. Shared renderers omit it and keep one Content view. */
	importPanel?: ReactNode;
	/** Omit (together with `space.retrievalMode`) to hide the Retrieval card. */
	onCancelRetrievalMode?: () => void;
	/** Portable Markdown package controls owned by the desktop container. */
	onExportPackage?: () => void;
	onImportPackage?: (file: File) => void;
	onNewDatabase?: () => void;
	onNewPage?: () => void;
	onNewWhiteboard?: () => void;
	onOpenDoc?: (docId: string, title: string) => void;
	onRetrievalModeChange?: (mode: SpaceRetrievalMode) => void;
	onSearchQueryChange?: (value: string) => void;
	onSearchSubmit?: () => void;
	portableBusy?: boolean;
	portableError?: string | null;
	portableNotice?: string | null;
	/** True while Core's background rebuild is running. The picker stays disabled
	 *  while polling so a second click cannot queue another full rebuild. */
	retrievalModeBusy?: boolean;
	retrievalModeError?: string | null;
	/** What the last switch actually did (entity/connection counts), so the result
	 *  is reported rather than assumed. */
	retrievalModeNotice?: string | null;
	retrievalModeProgress?: {
		processedChunks: number;
		totalChunks: number;
	} | null;
	searchBusy?: boolean;
	searchError?: string | null;
	// Search
	searchQuery: string;
	searchResults?: SpaceMatchRow[] | null;
	space: SpaceRow;
	/** Desktop-owned file upload flow. The host wires this to the node's extraction path. */
	uploadPanel?: ReactNode;
}

export interface SpacesViewProps {
	/** Detail props for the selected space (driven by the container). */
	detail?: SpacesDetailProps | null;
	error?: string | null;
	loading?: boolean;
	onCreateSpace?: () => void;
	onRetry?: () => void;
	onSelectSpace?: (id: string) => void;
	selectedId?: string | null;
	spaces: SpaceRow[];
}

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
function indexBadgeLabel(
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
function indexNotesFor(documents: SpaceDocumentRow[]): string[] {
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
function docIcon(kind: SpaceDocumentRow["kind"]) {
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
function rowDetail(doc: SpaceDocumentRow): string | null {
	if (doc.indexState === "failed") {
		return doc.indexMessage ?? null;
	}
	const warnings = doc.indexWarnings ?? [];
	if (doc.indexState === "indexed" && warnings.length > 0) {
		return warnings.join(" · ");
	}
	return null;
}

/** A page preview is only meaningful for the first-party Markdown page kind. */
function isMarkdownPage(doc: SpaceDocumentRow): boolean {
	return doc.kind === "page" && (!doc.rawKind || doc.rawKind === "page");
}

function formatDocumentDate(timestamp: number | undefined): string {
	if (!timestamp) {
		return "—";
	}
	const date = new Date(timestamp);
	if (Number.isNaN(date.valueOf())) {
		return "—";
	}
	return new Intl.DateTimeFormat(undefined, {
		day: "numeric",
		month: "short",
		year: "numeric",
	}).format(date);
}

function formatDocumentSize(bytes: number | null | undefined): string {
	if (bytes === null || bytes === undefined || bytes <= 0) {
		return "—";
	}
	const units = ["B", "KB", "MB", "GB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const rounded =
		value >= 10 || Number.isInteger(value) ? Math.round(value) : value;
	return `${Number(rounded.toFixed(1))} ${units[unit]}`;
}

function documentTypeLabel(doc: SpaceDocumentRow): string {
	if (doc.rawKind === "file") {
		const subtype = doc.mime?.split("/").at(-1);
		return subtype ? subtype.toUpperCase() : "File";
	}
	if (doc.rawKind?.startsWith("app:")) {
		return "App document";
	}
	if (doc.kind === "database") {
		return "Database";
	}
	if (doc.kind === "whiteboard") {
		return "Whiteboard";
	}
	return "Markdown";
}

function previewLines(source: string | undefined): string[] {
	const lines = (source ?? "")
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter((line) => line.trim())
		.slice(0, 8);
	return lines.length > 0 ? lines : ["A blank page ready for your first note."];
}

function MarkdownThumbnail({ document }: { document: SpaceDocumentRow }) {
	return (
		<div
			aria-hidden="true"
			className="relative h-[76px] w-14 shrink-0 overflow-hidden rounded-glyph-compact border border-space-paper-border bg-space-paper p-1.5 text-left text-space-paper-foreground shadow-space-paper dark:border-space-paper-border-dark dark:bg-space-paper-dark dark:text-space-paper-foreground-dark"
		>
			<div className="absolute inset-y-0 left-0 w-0.5 bg-space-paper-accent" />
			{document.previewLoading && !document.preview ? (
				<div className="space-y-1.5 pt-1">
					<Skeleton className="h-1.5 w-4/5" tone="paper-heading" />
					<Skeleton className="h-1 w-full" tone="paper-line" />
					<Skeleton className="h-1 w-5/6" tone="paper-line" />
					<Skeleton className="h-1 w-2/3" tone="paper-line" />
				</div>
			) : (
				<div className="type-diagram space-y-1 pt-0.5 leading-tight">
					{previewLines(document.preview)
						.slice(0, 5)
						.map((line, index) => (
							<p
								className={
									index === 0 ? "type-miniature font-semibold" : "opacity-75"
								}
								key={`${line}-${index}`}
							>
								{line.replace(/^[#*-]+\s*/, "")}
							</p>
						))}
				</div>
			)}
			<div className="pointer-events-none absolute inset-x-0 bottom-0 h-5 bg-gradient-to-t from-space-paper to-transparent dark:from-space-paper-dark" />
		</div>
	);
}

type SpaceTemplateKind = "blank" | "welcome" | "table" | "simple" | "board";

function SpaceTemplateCard({
	featured,
	kind,
	label,
	onClick,
}: {
	featured?: boolean;
	kind: SpaceTemplateKind;
	label: string;
	onClick?: () => void;
}) {
	return (
		<button
			aria-label={`Create ${label}`}
			className={`group flex w-36 shrink-0 flex-col gap-2 rounded-lg p-1.5 text-left outline-none transition-colors hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-white/5 ${featured ? "ring-2 ring-foreground/70" : ""}`}
			onClick={onClick}
			type="button"
		>
			<div className="relative flex h-24 items-center justify-center overflow-hidden rounded-md border border-black/10 bg-white shadow-sm dark:border-white/10 dark:bg-space-template-surface-dark">
				{kind === "table" ? (
					<div className="grid w-20 grid-cols-3 gap-px border border-space-template-grid bg-space-template-grid opacity-80">
						{Array.from({ length: 12 }, (_, index) => (
							<span className="h-3 bg-white" key={index} />
						))}
					</div>
				) : kind === "board" ? (
					<div className="flex size-16 items-center justify-center rounded-md border border-space-template-grid border-dashed bg-space-template-board dark:bg-space-template-board-dark">
						<HugeiconsIcon
							className="size-6 text-space-template-accent"
							icon={CanvasIcon}
						/>
					</div>
				) : (
					<div className="flex h-[76px] w-14 flex-col gap-1 rounded-xs border border-space-paper-border bg-space-paper p-2 text-space-template-paper-foreground shadow-sm dark:border-space-paper-border-dark dark:bg-space-template-paper-dark dark:text-space-paper-foreground-dark">
						{kind === "blank" ? null : (
							<span className="h-1.5 w-4/5 rounded bg-space-template-heading opacity-70" />
						)}
						<span className="h-1 w-full rounded bg-space-template-line opacity-70" />
						<span className="h-1 w-5/6 rounded bg-space-template-line opacity-50" />
						{kind === "welcome" ? (
							<span className="mt-1 h-7 rounded-sm bg-space-template-accent/25" />
						) : null}
					</div>
				)}
			</div>
			<span className="truncate px-0.5 font-medium text-xs">{label}</span>
		</button>
	);
}

function RecentDocumentRow({
	document,
	onOpenDoc,
	spaceName,
}: {
	document: SpaceDocumentRow;
	onOpenDoc?: (docId: string, title: string) => void;
	spaceName: string;
}) {
	const title = document.title || "Untitled page";
	return (
		<button
			aria-label={`Open ${title}`}
			className="flex w-full items-center gap-3 border-border/70 border-b px-3 py-3 text-left outline-none transition-colors last:border-b-0 hover:bg-black/[0.035] focus-visible:bg-black/[0.035] dark:focus-visible:bg-white/[0.035] dark:hover:bg-white/[0.035]"
			onClick={() => onOpenDoc?.(document.id, title)}
			type="button"
		>
			<MarkdownThumbnail document={document} />
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="truncate font-medium text-sm" title={title}>
					{title}
				</span>
				<span className="mt-1 truncate text-muted-foreground text-xs">
					{spaceName} · {documentTypeLabel(document)}
				</span>
			</span>
			<span className="hidden shrink-0 text-muted-foreground text-xs sm:block">
				{formatDocumentDate(document.updatedAt)}
			</span>
			<HugeiconsIcon
				aria-hidden="true"
				className="size-3.5 shrink-0 text-muted-foreground/60"
				icon={PinIcon}
			/>
		</button>
	);
}

function FilesTableSection({
	documents,
	documentsError,
	onOpenDoc,
	onQueryChange,
	query,
}: {
	documents: SpaceDocumentRow[];
	documentsError?: string | null;
	onOpenDoc?: (docId: string, title: string) => void;
	onQueryChange: (value: string) => void;
	query: string;
}) {
	const [friendly] = useFriendlyMode();
	const filteredDocuments = useMemo(() => {
		const normalized = query.trim().toLowerCase();
		if (!normalized) {
			return documents;
		}
		return documents.filter((document) =>
			`${document.title} ${documentTypeLabel(document)}`
				.toLowerCase()
				.includes(normalized)
		);
	}, [documents, query]);

	return (
		<section
			aria-labelledby="space-files-title"
			className="flex flex-col gap-4"
			data-testid="spaces-files-table"
		>
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div>
					<h2
						className="font-heading text-2xl tracking-tight"
						id="space-files-title"
					>
						Files
					</h2>
				</div>
			</div>
			<div className="overflow-hidden rounded-3xl border border-border/70 bg-card/70 shadow-sm">
				<div className="flex flex-wrap items-center justify-between gap-3 border-border/60 border-b px-4 py-4 sm:px-6">
					<p className="text-muted-foreground text-xs">
						{filteredDocuments.length} of {documents.length} visible
					</p>
					<div className="relative w-full sm:w-64">
						<HugeiconsIcon
							aria-hidden="true"
							className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
							icon={Search01Icon}
						/>
						<Input
							aria-label="Search files"
							leadingAdornment="default"
							onChange={(event: ChangeEvent<HTMLInputElement>) =>
								onQueryChange(event.target.value)
							}
							placeholder="Search files"
							value={query}
						/>
					</div>
				</div>
				{documentsError ? (
					<p className="px-4 pt-4 text-sm text-status-destructive sm:px-6">
						{documentsError}
					</p>
				) : null}
				<div className="p-3 sm:hidden">
					{filteredDocuments.length > 0 ? (
						<ul className="flex flex-col gap-2">
							{filteredDocuments.map((document) => (
								<DocumentRow
									doc={document}
									key={document.id}
									onOpenDoc={onOpenDoc}
								/>
							))}
						</ul>
					) : (
						<p className="px-3 py-8 text-center text-muted-foreground text-sm">
							No files match “{query}”.
						</p>
					)}
				</div>
				<div className="hidden sm:block">
					<Table aria-label="Files in this Space" className="min-w-[760px]">
						<TableHeader>
							<TableRow appearance="header">
								<TableHead inset="wide" presentation="file-label">
									Name
								</TableHead>
								<TableHead presentation="file-label">Type</TableHead>
								<TableHead presentation="file-label">Size</TableHead>
								<TableHead presentation="file-label">Modified</TableHead>
								<TableHead inset="end" presentation="file-label">
									Search reach
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{filteredDocuments.length > 0 ? (
								filteredDocuments.map((document) => {
									const detail = rowDetail(document);
									const title = document.title || "Untitled";
									const badge = indexBadgeLabel(document.indexState);
									return (
										<TableRow className="group" key={document.id}>
											<TableCell className="min-w-[19rem]" inset="wide">
												<button
													aria-label={`Open ${title}`}
													className="flex min-w-0 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
													onClick={() => onOpenDoc?.(document.id, title)}
													type="button"
												>
													<span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary">
														<HugeiconsIcon
															className="size-4"
															icon={docIcon(document.kind)}
														/>
													</span>
													<span className="flex min-w-0 flex-col">
														<span
															className="truncate font-medium text-sm"
															title={title}
														>
															{title}
														</span>
														<span className="truncate text-muted-foreground text-xs">
															{detail ?? documentTypeLabel(document)}
														</span>
													</span>
												</button>
											</TableCell>
											<TableCell presentation="metadata">
												{documentTypeLabel(document)}
											</TableCell>
											<TableCell presentation="numeric-metadata">
												{formatDocumentSize(document.byteSize)}
											</TableCell>
											<TableCell presentation="metadata">
												{formatDocumentDate(document.updatedAt)}
											</TableCell>
											<TableCell inset="end">
												{badge ? (
													<Badge variant="outline">{badge}</Badge>
												) : (
													<span className="text-muted-foreground text-xs">
														{friendly
															? `${document.chunkCount} searchable ${document.chunkCount === 1 ? "piece" : "pieces"}`
															: `${document.chunkCount} ${document.chunkCount === 1 ? "chunk" : "chunks"}`}
													</span>
												)}
											</TableCell>
										</TableRow>
									);
								})
							) : (
								<TableRow>
									<TableCell colSpan={5} presentation="empty">
										{query ? `No files match “${query}”.` : "No documents yet."}
									</TableCell>
								</TableRow>
							)}
						</TableBody>
					</Table>
				</div>
			</div>
			{indexNotesFor(documents).map((note) => (
				<p className="text-muted-foreground text-xs" key={note}>
					{note}
				</p>
			))}
		</section>
	);
}

type SpaceHomeTab = "recent" | "pinned" | "shared";

function greetingLabel(): string {
	const hour = new Date().getHours();
	if (hour < 12) {
		return "Good morning";
	}
	if (hour < 18) {
		return "Good afternoon";
	}
	return "Good evening";
}

function SpaceHomeRail({
	onHome,
	onNewPage,
	onOpenFiles,
	spaceName,
}: {
	onHome: () => void;
	onNewPage?: () => void;
	onOpenFiles: () => void;
	spaceName: string;
}) {
	return (
		<aside
			aria-label="Space navigation"
			className="hidden w-[94px] shrink-0 flex-col border-border/80 border-r bg-space-rail py-3 text-space-rail-foreground sm:flex dark:bg-space-rail-dark dark:text-space-rail-foreground-dark"
			data-testid="spaces-home-rail"
		>
			<div className="flex flex-col gap-2 px-2">
				<button
					aria-current="page"
					className="flex min-h-16 flex-col items-center justify-center gap-1 rounded-md border-2 border-space-navigation-active bg-white text-space-navigation-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-space-navigation-surface-dark dark:text-space-navigation-foreground-dark"
					onClick={onHome}
					type="button"
				>
					<HugeiconsIcon className="size-5" icon={Home01Icon} />
					<span className="type-caption">Home</span>
				</button>
				<button
					className="flex min-h-16 flex-col items-center justify-center gap-1 rounded-md border border-transparent outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-white/5"
					onClick={onNewPage}
					type="button"
				>
					<HugeiconsIcon className="size-5" icon={Add01Icon} />
					<span className="type-caption">New</span>
				</button>
				<button
					className="flex min-h-16 flex-col items-center justify-center gap-1 rounded-md border border-transparent outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-white/5"
					onClick={onOpenFiles}
					type="button"
				>
					<HugeiconsIcon className="size-5" icon={FolderOpenIcon} />
					<span className="type-caption">Open</span>
				</button>
			</div>
			<div className="mt-auto flex flex-col gap-3 border-border/70 border-t px-2 pt-3">
				<div className="flex flex-col items-center gap-1 text-center">
					<div className="flex size-7 items-center justify-center rounded-md bg-space-rail-icon text-muted-foreground dark:bg-space-rail-icon-dark">
						<HugeiconsIcon className="size-4" icon={LibraryIcon} />
					</div>
					<span className="type-compact max-w-16 truncate">{spaceName}</span>
				</div>
			</div>
		</aside>
	);
}

function SpaceHomeShell({
	children,
	documents,
	documentsError,
	onNewDatabase,
	onNewPage,
	onNewWhiteboard,
	onOpenDoc,
	space,
	uploadPanel,
}: {
	children: ReactNode;
	documents: SpaceDocumentRow[];
	documentsError?: string | null;
	onNewDatabase?: () => void;
	onNewPage?: () => void;
	onNewWhiteboard?: () => void;
	onOpenDoc?: (docId: string, title: string) => void;
	space: SpaceRow;
	uploadPanel?: ReactNode;
}) {
	const [activeTab, setActiveTab] = useState<SpaceHomeTab>("recent");
	const [query, setQuery] = useState("");
	const homeScrollRef = useRef<HTMLDivElement>(null);
	const filesAnchorRef = useRef<HTMLDivElement>(null);
	const recentDocuments = useMemo(() => {
		const normalized = query.trim().toLowerCase();
		return [...documents]
			.filter(isMarkdownPage)
			.filter((document) => {
				if (!normalized) {
					return true;
				}
				return `${document.title} ${space.name}`
					.toLowerCase()
					.includes(normalized);
			})
			.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
			.slice(0, 5);
	}, [documents, query, space.name]);

	const scrollHome = () => {
		homeScrollRef.current?.scrollTo({ top: 0 });
	};
	const scrollToFiles = () => {
		filesAnchorRef.current?.scrollIntoView({ block: "start" });
	};

	return (
		<div
			className="flex min-h-full bg-space-home text-space-home-foreground dark:bg-space-home-dark dark:text-space-home-foreground-dark"
			data-testid="spaces-home"
		>
			<SpaceHomeRail
				onHome={scrollHome}
				onNewPage={onNewPage}
				onOpenFiles={scrollToFiles}
				spaceName={space.name}
			/>
			<div
				className="scroll-fade min-w-0 flex-1 overflow-auto"
				ref={homeScrollRef}
			>
				<div className="mx-auto max-w-[1120px] px-5 py-6 sm:px-8 sm:py-8">
					<header
						className="border-border/70 border-b pb-5"
						data-testid="spaces-hero"
					>
						<div className="flex flex-wrap items-start justify-between gap-4">
							<div>
								<p className="text-muted-foreground text-sm">{space.name}</p>
								<h1 className="mt-1 font-heading font-semibold text-2xl tracking-space-greeting sm:text-3xl">
									{greetingLabel()}
								</h1>
							</div>
						</div>
						{space.description ? (
							<p className="mt-3 max-w-2xl text-muted-foreground text-sm leading-relaxed">
								{space.description}
							</p>
						) : null}
					</header>

					<section aria-labelledby="new-documents-title" className="pt-6">
						<h2
							className="flex items-center gap-1 font-semibold text-sm"
							id="new-documents-title"
						>
							<HugeiconsIcon className="size-3.5" icon={ArrowDown01Icon} />
							New
						</h2>
						<div className="mt-3 flex gap-3 overflow-x-auto pb-2">
							<SpaceTemplateCard
								featured
								kind="blank"
								label="Blank document"
								onClick={onNewPage}
							/>
							<SpaceTemplateCard
								kind="welcome"
								label="Welcome to Space"
								onClick={onNewPage}
							/>
							<SpaceTemplateCard
								kind="table"
								label="First table"
								onClick={onNewDatabase}
							/>
							<SpaceTemplateCard
								kind="simple"
								label="Single spaced"
								onClick={onNewPage}
							/>
							<SpaceTemplateCard
								kind="board"
								label="Blank board"
								onClick={onNewWhiteboard}
							/>
							<div className="flex shrink-0 items-center px-2 text-primary text-xs">
								More templates <span className="ml-1 text-base">→</span>
							</div>
						</div>
					</section>

					<section
						aria-labelledby="recent-documents-title"
						className="pt-5"
						data-testid="spaces-recent-pages"
					>
						<div className="relative max-w-[430px]">
							<HugeiconsIcon
								aria-hidden="true"
								className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
								icon={Search01Icon}
							/>
							<Input
								aria-label="Search documents"
								className="h-10"
								leadingAdornment="default"
								onChange={(event: ChangeEvent<HTMLInputElement>) =>
									setQuery(event.target.value)
								}
								placeholder="Search"
								value={query}
								variant="document-search"
							/>
						</div>
						<div className="mt-6">
							<h2
								className="font-heading font-semibold text-xl"
								id="recent-documents-title"
							>
								Recent
							</h2>
						</div>
						<div
							aria-label="Document views"
							className="mt-3 flex items-center gap-5 border-border/70 border-b"
							role="tablist"
						>
							{(
								[
									["recent", "Recent"],
									["pinned", "Pinned"],
									["shared", "Shared with Me"],
								] as const
							).map(([value, label]) => (
								<button
									aria-selected={activeTab === value}
									className={`border-b-2 px-0.5 py-2 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${activeTab === value ? "border-space-navigation-active font-semibold text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
									onClick={() => setActiveTab(value)}
									role="tab"
									type="button"
								>
									{label}
								</button>
							))}
						</div>
						<div
							className="mt-2 overflow-hidden rounded-md border bg-card"
							data-testid="spaces-recent-list"
						>
							{activeTab === "recent" && recentDocuments.length > 0 ? (
								recentDocuments.map((document) => (
									<RecentDocumentRow
										document={document}
										key={document.id}
										onOpenDoc={onOpenDoc}
										spaceName={space.name}
									/>
								))
							) : (
								<div className="px-4 py-9 text-center text-muted-foreground text-sm">
									{activeTab === "pinned"
										? "No pinned pages yet."
										: activeTab === "shared"
											? "No pages have been shared with you yet."
											: query
												? `No recent pages match “${query}”.`
												: "No recent pages yet."}
								</div>
							)}
						</div>
					</section>

					{uploadPanel ? <div className="mt-6">{uploadPanel}</div> : null}

					<div className="mt-10 scroll-mt-4" ref={filesAnchorRef}>
						<FilesTableSection
							documents={documents}
							documentsError={documentsError}
							onOpenDoc={onOpenDoc}
							onQueryChange={setQuery}
							query={query}
						/>
					</div>

					<div className="mt-10 flex flex-col gap-6">{children}</div>
				</div>
			</div>
		</div>
	);
}

/**
 * One row of the document list.
 *
 * Extracted from the map body because a row now has a conditional second line and
 * two badge branches, and an inline JSX block that size inside the section makes the
 * section's own structure unreadable.
 *
 * The second line is a `failed` file's reason. It is inside the button rather than
 * beside it so the whole row stays one click target — the file still opens, which is
 * the fact the copy is at pains to establish.
 */
function DocumentRow({
	doc,
	onOpenDoc,
}: {
	doc: SpaceDocumentRow;
	onOpenDoc?: (docId: string, title: string) => void;
}) {
	const badge = indexBadgeLabel(doc.indexState);
	const detail = rowDetail(doc);
	const [friendly] = useFriendlyMode();
	return (
		<li>
			<button
				aria-label={`Open ${doc.title || "Untitled"}`}
				className="flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left hover:bg-accent/50"
				onClick={() => onOpenDoc?.(doc.id, doc.title)}
				type="button"
			>
				<HugeiconsIcon
					className="size-4 shrink-0 opacity-70"
					icon={docIcon(doc.kind)}
				/>
				<span className="flex min-w-0 flex-1 flex-col">
					<span className="truncate text-sm" title={doc.title}>
						{doc.title}
					</span>
					{detail ? (
						<span
							className="truncate text-muted-foreground text-xs"
							title={detail}
						>
							{detail}
						</span>
					) : null}
				</span>
				{badge === null ? (
					// "Chunk" is the retrieval pipeline's word for a unit of embedded
					// text, and it appears on EVERY document row — the single most-read
					// piece of jargon on this page. Friendly mode says "searchable
					// pieces", which is what the number actually tells the reader: how
					// much of this document a search can reach. The count itself is
					// unchanged, so the badge means exactly the same thing in both modes
					// and the "Name only" replacement below still governs the case where
					// the count would mislead.
					<Badge variant="secondary">
						{friendly
							? `${doc.chunkCount} searchable ${doc.chunkCount === 1 ? "piece" : "pieces"}`
							: `${doc.chunkCount} ${doc.chunkCount === 1 ? "chunk" : "chunks"}`}
					</Badge>
				) : (
					// Replaces the chunk badge rather than joining it — see
					// FILE_INDEX_NOTES. `outline` (not `destructive`) even for `failed`:
					// nothing is lost, the file is stored and opens; only its reach is
					// narrower than the row above it, and a red badge on a working file
					// reads as data loss.
					<Badge variant="outline">{badge}</Badge>
				)}
			</button>
		</li>
	);
}

function SpaceDetail(props: SpacesDetailProps) {
	const {
		documents,
		documentsError,
		onNewPage,
		onNewDatabase,
		onNewWhiteboard,
		onOpenDoc,
		onExportPackage,
		onImportPackage,
		onRetrievalModeChange,
		onCancelRetrievalMode,
		portableBusy,
		portableError,
		portableNotice,
		retrievalModeBusy,
		retrievalModeError,
		retrievalModeProgress,
		retrievalModeNotice,
		searchQuery,
		searchBusy,
		searchError,
		searchResults,
		onSearchQueryChange,
		onSearchSubmit,
		space,
		uploadPanel,
	} = props;

	// Both halves are required: without the mode there is nothing truthful to
	// show, and without the handler the picker would be a control that does
	// nothing. Either alone hides the card rather than rendering a half-wired one.
	const retrievalMode = space.retrievalMode;
	const canEditRetrieval =
		retrievalMode !== undefined && onRetrievalModeChange !== undefined;
	const portableInput = useRef<HTMLInputElement>(null);

	const handleSearch = (e: SyntheticEvent) => {
		e.preventDefault();
		onSearchSubmit?.();
	};

	// Same app-wide toggle the picker reads; the card's own copy around the picker
	// (its description, the switch disclosure, the rebuild spinner) has to move
	// with it, or friendly option names would sit under a heading about algorithms
	// and above a warning about entity graphs.
	const [friendly] = useFriendlyMode();

	return (
		<SpaceHomeShell
			documents={documents}
			documentsError={documentsError}
			onNewDatabase={onNewDatabase}
			onNewPage={onNewPage}
			onNewWhiteboard={onNewWhiteboard}
			onOpenDoc={onOpenDoc}
			space={space}
			uploadPanel={uploadPanel}
		>
			{props.bannerSlot}
			{props.backupPanel}
			{onExportPackage || onImportPackage ? (
				<Card>
					<CardHeader>
						<CardTitle variant="section">Share this Space</CardTitle>
						<CardDescription>
							Pages and database rows export as Markdown with frontmatter.
							Embeddings and binary files stay on this node.
						</CardDescription>
					</CardHeader>
					<CardContent layout="stack">
						<input
							accept=".ryupack,.zip,application/zip"
							aria-label="Portable Space package"
							className="sr-only"
							onChange={(event: ChangeEvent<HTMLInputElement>) => {
								const file = event.target.files?.[0];
								if (file) {
									onImportPackage?.(file);
								}
								event.target.value = "";
							}}
							ref={portableInput}
							type="file"
						/>
						<div className="flex flex-wrap gap-2">
							<Button
								disabled={portableBusy || !onExportPackage}
								loading={portableBusy}
								onClick={onExportPackage}
								size="sm"
								type="button"
								variant="outline"
							>
								{!portableBusy && (
									<HugeiconsIcon className="size-4" icon={Download01Icon} />
								)}
								Export package
							</Button>
							<Button
								disabled={portableBusy || !onImportPackage}
								onClick={() => portableInput.current?.click()}
								size="sm"
								type="button"
								variant="outline"
							>
								<HugeiconsIcon className="size-4" icon={Upload01Icon} />
								Import package
							</Button>
						</div>
						{portableError ? (
							<p className="text-sm text-status-destructive">{portableError}</p>
						) : null}
						{portableNotice && !portableBusy ? (
							<p className="text-muted-foreground text-xs">{portableNotice}</p>
						) : null}
					</CardContent>
				</Card>
			) : null}
			{canEditRetrieval && retrievalMode !== undefined ? (
				<Card>
					<CardHeader>
						<CardTitle variant="section">Retrieval</CardTitle>
						{/* Names the CHOICE only. Where it applies is a line down, in
						    RETRIEVAL_MODE_SCOPE, which the picker renders; restating it
						    here would either duplicate it or (worse) let the two drift into
						    different promises. This line has been wrong twice in opposite
						    directions: "How this space finds answers when an agent searches
						    it" claimed the whole agent surface while chat recall ignored
						    the setting, and the correction ("a DIRECT search of this
						    space") became an underclaim once chat recall started
						    delegating to the same search. Naming the algorithm and letting
						    the scope line own the reach is what stops a third round. */}
						{/* The friendly wording keeps this line's job — naming the CHOICE,
						    never its reach — and only drops the word "algorithm", which
						    is the one term here a non-developer cannot act on. */}
						<CardDescription>
							{friendly
								? "How this space looks things up."
								: "Which algorithm this space is searched with."}
						</CardDescription>
					</CardHeader>
					<CardContent layout="stack">
						<RetrievalModeChoice
							disabled={retrievalModeBusy}
							idPrefix="space-retrieval-mode"
							mode={retrievalMode}
							onModeChange={(next) => onRetrievalModeChange?.(next)}
						/>
						<p className="text-muted-foreground text-xs">
							{friendly
								? RETRIEVAL_MODE_SWITCH_DISCLOSURE_FRIENDLY
								: RETRIEVAL_MODE_SWITCH_DISCLOSURE}
						</p>
						{retrievalModeBusy ? (
							<div className="flex items-center justify-between gap-3 text-muted-foreground text-xs">
								<p className="flex items-center gap-2">
									<Spinner className="size-3" />
									{friendly
										? "Working out how these documents connect…"
										: "Rebuilding this space's entity graph…"}
									{retrievalModeProgress &&
									retrievalModeProgress.totalChunks > 0
										? ` ${retrievalModeProgress.processedChunks}/${retrievalModeProgress.totalChunks} chunks`
										: null}
								</p>
								{onCancelRetrievalMode ? (
									<Button
										onClick={onCancelRetrievalMode}
										size="sm"
										type="button"
										variant="outline"
									>
										Cancel
									</Button>
								) : null}
							</div>
						) : null}
						{retrievalModeError ? (
							<p className="text-sm text-status-destructive">
								{retrievalModeError}
							</p>
						) : null}
						{retrievalModeNotice && !retrievalModeBusy ? (
							<p className="text-muted-foreground text-xs">
								{retrievalModeNotice}
							</p>
						) : null}
					</CardContent>
				</Card>
			) : null}

			<section className="flex flex-col gap-3">
				<h3 className="font-medium text-sm">Search</h3>
				<form className="flex gap-2" onSubmit={handleSearch}>
					<Input
						aria-label="Search query"
						onChange={(e: ChangeEvent<HTMLInputElement>) =>
							onSearchQueryChange?.(e.target.value)
						}
						placeholder="Search within this space"
						value={searchQuery}
					/>
					<Button
						disabled={!searchQuery.trim()}
						loading={searchBusy}
						size="sm"
						type="submit"
					>
						{!searchBusy && (
							<HugeiconsIcon className="size-4" icon={Search01Icon} />
						)}
						Search
					</Button>
				</form>
				{searchError ? (
					<p className="text-sm text-status-destructive">{searchError}</p>
				) : null}
				{searchResults !== null && searchResults !== undefined ? (
					searchResults.length === 0 ? (
						<p className="text-muted-foreground text-sm">No matches found.</p>
					) : (
						<ol className="flex flex-col gap-2">
							{searchResults.map((match, index) => (
								<li className="rounded-md border px-3 py-2" key={match.chunkId}>
									<div className="mb-1 flex items-center gap-2">
										<Badge variant="secondary">#{index + 1}</Badge>
									</div>
									<p className="text-sm">{match.content}</p>
								</li>
							))}
						</ol>
					)
				) : null}
			</section>
		</SpaceHomeShell>
	);
}

export function SpacesView({
	loading,
	error,
	spaces,
	detail,
	onCreateSpace,
	onRetry,
}: SpacesViewProps) {
	if (loading) {
		return (
			<div className="flex h-full items-center justify-center">
				<Spinner />
			</div>
		);
	}

	if (error) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={LibraryIcon} />
					</EmptyMedia>
					<EmptyTitle>Could not load spaces</EmptyTitle>
					<EmptyDescription>{error}</EmptyDescription>
				</EmptyHeader>
				{onRetry ? (
					<EmptyContent>
						<Button onClick={onRetry} size="sm" variant="ghost">
							Try again
						</Button>
					</EmptyContent>
				) : null}
			</Empty>
		);
	}

	// The Spaces sidebar section (AppSidebar) is the space picker now, so the page
	// is a single full-width detail: it shows the selected space, prompts to pick
	// one, or (when there are none) offers to create the first.
	let body: ReactNode;
	if (spaces.length === 0) {
		body = (
			<div className="scroll-fade flex-1 overflow-auto p-4">
				<Empty className="h-full">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<HugeiconsIcon icon={LibraryIcon} />
						</EmptyMedia>
						<EmptyTitle>No spaces yet</EmptyTitle>
						<EmptyDescription>
							Create a space, ingest documents into it, then search across them.
						</EmptyDescription>
					</EmptyHeader>
					{onCreateSpace ? (
						<EmptyContent>
							<Button onClick={onCreateSpace} size="sm">
								Create your first space
							</Button>
						</EmptyContent>
					) : null}
				</Empty>
			</div>
		);
	} else if (detail) {
		body = detail.importPanel ? (
			<Tabs className="flex min-h-0 flex-1 flex-col" defaultValue="content">
				<div className="border-b px-4 pt-3">
					<TabsList manageLayout={false} variant="line">
						<TabsTrigger value="content">Content</TabsTrigger>
						<TabsTrigger value="import">Import</TabsTrigger>
					</TabsList>
				</div>
				<TabsContent className="min-h-0 flex-1 overflow-hidden" value="content">
					<div className="scroll-fade h-full overflow-auto">
						<SpaceDetail {...detail} />
					</div>
				</TabsContent>
				<TabsContent className="min-h-0 flex-1 overflow-hidden" value="import">
					<div className="scroll-fade h-full overflow-auto">
						{detail.importPanel}
					</div>
				</TabsContent>
			</Tabs>
		) : (
			<div className="scroll-fade flex-1 overflow-auto">
				<SpaceDetail {...detail} />
			</div>
		);
	} else {
		body = (
			<div className="scroll-fade flex-1 overflow-auto p-4">
				<Empty className="h-full">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<HugeiconsIcon icon={LibraryIcon} />
						</EmptyMedia>
						<EmptyTitle>Select a space</EmptyTitle>
						<EmptyDescription>
							Pick a space from the sidebar to view its pages, databases, and
							search.
						</EmptyDescription>
					</EmptyHeader>
					{onCreateSpace ? (
						<EmptyContent>
							<Button onClick={onCreateSpace} size="sm" variant="ghost">
								Create a space
							</Button>
						</EmptyContent>
					) : null}
				</Empty>
			</div>
		);
	}

	return <div className="flex h-full flex-col overflow-hidden">{body}</div>;
}
