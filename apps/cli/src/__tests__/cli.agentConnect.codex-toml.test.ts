// `ryu connect codex`: the Codex TOML merge and removal rules (pure string
// functions), split from cli.agentConnect.test.ts.

import { describe, expect, test } from "bun:test";
import {
	readEntry,
	removeEntry,
	UnsupportedConfigError,
	writeEntry,
} from "../cli/agentConnect.ts";
import {
	agent,
	inlineEntry,
	MCP_URL,
	TOKEN,
} from "./agent-connect-fixtures.ts";

describe("Codex TOML config", () => {
	const codex = () => agent("codex");
	const original = [
		"# my codex config",
		'model = "o3"',
		"",
		"[mcp_servers.git]",
		'command = "mcp-git"',
		"",
		"# profiles",
		"[profiles.fast]",
		'model = "o4-mini"',
		"",
	].join("\n");

	test("connect appends a table and keeps comments and layout", () => {
		const next = writeEntry(codex(), original, inlineEntry("codex"));
		expect(next.startsWith(original)).toBe(true);
		expect(next.slice(original.length)).toBe(
			`\n[mcp_servers.ryu]\nurl = "${MCP_URL}"\nhttp_headers = { Authorization = "Bearer ${TOKEN}" }\n`
		);
		expect(readEntry(codex(), next)).toEqual(inlineEntry("codex"));
	});

	test("disconnect restores the original bytes", () => {
		const next = writeEntry(codex(), original, inlineEntry("codex"));
		expect(removeEntry(codex(), next, false)).toBe(original);
	});

	test("an existing ryu table is replaced in place, subtables included", () => {
		const withRyu = [
			'model = "o3"',
			"",
			"[mcp_servers.ryu]",
			'url = "http://old/mcp/ryu"',
			"",
			"[mcp_servers.ryu.tools.x]",
			'approval_mode = "approve"',
			"",
			"# git server",
			"[mcp_servers.git]",
			'command = "mcp-git"',
			"",
		].join("\n");
		const next = writeEntry(codex(), withRyu, inlineEntry("codex"));
		expect(next).toBe(
			[
				'model = "o3"',
				"",
				"[mcp_servers.ryu]",
				`url = "${MCP_URL}"`,
				`http_headers = { Authorization = "Bearer ${TOKEN}" }`,
				"",
				"# git server",
				"[mcp_servers.git]",
				'command = "mcp-git"',
				"",
			].join("\n")
		);
		expect(readEntry(codex(), next)).toEqual(inlineEntry("codex"));
	});

	test("CRLF files stay CRLF", () => {
		const crlf = 'model = "o3"\r\n';
		const next = writeEntry(codex(), crlf, inlineEntry("codex"));
		expect(next).not.toMatch(/[^\r]\n/);
		expect(removeEntry(codex(), next, false)).toBe(crlf);
	});

	test("an inline ryu entry or a root inline server map is refused", () => {
		const inline = '[mcp_servers]\nryu = { url = "http://x" }\n';
		expect(() => writeEntry(codex(), inline, inlineEntry("codex"))).toThrow(
			UnsupportedConfigError
		);
		expect(() => removeEntry(codex(), inline, false)).toThrow(
			UnsupportedConfigError
		);
		const rootInline = 'mcp_servers = { git = { command = "g" } }\n';
		expect(() => writeEntry(codex(), rootInline, inlineEntry("codex"))).toThrow(
			UnsupportedConfigError
		);
	});

	test("a file Ryu created is deleted once only its table remains", () => {
		const created = writeEntry(codex(), null, inlineEntry("codex"));
		expect(removeEntry(codex(), created, true)).toBeNull();
	});
});
