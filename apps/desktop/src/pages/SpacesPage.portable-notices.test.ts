import { describe, expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	spaceExportNotice,
	spaceImportNotice,
} from "./SpacesPage.portable-notices.ts";

const tl: LiteralMessage = (source, values) => formatMessage(source, values);

describe("Space package notices", () => {
	test("export notice pluralizes the source file count", () => {
		expect(spaceExportNotice(1, tl)).toBe(
			"Exported 1 source file. Embeddings were not included."
		);
		expect(spaceExportNotice(7, tl)).toBe(
			"Exported 7 source files. Embeddings were not included."
		);
	});

	test("import notice is one translated sentence with both counts", () => {
		const seen: string[] = [];
		const recording: LiteralMessage = (source, values) => {
			seen.push(source);
			return formatMessage(source, values);
		};
		expect(spaceImportNotice(1, 3, recording)).toBe(
			"Imported 1 page and 3 databases. Embeddings were not included; run the manual embedding re-index when you want RAG."
		);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toContain("{pageCount, plural,");
	});
});
