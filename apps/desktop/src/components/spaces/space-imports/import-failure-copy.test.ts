import { describe, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import { rustModuleSource } from "../../../lib/api/rust-module-source.ts";
import {
	describeImportMessage,
	importStatusLabel,
} from "./import-failure-copy.ts";

// English rendering: the catalog source formatted with its values.
const en = (source: string, values?: MessageValuesInput) =>
	formatMessage(source, values, "en");

describe("describeImportMessage", () => {
	test("rows without a message render nothing", () => {
		expect(describeImportMessage(null, en)).toBeNull();
		expect(describeImportMessage("  ", en)).toBeNull();
	});

	test("a whole-import ZIP refusal keeps the reader error as detail", () => {
		expect(
			describeImportMessage(
				"invalid ZIP archive: invalid Zip archive: EOCD",
				en
			)
		).toEqual({
			lines: [
				{
					detail: "invalid Zip archive: EOCD",
					file: null,
					sentence: "This ZIP archive cannot be opened.",
					translated: true,
				},
			],
			skippedHeading: null,
		});
	});

	test("per-file failures split into the file and a coded sentence", () => {
		const copy = describeImportMessage(
			"notes.csv: delimited file is empty; report.pdf: provider_error: Docling failed",
			en
		);
		expect(copy?.lines).toEqual([
			{
				detail: null,
				file: "notes.csv",
				sentence: "The file is empty.",
				translated: true,
			},
			{
				detail: "Docling failed",
				file: "report.pdf",
				sentence: "The document parser failed on this file.",
				translated: true,
			},
		]);
	});

	test("a file name that contains ': ' still finds the sentence", () => {
		const copy = describeImportMessage(
			"Q3: plan.pdf: no_provider: no parser bound",
			en
		);
		expect(copy?.lines[0]).toMatchObject({
			detail: null,
			file: "Q3: plan.pdf",
		});
	});

	test("values in a sentence are kept", () => {
		const copy = describeImportMessage(
			"ZIP contains more than 10000 entries",
			en
		);
		expect(copy?.lines[0]?.sentence).toBe(
			"The ZIP archive has more than 10,000 entries."
		);
		expect(
			describeImportMessage(
				"nested ZIP archive inner/a.zip is not supported",
				en
			)?.lines[0]?.sentence
		).toBe("The nested ZIP archive inner/a.zip is not supported.");
	});

	test("a partial import gets a plural Skipped heading", () => {
		const copy = describeImportMessage(
			"Skipped a.xyz: unsupported import format; b.csv: table has no header row",
			en
		);
		expect(copy?.skippedHeading).toBe("Skipped 2 sources:");
		expect(copy?.lines.map((line) => line.sentence)).toEqual([
			"This file format cannot be imported.",
			"The table has no header row.",
		]);
	});

	test("a failed row keeps a file named 'Skipped …' as the file name", () => {
		const copy = describeImportMessage(
			"Skipped notes.csv: delimited file is empty",
			en,
			{ failed: true }
		);
		expect(copy?.skippedHeading).toBeNull();
		expect(copy?.lines[0]).toMatchObject({
			file: "Skipped notes.csv",
			sentence: "The file is empty.",
		});
	});

	test("unknown text is shown as it was stored", () => {
		const copy = describeImportMessage("Notion said no", en);
		expect(copy?.lines).toEqual([
			{
				detail: null,
				file: null,
				sentence: "Notion said no",
				translated: false,
			},
		]);
	});
});

test("importStatusLabel maps each wire status to a label", () => {
	expect(importStatusLabel("running", en)).toBe("Running");
	expect(importStatusLabel("pending", en)).toBe("Pending");
	expect(importStatusLabel("completed", en)).toBe("Completed");
	expect(importStatusLabel("failed", en)).toBe("Failed");
});

// The matcher reads the English Core writes, so a reworded Core sentence would
// silently fall back to the stored text. Pin each one to the Core source.
const CORE_SOURCE = new URL(
	"../../../../../../apps/core/src/server/space_imports.rs",
	import.meta.url
);
const CORE_SENTENCES: [stored: string, coreLiteral: string][] = [
	[
		"the spreadsheet parser returned no tables",
		"the spreadsheet parser returned no tables",
	],
	[
		"nested ZIP archives are not supported",
		"nested ZIP archives are not supported",
	],
	["unsupported import format", "unsupported import format"],
	["document conversion timed out", "document conversion timed out"],
	[
		"the action returned no list of records for a database import",
		"the action returned no list of records for a database import",
	],
	[
		"ZIP contains no supported import files",
		"ZIP contains no supported import files",
	],
	[
		"delimited file exceeds the upload size limit",
		"delimited file exceeds the upload size limit",
	],
	[
		"delimited imports must use UTF-8 text",
		"delimited imports must use UTF-8 text",
	],
	[
		"delimited file has an unclosed quoted field",
		"delimited file has an unclosed quoted field",
	],
	["delimited file is empty", "delimited file is empty"],
	["table has no header row", "table has no header row"],
	["table has no columns", "table has no columns"],
	["records have no fields", "records have no fields"],
	[
		"the connector returned nothing to import",
		"the connector returned nothing to import",
	],
	["invalid ZIP archive: bad", "invalid ZIP archive: {error}"],
	[
		"ZIP contains more than 5 entries",
		"ZIP contains more than {MAX_ARCHIVE_ENTRIES} entries",
	],
	["ZIP entry ../x has an unsafe path", "ZIP entry {} has an unsafe path"],
	[
		"nested ZIP archive a.zip is not supported",
		"nested ZIP archive {name} is not supported",
	],
	[
		"delimited ZIP member a.csv exceeds the upload size limit",
		"delimited ZIP member {name} exceeds the upload size limit",
	],
	[
		"expanded ZIP content is over the 256 MB limit",
		"expanded ZIP content is over the 256 MB limit",
	],
	["blob staging task failed: join", "blob staging task failed: {error}"],
	["Skipped a.csv: table has no columns", 'format!("Skipped {}"'],
];

test("every matched sentence is still the one Core writes", async () => {
	const core = await Bun.file(CORE_SOURCE).text();
	for (const [stored, coreLiteral] of CORE_SENTENCES) {
		expect(core).toContain(coreLiteral);
		const copy = describeImportMessage(stored, en);
		expect(copy?.lines.every((line) => line.translated)).toBe(true);
	}
});

test("every parse code the matcher reads is one Core writes", async () => {
	const parse = rustModuleSource("apps/core/src/document_parse");
	expect(parse).toContain(
		'write!(f, "{}: {}", self.reason.code(), self.message)'
	);
	for (const code of [
		"unsupported_format",
		"no_provider",
		"provider_timeout",
		"provider_error",
		"too_large",
		"python_missing",
		"blob_unavailable",
		"not_text",
	]) {
		expect(parse).toContain(`=> "${code}",`);
		const copy = describeImportMessage(`a.pdf: ${code}: detail`, en);
		expect(copy?.lines[0]).toMatchObject({ file: "a.pdf", translated: true });
	}
});
