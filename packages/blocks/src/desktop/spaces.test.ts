// packages/blocks/src/desktop/spaces.test.ts
//
// The Spaces retrieval copy, held to what Core actually does.
//
// This file exists because of one sentence, which has now been wrong twice in
// OPPOSITE directions — which is the whole argument for pinning copy.
//
//  1. The Retrieval card used to read "How this space finds answers when an agent
//     searches it" — a claim over the whole agent surface, made at the exact moment
//     the user chooses between Vector and Graph. At the time `retrieval_mode`
//     reached one endpoint (`POST /api/spaces/:id/search`, via
//     `SpaceStore::search_ext` → `space_mode`), while the automatic recall on a chat
//     turn went through `RetrievalStore::retrieve`, which was cosine-only and never
//     read the column. A user could set a space to Graph, be told that decides how
//     agents search it, and get cosine on every chat turn forever.
//  2. The correction said chat recall "does not use this setting". Core then gave
//     `RetrievalStore` a `SpaceRecall` delegate that answers an agent's allowlisted
//     spaces through `search_ext` — the function that reads the column — so the
//     carve-out became false and the copy started UNDERclaiming: a user who wanted
//     graph recall in chat was told to stop looking.
//
// The Rust half of the claim is pinned in `apps/desktop/src/lib/api/spaces.test.ts`
// (which can read Core's sources) and now anchors the whole chain, not one endpoint.
// Pinned HERE is the copy: that the scope sentence exists, names the surfaces, does
// not reinstate the carve-out, and is rendered by the PICKER rather than by one of
// its two call sites — a scope line living in a caller is a scope line the other
// caller can ship without.
//
// The source readers (and why these tests read the files instead of importing
// them) live in `spaces-test-source.ts`; the index-state copy is pinned in
// `spaces-index-copy.test.ts`.

import { describe, expect, it } from "bun:test";
import {
	copyLiteral,
	modeBlurb,
	RENDERED,
	SOURCE,
} from "./spaces-test-source.ts";

const SCOPE = copyLiteral("RETRIEVAL_MODE_SCOPE");

describe("RETRIEVAL_MODE_SCOPE", () => {
	it("names each surface that reaches the one branch point in Core", () => {
		// All three go through `SpaceStore::search_ext` → `space_mode()`: the search
		// box, the `ryu_search_space` MCP tool, and — since `RetrievalStore` grew its
		// `SpaceRecall` delegate — the automatic recall on a chat turn. The Rust half
		// of this claim is pinned in apps/desktop/src/lib/api/spaces.test.ts, which
		// can read Core's sources; pinned here is that the sentence still says it.
		expect(SCOPE).toMatch(/searched/i);
		expect(SCOPE).toMatch(/search box/i);
		expect(SCOPE).toMatch(/agent is told to search/i);
		expect(SCOPE).toMatch(/automatic recall/i);
		expect(SCOPE).toMatch(/in a chat/i);
	});

	it("no longer carves chat recall out — the carve-out is now false", () => {
		// The retired sentence, and the reason this file's history is worth keeping:
		// the copy was corrected FROM an overclaim TO this carve-out, and the
		// carve-out then became an underclaim the moment chat recall started
		// delegating to `search_ext`. A user told the setting does not affect chat
		// stops looking for the feature they just enabled.
		expect(SCOPE).not.toMatch(/does not use this setting/i);
		expect(SCOPE).not.toMatch(/does not (apply|affect)/i);
	});

	it("does not describe chat recall as pinned to one algorithm", () => {
		// "Automatic recall during a chat always uses vector search" was wrong before
		// (nothing read the column there) and is wrong now (the column decides). Both
		// spellings of that sentence stay banned.
		expect(SCOPE).not.toMatch(
			/chat[^.]*(always|only)\s+uses?\s+(vector|graph)/i
		);
	});

	it("stays one plain-language qualification, not a disclaimer wall", () => {
		// One sentence now that there is no exclusion to state. A wall of caveats
		// pushes the tradeoff blurbs out of the reader's attention, which is what
		// they are actually there to decide between.
		expect(SCOPE.split(". ").filter(Boolean).length).toBeLessThanOrEqual(2);
	});
});

describe("the retrieval copy as a whole", () => {
	it("no longer claims the mode decides how agents search this space", () => {
		// The retired string, verbatim. A regression here is a copy edit, so nothing
		// else in the build — types, lint, bundler — would catch it. (It is still
		// quoted in this file's comments and in spaces.tsx's; see RENDERED.)
		expect(RENDERED).not.toContain(
			"How this space finds answers when an agent searches it"
		);
	});

	it("mentions agents and chats in exactly one place — the scope sentence", () => {
		// The strongest form of the guard, and the reason it is worth having: the
		// ONLY user-visible words in this module about what an agent does with a
		// space are the ones qualifying the setting's reach. Any new sentence that
		// brings an agent or a chat back into the retrieval story lands here first,
		// and has to be checked against what Core reads the column for.
		const lines = RENDERED.split("\n").filter((l) =>
			/\bagents?\b|\bchats?\b/i.test(l)
		);
		expect(lines.map((l) => l.trim())).toEqual([`"${SCOPE}";`]);
	});

	it("keeps the card description about the ALGORITHM, not the reach", () => {
		// A card description is read on its own, before the picker below it, so it
		// must not make a reach claim the scope line owns — that is how this pair
		// drifted apart twice ("…when an agent searches it" overclaimed; "a DIRECT
		// search of this space" underclaimed once chat recall started delegating).
		// The description names what is being chosen; RETRIEVAL_MODE_SCOPE says
		// where the choice lands. Anchored to the Retrieval card so the ingest and
		// search cards' descriptions are not dragged in.
		const card = RENDERED.slice(
			RENDERED.indexOf('<CardTitle variant="section">Retrieval</CardTitle>'),
			RENDERED.indexOf("<RetrievalModeChoice")
		);
		expect(card).toContain("<CardDescription>");
		expect(card).toMatch(/which algorithm/i);
		expect(card).not.toMatch(/direct search/i);
	});

	it("still explains what each mode does — the tradeoff copy was never wrong", () => {
		// Narrowing the scope must not cost the user the reason to care. Vector's
		// speed and Graph's cross-document reach plus indexing cost stay stated.
		expect(modeBlurb("vector")).toMatch(/fast/i);
		expect(modeBlurb("graph")).toMatch(/across documents/i);
		expect(modeBlurb("graph")).toMatch(/indexing takes longer/i);
	});

	it("says the same things in friendly mode — plainer words, not less", () => {
		// The friendly blurbs are what a default-configured install shows
		// (DEFAULT_FRIENDLY_MODE is true), so every consequence the technical copy
		// carries is asserted against them too. Losing one here would hide it from
		// nearly every user while the technical string kept the test green.
		expect(modeBlurb("vector", "friendlyBlurb")).toMatch(/fast/i);
		expect(modeBlurb("graph", "friendlyBlurb")).toMatch(/across documents/i);
		expect(modeBlurb("graph", "friendlyBlurb")).toMatch(/takes longer/i);
		// The file caveat: Graph indexes an un-extracted upload by name and type
		// only. This is the clause a "make it friendlier" edit is most likely to
		// cut, and the one whose absence produces a user searching for text that
		// was never read.
		expect(modeBlurb("graph", "friendlyBlurb")).toMatch(/name and file type/i);
	});

	it("renames the modes in friendly mode without renaming the wire values", () => {
		// "Vector"/"Graph" name algorithms; the friendly labels name outcomes. The
		// values Core stores must not move with the labels — a copy change that
		// reached the wire would be a data bug wearing a vocabulary change's clothes.
		const options = SOURCE.slice(
			SOURCE.indexOf("export const RETRIEVAL_MODE_OPTIONS"),
			SOURCE.indexOf("export const RETRIEVAL_MODE_SCOPE")
		);
		expect(options).toContain('value: "vector"');
		expect(options).toContain('value: "graph"');
		expect(options).toContain('label: "Vector"');
		expect(options).toContain('label: "Graph"');
		expect(options).toMatch(/friendlyLabel: "[^"]+"/);
		// Neither friendly label may be the algorithm's name — that would make the
		// toggle look broken rather than absent.
		expect(options).not.toMatch(/friendlyLabel: "(Vector|Graph)"/);
	});

	it("renders the scope line from the picker, so both surfaces get it", () => {
		// `RetrievalModeChoice` is used by the create dialog
		// (apps/desktop/src/components/spaces/CreateSpaceDialog.tsx) and by the Space
		// detail card below it. If the constant were rendered by the card instead, a
		// user picking Graph at creation time would never see the qualification —
		// and creation is when the choice is most often made.
		const start = SOURCE.indexOf("export function RetrievalModeChoice(");
		const end = SOURCE.indexOf("const RETRIEVAL_MODE_SWITCH_DISCLOSURE");
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		expect(SOURCE.slice(start, end)).toContain("{RETRIEVAL_MODE_SCOPE}");
	});

	it("still discloses what a mode switch does to the existing graph", () => {
		// Unchanged and still correct — asserted here so a future copy sweep that
		// narrows the scope claim does not also delete the rebuild/discard warning,
		// which is the other thing a user cannot recover from being surprised by.
		const disclosure = copyLiteral("RETRIEVAL_MODE_SWITCH_DISCLOSURE");
		expect(disclosure).toMatch(/rebuilds the entity graph/i);
		expect(disclosure).toMatch(/discards that graph/i);
		expect(disclosure).toMatch(/never re-embedded/i);
	});

	it("discloses the same switch consequences in friendly mode", () => {
		// Same three facts as above — reversible, not free, and not a re-index —
		// stated without "entity graph" or "re-embedded". The friendly disclosure is
		// the one shown by default, so it is the one that has to be complete.
		const friendly = copyLiteral("RETRIEVAL_MODE_SWITCH_DISCLOSURE_FRIENDLY");
		expect(friendly).toMatch(/how they connect/i);
		expect(friendly).toMatch(/throws that map away/i);
		expect(friendly).toMatch(/switch back/i);
		// The clause that heads off the wrong next action after a "Name only" badge.
		expect(friendly).toMatch(/never re-opens an uploaded file/i);
		// The words it exists to avoid.
		expect(friendly).not.toMatch(/entity graph/i);
		expect(friendly).not.toMatch(/re-embedded/i);
	});
});

describe("the retrieval copy, now that files are in the list", () => {
	it("says a file is mapped by its name and type until its text is read", () => {
		// The Graph blurb promised entity extraction over "each document" without
		// qualification. For a file with no extracted text the entities ARE the
		// filename and mime tokens — `create_file` builds its one chunk from
		// `title` + `mime` — so a user picking Graph to connect facts across their
		// PDFs was being promised something the mode could not deliver for them.
		//
		// Worded to hold in both worlds: true unconditionally before extraction
		// shipped, and true of the skipped/failed/unattempted cases after. That is
		// the point — this constant has been corrected twice and must not need a
		// third.
		expect(modeBlurb("graph")).toMatch(/name and file type/i);
		expect(modeBlurb("graph")).toMatch(/unless its text has been extracted/i);
	});

	it("still explains the tradeoff first — the caveat is a clause, not the blurb", () => {
		expect(modeBlurb("graph")).toMatch(/entities/i);
		expect(modeBlurb("graph")).toMatch(/connect facts across documents/i);
	});

	it("tells the user a mode switch will not re-read a file", () => {
		// The wrong action this heads off: someone told a file's contents are not
		// searchable goes looking for the nearest re-index button, and the Retrieval
		// picker is it. `set_retrieval_mode` rebuilds from `SELECT id, content FROM
		// chunks` — the text Core already has — and never re-opens a stored blob;
		// only `replace_file_chunks`, reached solely from extraction, does that. So
		// flipping the mode twice finds no more of a file's text than before.
		const disclosure = copyLiteral("RETRIEVAL_MODE_SWITCH_DISCLOSURE");
		expect(disclosure).toMatch(/never re-reads an uploaded file's contents/i);
	});

	it("does not promise anywhere that uploading makes a file's text searchable", () => {
		expect(RENDERED).not.toMatch(/files? (are|is) (fully )?searchable/i);
		expect(RENDERED).not.toMatch(
			/search (inside|within) (your |uploaded )?files/i
		);
	});
});

describe("the shared-context Space home", () => {
	it("keeps recent Markdown previews above the files table", () => {
		expect(RENDERED).toContain('data-testid="spaces-home"');
		expect(RENDERED).toContain('data-testid="spaces-recent-pages"');
		expect(RENDERED).toContain('data-testid="spaces-files-table"');
		expect(RENDERED).toContain("New");
		expect(RENDERED).toContain("Recent");
		expect(RENDERED).toContain("Pinned");
		expect(RENDERED).toContain("Shared with Me");
		expect(RENDERED).toContain("Files");
		expect(RENDERED).toContain("<Table");
		expect(RENDERED).toContain("Drop files here");
		expect(RENDERED).not.toContain("Ingest a document");
	});

	it("limits paper previews to first-party Markdown pages", () => {
		expect(RENDERED).toMatch(
			/function isMarkdownPage\(doc: SpaceDocumentRow\)[\s\S]{0,180}rawKind/
		);
		expect(RENDERED).toContain(".filter(isMarkdownPage)");
		expect(RENDERED).toContain("previewLoading");
		expect(RENDERED).toContain('label="Blank document"');
	});

	it("does not add decorative copy to the primary home chrome", () => {
		expect(RENDERED).not.toContain("The archive");
		expect(RENDERED).not.toContain("One calm index for every page");
		expect(RENDERED).not.toContain("Start from scratch");
		expect(RENDERED).not.toContain("A guided note");
		expect(RENDERED).not.toContain("Local shared context");
	});

	it("gives the files table its own local search", () => {
		expect(RENDERED).toContain('aria-label="Search files"');
		expect(RENDERED).toContain('placeholder="Search files"');
		expect(RENDERED).toContain("filteredDocuments");
		expect(RENDERED).toContain('aria-label="Files in this Space"');
	});
});
