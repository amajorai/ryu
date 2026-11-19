import type { LiteralMessage } from "@ryu/i18n/react";

/** The notice shown after a Space package export, as one catalog sentence. */
export function spaceExportNotice(
	sourceFileCount: number,
	tl: LiteralMessage
): string {
	return tl(
		"Exported {sourceFileCount, plural, one {# source file} other {# source files}}. Embeddings were not included.",
		{ sourceFileCount }
	);
}

/** The notice shown after a Space package import, as one catalog sentence. */
export function spaceImportNotice(
	pageCount: number,
	databaseCount: number,
	tl: LiteralMessage
): string {
	return tl(
		"Imported {pageCount, plural, one {# page} other {# pages}} and {databaseCount, plural, one {# database} other {# databases}}. Embeddings were not included; run the manual embedding re-index when you want RAG.",
		{ pageCount, databaseCount }
	);
}
