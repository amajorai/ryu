// apps/desktop/src/lib/api/acp-agent-settings.test.ts
//
// The field names are a contract with Core's `acp_agent_settings.rs`; a rename
// on either side would leave a settings form writing values Core silently
// drops. The mirror tests parse the Rust source.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AcpAgentSettings,
	compactAcpAgentSettings,
	formatEnvText,
	parseAcpAgentSettings,
	parseAcpAgentSettingsView,
	parseArgsText,
	parseEnvText,
} from "./acp-agent-settings.ts";

const RUST_SOURCE = readFileSync(
	join(import.meta.dir, "../../../../../apps/core/src/acp_agent_settings.rs"),
	"utf8"
);

const SNAKE_SEGMENT = /_([a-z])/g;

function camelCase(name: string): string {
	return name.replace(SNAKE_SEGMENT, (_, letter: string) =>
		letter.toUpperCase()
	);
}

function rustStructFields(name: string): string[] {
	const match = RUST_SOURCE.match(
		new RegExp(`pub struct ${name} \\{([\\s\\S]*?)\\n\\}`)
	);
	if (!match?.[1]) {
		throw new Error(
			`acp-agent-settings.test.ts: Rust struct ${name} not found`
		);
	}
	return [...match[1].matchAll(/pub (\w+):/g)].map((field) => field[1] ?? "");
}

describe("acp-agent-settings contract", () => {
	it("serializes Core's settings struct in camelCase", () => {
		expect(RUST_SOURCE).toContain(
			'#[serde(default, rename_all = "camelCase")]\npub struct AcpAgentSettings {'
		);
	});

	it("covers exactly the fields Core deserializes", () => {
		const full: Required<AcpAgentSettings> = {
			allowedModels: [],
			args: [],
			autoCompact: null,
			autoCompactTokens: null,
			cliPath: null,
			command: null,
			configDir: null,
			defaultConfigOptions: {},
			defaultMode: null,
			defaultModel: null,
			env: {},
		};
		expect(Object.keys(full).sort()).toEqual(
			rustStructFields("AcpAgentSettings").map(camelCase).sort()
		);
	});
});

describe("acp-agent-settings parsing", () => {
	it("drops fields of the wrong type instead of trusting them", () => {
		expect(
			parseAcpAgentSettings({
				args: "--flag",
				env: { GOOD: "1", BAD: 2 },
				allowedModels: ["sonnet", 3],
				autoCompactTokens: "400000",
				autoCompact: "no",
				command: 7,
				defaultMode: "plan",
			})
		).toEqual({
			env: { GOOD: "1" },
			allowedModels: ["sonnet"],
			defaultMode: "plan",
		});
		expect(parseAcpAgentSettings("garbage")).toEqual({});
	});

	it("reads Core's settings view, including inheritance and support", () => {
		const view = parseAcpAgentSettingsView(
			{
				agentId: "my-claude",
				inheritedFrom: "acp:claude",
				settings: { args: ["-v"] },
				support: { configDir: true, cliPath: "yes" },
			},
			"my-claude"
		);
		expect(view.inheritedFrom).toBe("acp:claude");
		expect(view.settings.args).toEqual(["-v"]);
		expect(view.support).toEqual({
			autoCompactToggle: false,
			autoCompactTokens: false,
			cliPath: false,
			configDir: true,
			configDirManaged: false,
		});
		expect(parseAcpAgentSettingsView(null, "x").agentId).toBe("x");
	});

	it("compacts an untouched form to nothing", () => {
		expect(
			compactAcpAgentSettings({
				command: "  ",
				args: [],
				env: {},
				allowedModels: [" "],
				autoCompact: null,
				autoCompactTokens: 0,
			})
		).toEqual({});
	});

	it("keeps meaningful values, including an explicit auto-compact off", () => {
		expect(
			compactAcpAgentSettings({
				command: " /usr/local/bin/claude-agent-acp ",
				autoCompact: false,
				autoCompactTokens: 400_000,
				allowedModels: ["sonnet", ""],
				defaultConfigOptions: { effort: "high", blank: "" },
			})
		).toEqual({
			command: "/usr/local/bin/claude-agent-acp",
			autoCompact: false,
			autoCompactTokens: 400_000,
			allowedModels: ["sonnet"],
			defaultConfigOptions: { effort: "high" },
		});
	});

	it("parses one argument per line and NAME=value environment lines", () => {
		expect(parseArgsText("--flag\nvalue with spaces\n")).toEqual([
			"--flag",
			"value with spaces",
		]);
		const env = parseEnvText("FOO=bar=baz\n=x\n1BAD=y\nnot a pair\nEMPTY=");
		expect(env).toEqual({ FOO: "bar=baz", EMPTY: "" });
		expect(formatEnvText(env)).toBe("FOO=bar=baz\nEMPTY=");
	});
});
