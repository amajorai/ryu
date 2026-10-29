import { requireTestValue } from "./test-required.ts";
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
// ── Why this reads the file instead of importing it ──────────────────────────
//
// `spaces.tsx` imports `@ryu/ui/components/*` without file extensions. That subpath
// resolves under the desktop app's bundler and does NOT resolve under `bun test`,
// so `import { RETRIEVAL_MODE_SCOPE } from "./spaces.tsx"` fails at module load —
// verified, not assumed. Reading the literal out of the source is the honest
// alternative for an assertion about a *string*: {@link copyLiteral} THROWS when a
// constant is missing or re-spelled, so a renamed export reads as "go fix this
// test", never as a silently-passing scan of a file that no longer says anything.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE_FILE = "packages/blocks/src/desktop/spaces.tsx";
const SOURCE = readFileSync(join(import.meta.dir, "spaces.tsx"), "utf8");

/**
 * Pull the value of an exported single-string constant out of the source.
 *
 * Throws rather than returning `""`: every assertion below is about what a
 * sentence says, and an empty string satisfies most `not.toMatch` checks. The
 * failure names the constant and the file so whoever renamed it knows where to go.
 */
function copyLiteral(name: string): string {
	const match = new RegExp(
		`(?:export )?const ${name}\\s*(?::[^=]+)?=\\s*"((?:[^"\\\\]|\\\\.)*)"`
	).exec(SOURCE);
	if (!match) {
		throw new Error(
			`copy test lost its target: \`${name}\` is no longer a single-string ` +
				`const in ${SOURCE_FILE}. These tests assert what that sentence claims ` +
				"about Core's retrieval_mode scope; re-point them (and re-check the " +
				"new copy against apps/desktop/src/lib/api/spaces.test.ts, which pins " +
				"what Core actually reads the column for)."
		);
	}
	return requireTestValue(match[1], `copy literal ${name}`);
}

/**
 * Every blurb in `RETRIEVAL_MODE_OPTIONS`, keyed by mode. Throws if a mode is gone.
 *
 * `field` selects the technical blurb or the friendly-mode one. Both are asserted
 * against the same claims below, because the friendly copy is not a summary of the
 * technical copy — friendly mode ships default-ON, so it is the copy nearly every
 * user actually reads, and a consequence dropped from it is a consequence dropped
 * from the product for almost everybody.
 */
function modeBlurb(
	value: "graph" | "vector",
	field: "blurb" | "friendlyBlurb" = "blurb"
): string {
	const options = SOURCE.slice(
		SOURCE.indexOf("export const RETRIEVAL_MODE_OPTIONS"),
		SOURCE.indexOf("export const RETRIEVAL_MODE_SCOPE")
	);
	// `blurb:` is matched with a preceding boundary so it cannot also match the
	// tail of `friendlyBlurb:` (and vice versa) once both fields are present.
	const match = new RegExp(
		`value: "${value}",[\\s\\S]*?(?:^|\\s)${field}:\\s*((?:\\s*"(?:[^"\\\\]|\\\\.)*")+)`,
		"m"
	).exec(options);
	if (!match) {
		throw new Error(
			`copy test lost its target: no \`${value}\` entry with a \`${field}\` in ` +
				`RETRIEVAL_MODE_OPTIONS (${SOURCE_FILE}).`
		);
	}
	// Blurbs are prettier-wrapped into adjacent string literals; rejoin them.
	return [
		...requireTestValue(match[1], "wrapped copy literal").matchAll(
			/"((?:[^"\\]|\\.)*)"/g
		),
	]
		.map((m) => requireTestValue(m[1], "copy string fragment"))
		.join("");
}

const SCOPE = copyLiteral("RETRIEVAL_MODE_SCOPE");

/**
 * The source with comments removed — what the user can actually be shown.
 *
 * The distinction is load-bearing here, not pedantry. The doc comments in
 * `spaces.tsx` deliberately QUOTE the retired overclaim, because a reader who does
 * not know what the old sentence promised cannot tell why the new one is worded so
 * carefully. Scanning raw source would make keeping that explanation impossible;
 * scanning the rendered half lets the file explain its own history while still
 * failing if the history comes back as shipping copy.
 */
const RENDERED = SOURCE.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(
	/^\s*\/\/.*$/gm,
	""
);

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

// ── "This file is stored, but its contents are not searchable" ────────────────
//
// The overclaim being retired here is not a sentence — it is a NUMBER. Every
// document row carried a `<n> chunks` badge, files included, and a file whose text
// was never read gets exactly one chunk: `title` + mime, the descriptor
// `SpaceStore::create_file` embeds. So a 300-page PDF read "1 chunk", beside pages
// whose badge counts real extracted text, in a list headed by a search box. Nothing
// said the PDF's prose had never been read, and a user who searched for a phrase
// they knew was in it got an empty result with no reason.
//
// Core now records WHY, in five states (`space_file_index.rs`), and the notes below
// exist because those five states carry FOUR different user actions. The tests pin
// that they stay distinguishable — collapsing them back into one "not searchable"
// sentence would leave a user with a fixable problem no way to learn it is fixable,
// which is the same shape of defect as the badge itself.
//
// One negative is load-bearing and scoped rather than global: `unattempted` must NOT
// tell the user to install anything (nobody has looked yet — installing a reader
// does not retroactively read the file), while `skipped` MUST (nothing on this node
// can read the format, and that is exactly what installing fixes). An earlier
// revision of this file banned "install" across all of the copy, which was correct
// while no ingestion path called `document.parse` and became wrong the moment
// `create_file_indexed` landed.

/** The value of one entry in the `FILE_INDEX_NOTES` record. Throws if it is gone. */
function indexNote(state: string): string {
	const notes = SOURCE.slice(SOURCE.indexOf("export const FILE_INDEX_NOTES"));
	const match = new RegExp(
		`\\n\\t${state}:\\s*((?:\\s*"(?:[^"\\\\]|\\\\.)*")+)`
	).exec(notes);
	if (!match) {
		throw new Error(
			`copy test lost its target: no \`${state}\` entry in FILE_INDEX_NOTES ` +
				`(${SOURCE_FILE}). Core's IndexState has five wire states and each ` +
				"not-indexed one needs a sentence saying what the user can do about it."
		);
	}
	return [
		...requireTestValue(match[1], "wrapped copy literal").matchAll(
			/"((?:[^"\\]|\\.)*)"/g
		),
	]
		.map((m) => requireTestValue(m[1], "copy string fragment"))
		.join("");
}

const UNATTEMPTED = indexNote("unattempted");
const SKIPPED = indexNote("skipped");
const FAILED = indexNote("failed");
const PENDING = indexNote("pending");
const NOT_INDEXED_BADGE = copyLiteral("FILE_CONTENTS_NOT_INDEXED_BADGE");

describe("every not-indexed state says what a search will and will not find", () => {
	it("says the file is still stored and still opens", () => {
		// The scope limit is not a loss. Copy that reads like a failure invites a
		// re-upload that changes nothing (or, worse, a delete).
		for (const note of [UNATTEMPTED, SKIPPED, FAILED]) {
			expect(note).toMatch(/stored/i);
			expect(note).toMatch(/open/i);
		}
	});

	it("names what IS matched, so the limit is concrete", () => {
		for (const note of [UNATTEMPTED, SKIPPED, FAILED]) {
			expect(note).toMatch(/name and file type/i);
		}
	});

	it("uses no jargon a non-expert has to decode to act on it", () => {
		for (const note of [UNATTEMPTED, SKIPPED, FAILED, PENDING]) {
			expect(note).not.toMatch(/chunk|embed|vector|extract|parse|index/i);
		}
	});
});

describe("the four states carry four different actions", () => {
	it("skipped — and only skipped — tells the user to install a reader", () => {
		// True BECAUSE `create_file_indexed` routes every upload through the
		// `document.parse` facade: binding a provider changes the outcome of the next
		// upload. It was false, and banned here, while nothing called the facade.
		expect(SKIPPED).toMatch(/install a document reader/i);
		expect(SKIPPED).toMatch(/upload the file again/i);
		// No app is named: which providers exist is the Store's business, and a
		// sentence listing four of them goes stale when a fifth ships.
		expect(SKIPPED).not.toMatch(/markitdown|docling|unstructured|mineru/i);
	});

	it("unattempted does NOT — nobody has looked, so there is nothing to install", () => {
		// The scoped negative. Telling this user to install a reader would send them
		// to the Store to fix a problem they do not have.
		expect(UNATTEMPTED).not.toMatch(/install/i);
		expect(UNATTEMPTED).toMatch(/nothing has tried to read these yet/i);
		// The remedy that works from this screen is the shared file drop zone above
		// the table, which sends the file through Core's extraction path.
		expect(UNATTEMPTED).toMatch(/Drop files here/);
	});

	it("failed points at the per-file reason rather than guessing at one", () => {
		expect(FAILED).toMatch(/upload the file again/i);
		expect(FAILED).toMatch(/shown on each file/i);
		expect(FAILED).not.toMatch(/install/i);
	});

	it("pending is not written as a failure — the text is on its way", () => {
		expect(PENDING).toMatch(/being read now/i);
		expect(PENDING).toMatch(/becomes searchable/i);
		expect(PENDING).not.toMatch(/not searchable|cannot|could not|fail/i);
	});

	it("no state's copy reads as data loss", () => {
		for (const note of [UNATTEMPTED, SKIPPED, FAILED, PENDING]) {
			expect(note).not.toMatch(/deleted|lost|discard/i);
		}
	});
});

describe("the document list", () => {
	it("replaces the chunk count instead of showing both", () => {
		// "1 chunk · Name only" invites the reading that one chunk of the file's
		// TEXT is indexed — the same wrong belief in a smaller font. `indexBadgeLabel`
		// returns null for "say nothing", and null is the ONLY branch that renders a
		// count.
		expect(RENDERED).toMatch(
			/badge === null \?[\s\S]{0,300}doc\.chunkCount[\s\S]{0,300}\) : \([\s\S]{0,200}\{badge\}/
		);
	});

	it("treats an unknown state as 'say nothing', not as 'not searchable'", () => {
		// `indexState` is optional: the storyboard's mock rows omit it, every
		// non-file document omits it, and any row Core has not answered for omits it.
		// A truthiness test would badge the entire list "Name only" on those surfaces.
		expect(RENDERED).not.toMatch(/!\s*doc\.indexState/);
		expect(RENDERED).toMatch(
			/state === undefined \|\| state === "indexed"[\s\S]{0,80}return null/
		);
	});

	it("badges pending differently from the three not-searchable states", () => {
		expect(RENDERED).toContain("FILE_CONTENTS_PENDING_BADGE");
		expect(copyLiteral("FILE_CONTENTS_PENDING_BADGE")).not.toBe(
			NOT_INDEXED_BADGE
		);
	});

	it("shows each explanation only when a row is actually in that state", () => {
		// A space of pages must be untouched; a space of PDFs gets one sentence per
		// state present, in a fixed order so the notes do not reshuffle as files
		// finish parsing.
		expect(RENDERED).toContain(
			"documents.some((doc) => doc.indexState === state)"
		);
	});

	it("surfaces a failed file's reason and an indexed file's warnings per row", () => {
		// Both differ per document, so a per-list note cannot carry them. A retry the
		// user cannot diagnose is a retry they will make twice; a parse that half
		// worked and says nothing is the silent-drop bug wearing a hat.
		expect(RENDERED).toMatch(
			/doc\.indexState === "failed"[\s\S]{0,140}doc\.indexMessage/
		);
		expect(RENDERED).toMatch(
			/doc\.indexState === "indexed" && warnings\.length > 0/
		);
	});

	it("keeps the badge short enough to sit at the end of a row", () => {
		expect(NOT_INDEXED_BADGE.length).toBeLessThanOrEqual(16);
		// Names what IS indexed rather than what is missing, so the row is readable
		// on its own and the note carries the consequence.
		expect(NOT_INDEXED_BADGE).toMatch(/name/i);
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
