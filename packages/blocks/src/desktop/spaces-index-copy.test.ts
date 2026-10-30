// packages/blocks/src/desktop/spaces-index-copy.test.ts
//
// The index-state copy of the Spaces document list, split out of
// `spaces.test.ts`; the shared source readers live in `spaces-test-source.ts`.

import { describe, expect, it } from "bun:test";
import { copyLiteral, indexNote, RENDERED } from "./spaces-test-source.ts";

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
