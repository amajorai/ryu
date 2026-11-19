// `ryu-cli connect help`: usages, flags and environment names stay verbatim;
// each description renders in the CLI locale. Split from `connect.ts`.

import { CLI_TRANSLATOR, type CliTranslator } from "../i18n/translate.ts";

export const CONNECT_USAGE =
	"ryu-cli connect [status|browse [platform]|search <words>|describe <id>|request <text>|call <id>|balance]";

type HelpTranslator = Pick<CliTranslator, "tr">;

function usageRows(tr: HelpTranslator["tr"]): [string, string][] {
	return [
		["ryu-cli connect", tr("Live status: Connect URL, health, key, balance")],
		[
			"ryu-cli connect browse [platform]",
			tr(
				"Ryu's tool catalog: platforms, or one platform's endpoints with USD prices"
			),
		],
		[
			"ryu-cli connect search <words…>",
			tr(
				"Search the tools your key can call (--limit 1-25, --kind any|composio|mcp)"
			),
		],
		[
			"ryu-cli connect describe <id>",
			tr("One tool's price, verification, reliability and argument schema"),
		],
		[
			"ryu-cli connect request <text…>",
			tr("Ask for a missing tool (--toolkit, --query)"),
		],
		[
			"ryu-cli connect call <id>",
			tr(
				"Call a tool (--args '<json>', --args-file <path|->, --max-cost <micro-USD>, --idempotency-key <label>); prints the result, then one JSON line with the call id and charge on stderr"
			),
		],
		["ryu-cli connect balance", tr("What new calls can spend right now")],
		[
			"ryu-cli connect <agent>",
			tr("Add Ryu's MCP tools to a coding agent (claude-code, codex, …)"),
		],
	];
}

function environmentRows(tr: HelpTranslator["tr"]): [string, string][] {
	return [
		["RYU_CONNECT_URL", tr("Connect base URL (or --url <url>)")],
		["RYU_CONNECT_KEY", tr("Connect key, sent only to RYU_CONNECT_URL")],
		[
			"RYU_TOOL_CATALOG_URL",
			tr("Catalog base URL for 'browse' (or --catalog-url <url>)"),
		],
	];
}

/** The full `ryu-cli connect help` text. */
export function renderConnectHelp(
	translator: HelpTranslator = CLI_TRANSLATOR
): string {
	const { tr } = translator;
	const lines = [
		`ryu-cli connect: ${tr("Ryu Connect from the terminal")}`,
		"",
		tr("Usage:"),
		...usageRows(tr).map(
			([usage, description]) => `  ${usage.padEnd(35)}  ${description}`
		),
		"",
		tr("Environment:"),
		...environmentRows(tr).map(
			([name, description]) => `  ${name.padEnd(20)}  ${description}`
		),
		"",
		tr("Add --json for machine-readable output."),
	];
	return lines.join("\n");
}
