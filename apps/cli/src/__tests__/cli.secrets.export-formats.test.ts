// `ryu-cli secrets export --format csv|toml|hcl|ini`: rendered by the CLI from
// Core's json export, with each format's quoting applied to awkward values.

import { expect, test } from "bun:test";
import {
	csvField,
	hclString,
	iniString,
	renderValues,
	tomlString,
} from "../cli/secrets-export-formats.ts";
import { fakeNode, jsonExport, runSecrets } from "./secrets-fixture.ts";

const AWKWARD: Record<string, string> = {
	PLAIN: "abc123",
	EMPTY: "",
	SPACES: "  padded  ",
	QUOTES: 'say "hi"',
	COMMA: "a,b",
	NEWLINE: "line1\nline2\r\nline3",
	BACKSLASH: "C:\\path\\to",
	HASH: "a#b;c=d",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal template sequence is the test input.
	TEMPLATE: "${HOME} %{if x}",
	UNICODE: "café ☕ 你好",
	CONTROL: "bell\u0007tab\tdel\u007f",
};

/** Minimal RFC 4180 reader, enough to round-trip the export. */
function readCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const char = text[i] ?? "";
		if (quoted) {
			if (char === '"' && text[i + 1] === '"') {
				field += '"';
				i++;
			} else if (char === '"') {
				quoted = false;
			} else {
				field += char;
			}
		} else if (char === '"') {
			quoted = true;
		} else if (char === ",") {
			row.push(field);
			field = "";
		} else if (char === "\r" && text[i + 1] === "\n") {
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
			i++;
		} else {
			field += char;
		}
	}
	return rows;
}

test("csv follows RFC 4180 and round-trips every value", () => {
	expect(csvField("plain")).toBe("plain");
	expect(csvField('a"b')).toBe('"a""b"');
	expect(csvField("a\nb")).toBe('"a\nb"');
	const text = renderValues("csv", AWKWARD, "dev");
	const rows = readCsv(text);
	expect(rows[0]).toEqual(["name", "value"]);
	expect(Object.fromEntries(rows.slice(1))).toEqual(AWKWARD);
});

test("toml uses escaped basic strings that parse back to the values", () => {
	expect(tomlString('a"b\\c\n')).toBe('"a\\"b\\\\c\\n"');
	expect(tomlString("\u0007")).toBe('"\\u0007"');
	const text = renderValues("toml", AWKWARD, "dev");
	expect(Bun.TOML.parse(text)).toEqual(AWKWARD);
});

test("hcl escapes quotes, control characters and template sequences", () => {
	// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal template sequence is the test input.
	expect(hclString("${HOME}")).toBe('"$${HOME}"');
	expect(hclString("%{if x}")).toBe('"%%{if x}"');
	expect(hclString('a"b\\c\nd\te')).toBe('"a\\"b\\\\c\\nd\\te"');
	expect(hclString("\u007f")).toBe('"\\u007F"');
	const text = renderValues("hcl", AWKWARD, "dev");
	expect(text).toContain('TEMPLATE = "$${HOME} %%{if x}"\n');
	expect(text).toContain('NEWLINE = "line1\\nline2\\r\\nline3"\n');
	expect(text).toContain('EMPTY = ""\n');
	expect(text.split("\n").filter(Boolean)).toHaveLength(
		Object.keys(AWKWARD).length
	);
});

test("ini writes one section with every value double-quoted", () => {
	expect(iniString("a#b;c=d")).toBe('"a#b;c=d"');
	expect(iniString('x"y\\z')).toBe('"x\\"y\\\\z"');
	const text = renderValues("ini", AWKWARD, "prod");
	const lines = text.split("\n").filter(Boolean);
	expect(lines[0]).toBe("[prod]");
	expect(lines).toContain('SPACES = "  padded  "');
	expect(lines).toContain('NEWLINE = "line1\\nline2\\r\\nline3"');
	expect(lines).toHaveLength(Object.keys(AWKWARD).length + 1);
});

test("export --format toml asks Core for json and prints toml", async () => {
	const node = fakeNode({
		"POST /api/vault/export": () =>
			Response.json(jsonExport({ API_KEY: 'k"1', DB_URL: "pg://x" })),
	});
	const result = await runSecrets(
		["export", "--no-project", "--format", "toml"],
		node
	);
	expect(result.code).toBe(0);
	expect(JSON.parse(node.calls[0]?.body ?? "{}").format).toBe("json");
	expect(result.out).toBe('API_KEY = "k\\"1"\nDB_URL = "pg://x"\n');
});

test("export --json reports the rendered format", async () => {
	const node = fakeNode({
		"POST /api/vault/export": () =>
			Response.json(jsonExport({ API_KEY: "a,b" })),
	});
	const result = await runSecrets(
		["--json", "export", "--no-project", "--format", "csv"],
		node
	);
	expect(result.code).toBe(0);
	const printed = JSON.parse(result.out);
	expect(printed.format).toBe("csv");
	expect(printed.contentType).toBe("text/csv");
	expect(printed.content).toBe('name,value\r\nAPI_KEY,"a,b"\r\n');
});

test("an unknown format names the CLI-rendered ones", async () => {
	const node = fakeNode({});
	const result = await runSecrets(
		["export", "--no-project", "--format", "xml"],
		node
	);
	expect(result.code).toBe(2);
	expect(result.err).toContain("csv, toml, hcl, or ini");
	expect(node.calls).toEqual([]);
});
