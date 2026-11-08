// The words on a Spaces file row whose text could not be read.
//
// Core records why a file's contents are not searchable as a stable
// `reason_code` (`ParseFailureReason::code` in
// `apps/core/src/document_parse/parse_failure.rs` plus the `REASON_*` codes in
// `apps/core/src/space_file_index.rs`) next to an English `message`. For a
// provider failure that message is the document converter's own text
// ("parse exceeded the 600s limit …", "libreoffice is not installed — …"),
// which no catalog covers. So the row leads with one whole translated sentence
// per code, and the raw converter text stays only as a secondary, left-to-right
// isolated detail line, the same way Plugin Doctor findings render from codes.

import type { LiteralMessage } from "@ryu/i18n/react";
import { rowDetail } from "./spaces-index-state.ts";
import type { SpaceDocumentRow } from "./spaces-types.ts";

/** What a file row shows under its title: a sentence, and maybe a raw detail. */
export interface FileRowDetail {
	/** Raw, untranslated text from Core or the converter, shown LTR-isolated. */
	detail: string | null;
	/** The translated line, or `null` for a row with nothing to say. */
	message: string | null;
}

/**
 * Codes whose `message` is a converter's (or a provider hop's) own words, which
 * is the diagnosable part of a failure, so they keep it as the detail line. For
 * every other known code the message is Core's English restatement of the code,
 * and the translated sentence already says it.
 */
const CODES_WITH_PROVIDER_DETAIL = new Set([
	"provider_error",
	"provider_timeout",
]);

/** The translated sentence for a known code, or `null` for an unknown one. */
export function fileFailureSentence(
	code: string | null | undefined,
	tl: LiteralMessage
): string | null {
	switch (code) {
		case "provider_error":
			return tl("The document reader couldn't read this file.");
		case "provider_timeout":
			return tl(
				"Reading this file took too long. Upload it again to retry, or split a very large file into smaller ones."
			);
		case "too_large":
			return tl("This file is too large to read.");
		case "python_missing":
			return tl(
				"The document reader can't run because Python isn't installed on this node."
			);
		case "blob_unavailable":
			return tl("The stored copy of this file couldn't be opened.");
		case "not_text":
			return tl(
				"This file's name says it's text, but its contents aren't. Upload it again under its real file type."
			);
		case "pending_abandoned":
			return tl(
				"Reading this file stopped before it finished, for example because Ryu restarted. Upload it again to retry."
			);
		case "no_provider":
			return tl("No installed document reader can open this file type.");
		case "unsupported_format":
			return tl("Nothing on this node can read this file type.");
		case "empty_document":
			return tl("This file contains no extractable text.");
		case "no_parse_context":
			return tl("This file hasn't been read yet.");
		case "status_unavailable":
			return tl(
				"This file is being read, but the result can't be saved on this node."
			);
		default:
			return null;
	}
}

function nonEmpty(text: string | null | undefined): string | null {
	const trimmed = text?.trim();
	return trimmed ? trimmed : null;
}

/**
 * A failed file's row text from its `reason_code` and raw `message`.
 *
 * An unknown or absent code (a newer Core, an older node that sent no code)
 * falls back to a generic sentence and keeps the raw message as the detail, so
 * the reason is never lost, only demoted.
 */
export function fileFailureMessage(
	code: string | null | undefined,
	rawMessage: string | null | undefined,
	tl: LiteralMessage
): FileRowDetail {
	const raw = nonEmpty(rawMessage);
	const known = fileFailureSentence(code, tl);
	if (known === null) {
		return { message: tl("Couldn't read this file."), detail: raw };
	}
	const keepsDetail = CODES_WITH_PROVIDER_DETAIL.has(code ?? "");
	return { message: known, detail: keepsDetail ? raw : null };
}

/**
 * The second line (and optional raw detail) of a document row.
 *
 * A `failed` file is worded from its code; every other state keeps
 * {@link rowDetail}'s answer (an `indexed` file's warnings, otherwise nothing).
 */
export function rowDetailLines(
	doc: SpaceDocumentRow,
	tl: LiteralMessage
): FileRowDetail {
	if (doc.indexState === "failed") {
		return fileFailureMessage(doc.indexReasonCode, doc.indexMessage, tl);
	}
	return { message: rowDetail(doc), detail: null };
}
