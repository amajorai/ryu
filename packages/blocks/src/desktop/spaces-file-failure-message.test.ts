import { describe, expect, it } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	fileFailureMessage,
	fileFailureSentence,
	rowDetailLines,
} from "./spaces-file-failure-message.ts";

// A German stand-in catalog: every known code must resolve to one of these whole
// sentences, never to the English source or to Core's raw message.
const DE: Record<string, string> = {
	"The document reader couldn't read this file.":
		"Der Dokumentleser konnte diese Datei nicht lesen.",
	"Reading this file took too long. Upload it again to retry, or split a very large file into smaller ones.":
		"Das Lesen dieser Datei hat zu lange gedauert. Lade sie erneut hoch oder teile eine sehr große Datei auf.",
	"This file is too large to read.": "Diese Datei ist zu groß zum Lesen.",
	"The document reader can't run because Python isn't installed on this node.":
		"Der Dokumentleser kann nicht starten, weil Python auf diesem Knoten fehlt.",
	"The stored copy of this file couldn't be opened.":
		"Die gespeicherte Kopie dieser Datei konnte nicht geöffnet werden.",
	"This file's name says it's text, but its contents aren't. Upload it again under its real file type.":
		"Der Name dieser Datei verspricht Text, der Inhalt ist aber keiner. Lade sie mit ihrem echten Dateityp erneut hoch.",
	"Reading this file stopped before it finished, for example because Ryu restarted. Upload it again to retry.":
		"Das Lesen dieser Datei wurde abgebrochen, etwa durch einen Neustart von Ryu. Lade sie erneut hoch.",
	"No installed document reader can open this file type.":
		"Kein installierter Dokumentleser kann diesen Dateityp öffnen.",
	"Nothing on this node can read this file type.":
		"Nichts auf diesem Knoten kann diesen Dateityp lesen.",
	"This file contains no extractable text.":
		"Diese Datei enthält keinen auslesbaren Text.",
	"This file hasn't been read yet.": "Diese Datei wurde noch nicht gelesen.",
	"This file is being read, but the result can't be saved on this node.":
		"Diese Datei wird gelesen, aber das Ergebnis kann auf diesem Knoten nicht gespeichert werden.",
	"Couldn't read this file.": "Diese Datei konnte nicht gelesen werden.",
};

const german = (source: string): string => DE[source] ?? `MISSING:${source}`;

const de = german as LiteralMessage;

// Every reason code Core can put on a file row: `ParseFailureReason::code` plus
// the `REASON_*` constants in `space_file_index.rs`.
const CORE_CODES = [
	"unsupported_format",
	"no_provider",
	"provider_timeout",
	"provider_error",
	"too_large",
	"python_missing",
	"blob_unavailable",
	"not_text",
	"empty_document",
	"no_parse_context",
	"status_unavailable",
	"pending_abandoned",
];

const CONVERTER_TEXT =
	"parse exceeded the 600s limit (split very large scans into smaller files)";

describe("Spaces file failure messages", () => {
	it("words every known Core code as a whole German sentence", () => {
		const sentences = new Set<string>();
		for (const code of CORE_CODES) {
			const sentence = fileFailureSentence(code, de);
			expect(sentence).not.toBeNull();
			expect(sentence).not.toStartWith("MISSING:");
			sentences.add(sentence ?? "");
		}
		// One sentence per code: two codes sharing words would hide which fix applies.
		expect(sentences.size).toBe(CORE_CODES.length);
	});

	it("keeps a converter's own text only as the detail of a provider failure", () => {
		expect(fileFailureMessage("provider_timeout", CONVERTER_TEXT, de)).toEqual({
			message: german(
				"Reading this file took too long. Upload it again to retry, or split a very large file into smaller ones."
			),
			detail: CONVERTER_TEXT,
		});
		expect(
			fileFailureMessage(
				"provider_error",
				"libreoffice is not installed — install it and retry",
				de
			).detail
		).toBe("libreoffice is not installed — install it and retry");
	});

	it("drops Core's English restatement for a code the sentence already covers", () => {
		expect(
			fileFailureMessage(
				"pending_abandoned",
				"the parse stopped before it finished",
				de
			)
		).toEqual({
			message: german(
				"Reading this file stopped before it finished, for example because Ryu restarted. Upload it again to retry."
			),
			detail: null,
		});
	});

	it("falls back to a generic sentence plus the raw detail for an unknown code", () => {
		expect(
			fileFailureMessage("converter_exploded", CONVERTER_TEXT, de)
		).toEqual({
			message: german("Couldn't read this file."),
			detail: CONVERTER_TEXT,
		});
		// An older node sends no code at all; the reason is demoted, never lost.
		expect(fileFailureMessage(undefined, "  boom  ", de)).toEqual({
			message: german("Couldn't read this file."),
			detail: "boom",
		});
		expect(fileFailureMessage(null, "   ", de).detail).toBeNull();
	});

	it("words failed rows from their code and leaves other rows as they were", () => {
		expect(
			rowDetailLines(
				{
					chunkCount: 1,
					id: "doc-1",
					indexMessage: CONVERTER_TEXT,
					indexReasonCode: "provider_timeout",
					indexState: "failed",
					title: "scan.pdf",
				},
				de
			).detail
		).toBe(CONVERTER_TEXT);
		expect(
			rowDetailLines(
				{
					chunkCount: 3,
					id: "doc-2",
					indexState: "indexed",
					indexWarnings: ["output was truncated"],
					title: "big.pdf",
				},
				de
			)
		).toEqual({ message: "output was truncated", detail: null });
		expect(
			rowDetailLines({ chunkCount: 2, id: "doc-3", title: "Page" }, de)
		).toEqual({ message: null, detail: null });
	});
});
