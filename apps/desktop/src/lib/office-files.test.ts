import { describe, expect, it } from "bun:test";
import {
	parseSpreadsheetInput,
	spreadsheetColumnLabel,
	workspaceFileKind,
} from "./office-files.ts";

describe("workspaceFileKind", () => {
	it("uses the stored MIME before the filename", () => {
		expect(
			workspaceFileKind(
				"report.pdf",
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document"
			)
		).toBe("document");
	});

	it("falls back to case-insensitive Office Open XML extensions", () => {
		expect(workspaceFileKind("Budget.XLSX", null)).toBe("spreadsheet");
		expect(workspaceFileKind("Pitch.PPTX", "application/octet-stream")).toBe(
			"slides"
		);
		expect(workspaceFileKind("scan.pdf", "")).toBe("pdf");
	});

	it("does not claim legacy Office binaries are editable", () => {
		expect(
			workspaceFileKind("old-budget.xls", "application/vnd.ms-excel")
		).toBe("unsupported");
	});
});

describe("workspaceFileKind prototype-like metadata", () => {
	it("uses the filename fallback for unrecognized MIME names", () => {
		expect(workspaceFileKind("report.docx", "constructor")).toBe("document");
		expect(workspaceFileKind("report.xlsx", "__proto__")).toBe("spreadsheet");
	});

	it("keeps unrecognized extensions unsupported", () => {
		expect(workspaceFileKind("report.constructor", null)).toBe("unsupported");
		expect(workspaceFileKind("report.__proto__", "")).toBe("unsupported");
	});
});

describe("spreadsheet helpers", () => {
	it("labels columns beyond Z", () => {
		expect(spreadsheetColumnLabel(1)).toBe("A");
		expect(spreadsheetColumnLabel(26)).toBe("Z");
		expect(spreadsheetColumnLabel(27)).toBe("AA");
		expect(spreadsheetColumnLabel(703)).toBe("AAA");
	});

	it("keeps formulas distinct from typed values", () => {
		expect(parseSpreadsheetInput("=SUM(A1:A2)")).toEqual({
			formula: "SUM(A1:A2)",
			kind: "formula",
		});
		expect(parseSpreadsheetInput("42.5")).toEqual({
			kind: "value",
			value: 42.5,
		});
		expect(parseSpreadsheetInput("false")).toEqual({
			kind: "value",
			value: false,
		});
		expect(parseSpreadsheetInput("")).toEqual({ kind: "blank" });
	});
});
