import { describe, expect, test } from "bun:test";
import { UnsupportedConfigError } from "./agentConnect-errors.ts";
import {
	parseToml,
	removeTomlEntry,
	setTomlEntry,
	tomlRyuEntry,
} from "./agentConnect-toml.ts";

describe("codex TOML splice", () => {
	test("sets and removes the ryu table while keeping other settings", () => {
		const original = 'model = "o3"\n';
		const next = setTomlEntry(
			original,
			{ url: "http://x/mcp/ryu" },
			"config.toml"
		);
		expect(tomlRyuEntry(parseToml(next, "config.toml"))).toEqual({
			url: "http://x/mcp/ryu",
		});
		expect(removeTomlEntry(next, "config.toml")).toBe(original);
	});

	test("an inline entry is refused with a whole sentence", () => {
		const inline = 'mcp_servers = { ryu = { url = "x" } }\n';
		expect(() => setTomlEntry(inline, { url: "y" }, "config.toml")).toThrow(
			UnsupportedConfigError
		);
		expect(() =>
			removeTomlEntry('[mcp_servers]\nryu = { url = "x" }\n', "config.toml")
		).toThrow(
			"config.toml defines mcp_servers.ryu inline, so it cannot be removed safely."
		);
	});
});
