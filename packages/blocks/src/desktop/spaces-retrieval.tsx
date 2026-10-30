"use client";

import { Label } from "@ryu/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@ryu/ui/components/radio-group";
import { useFriendlyMode } from "@ryu/ui/hooks/use-friendly-mode.ts";
import { z } from "zod";

const spaceRetrievalModeSchema = z.enum(["graph", "vector"]);

/**
 * Which retrieval algorithm a Space uses. Structurally identical to the desktop
 * client's `RetrievalMode` (`apps/desktop/src/lib/api/spaces.ts`) — restated here
 * rather than imported because `@ryu/blocks` must not depend on `apps/desktop`.
 * Both are the wire spellings from `RetrievalMode::as_str` in Core.
 */
export type SpaceRetrievalMode = "graph" | "vector";

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
export const RETRIEVAL_MODE_SWITCH_DISCLOSURE =
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
export const RETRIEVAL_MODE_SWITCH_DISCLOSURE_FRIENDLY =
	"Changing this re-reads the documents already in this space to build a map of how they connect; switching back to Quick search throws that map away. Your documents are never read from scratch again, so you can switch back. Switching never re-opens an uploaded file's contents.";
