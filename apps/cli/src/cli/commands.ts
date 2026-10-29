import { tr } from "../i18n/translate.ts";
import {
	connectCommand as agentConnectCommand,
	disconnectCommand,
} from "./agentCommands.ts";
import { agentsCommand } from "./agents.ts";
import {
	accountCommand,
	loginCommand,
	logoutCommand,
	planCommand,
	setupCommand,
	whoamiCommand,
} from "./builtins/account.ts";
import { sessionsCommand } from "./builtins/auth.ts";
import {
	applyGatewayConfigCommand,
	appsCommand,
	configCommand,
	diffGatewayConfigCommand,
	mcpCommand,
	modelsCommand,
	okfCommand,
	skillsCommand,
	stackCommand,
	updateCommand,
} from "./builtins/catalog.ts";
import { doctorCommand } from "./builtins/doctor.ts";
import {
	addCommand,
	catalogCommand,
	disableCommand,
	enableCommand,
	initCommand,
	listCommand,
	uninstallCommand,
} from "./builtins/lifecycle.ts";
import { actionCommand, packageCommand } from "./builtins/package.ts";
import { pluginDoctorCommand } from "./builtins/pluginDoctor.ts";
import {
	observabilityCommand,
	openCommand,
	sidecarCommand,
	statusCommand,
	traceCommand,
} from "./builtins/runtime.ts";
import {
	acpCommand,
	chatCommand,
	mailCommand,
	nodeCommand,
	versionCommand,
} from "./builtins/session.ts";
import {
	connectCommand as connectToolsCommand,
	isConnectToolsInvocation,
} from "./connect.ts";
import { evalCommand, redteamCommand } from "./evalCommands.ts";
import { migrateCommand } from "./migrate.ts";
import { secretsCommand } from "./secrets.ts";
import { servicesCommand } from "./services.ts";
import { troubleshootCommand } from "./troubleshoot.ts";
import type { Command } from "./types.ts";

/** All built-in commands, in help-display order. `help` is appended below so its
 *  handler can close over this same list. */
// `connect` is one verb with two forms: `ryu-cli connect <agent>` wires Ryu's MCP
// tools into a coding agent (agentCommands.ts), and bare `ryu-cli connect` or
// `ryu-cli connect <status|browse|search|describe|request|call|balance|help>`
// talks to a Ryu Connect deployment (connect.ts). The first word routes.
const connectCommand: Command = {
	name: "connect",
	summary:
		"Add Ryu's MCP tools to a coding agent, or search and call Ryu Connect tools",
	usage:
		"ryu-cli connect <agent> | [status|browse|search|describe|request|call|balance]",
	run: (ctx) =>
		isConnectToolsInvocation(ctx.rawArgs)
			? connectToolsCommand.run(ctx)
			: agentConnectCommand.run(ctx),
};

const BASE_COMMANDS: Command[] = [
	actionCommand,
	statusCommand,
	observabilityCommand,
	traceCommand,
	evalCommand,
	redteamCommand,
	sidecarCommand("start"),
	sidecarCommand("stop"),
	sidecarCommand("restart"),
	updateCommand,
	modelsCommand,
	skillsCommand,
	appsCommand,
	mcpCommand,
	okfCommand,
	stackCommand,
	applyGatewayConfigCommand,
	diffGatewayConfigCommand,
	configCommand,
	sessionsCommand,
	whoamiCommand,
	planCommand,
	accountCommand,
	loginCommand,
	logoutCommand,
	setupCommand,
	troubleshootCommand,
	doctorCommand,
	pluginDoctorCommand,
	packageCommand,
	migrateCommand,
	openCommand,
	listCommand,
	catalogCommand,
	addCommand,
	enableCommand,
	disableCommand,
	uninstallCommand,
	initCommand,
	chatCommand,
	acpCommand,
	connectCommand,
	disconnectCommand,
	agentsCommand,
	mailCommand,
	secretsCommand,
	nodeCommand,
	versionCommand,
	servicesCommand,
];

/** Global flags as [flag, description]; the flag column is never translated. */
const GLOBAL_FLAG_ROWS: readonly (readonly [string, string])[] = [
	[
		"--agent <id>",
		tr(
			"Calling agent for 'ryu-cli action' (required); Ryu agent for 'acp' and 'connect'"
		),
	],
	["-f, --file <p>", tr("Input file for 'ryu-cli apply' and 'ryu-cli diff'")],
	["--json", tr("Machine-readable output (for agents/CI)")],
	[
		"--node <name|url>",
		tr("Target a saved node (by name or URL) or an http(s) URL"),
	],
	["--kind <k>", tr("Filter list/catalog: app | plugin | all (default: all)")],
	[
		"--template <t>",
		tr("Template for 'ryu-cli init' (passed to create-ryu-app)"),
	],
	["--force", tr("Override a refused operation where supported")],
	["--cascade", tr("Include dependents on disable/uninstall")],
	["--fix", tr("Apply safe fixes for commands that support them")],
	[
		"--dry-run",
		tr("Preview supported mutating commands without writing changes"),
	],
	[
		"--include-secrets",
		tr("Include an encrypted local secrets envelope when exporting"),
	],
	["--print", tr("Print the 'connect' config snippet instead of writing it")],
	[
		"--token-env",
		tr(
			"'connect': reference $RYU_CORE_TOKEN instead of writing the node token"
		),
	],
	["-h, --help", tr("Show this help")],
	["--version", tr("Print the version")],
];

/** Copy-pasteable invocations; commands, so never translated. */
const HELP_EXAMPLES = [
	'ryu-cli troubleshoot "Core will not start after updating"',
	"ryu-cli troubleshoot --fix",
	"ryu-cli doctor",
	"ryu-cli doctor --dry-run",
	"ryu-cli doctor --fix",
	"ryu-cli doctor --fix --dry-run --json",
	"ryu-cli doctor agents",
	"ryu-cli connect claude-code",
	"ryu-cli disconnect codex",
	"ryu-cli plugin eval <id> --json",
	"ryu-cli observability audit --agent <id>",
	"ryu-cli trace <run-id> --json",
	"ryu-cli redteam <agent-id> --json",
	"ryu-cli eval <agent-id> --dataset cases.jsonl --scorer answer_relevance --threshold 0.8",
	"ryu-cli redteam <agent-id> --max-attention 0 --junit > redteam.xml",
	"ryu-cli agents create Researcher --identity individual",
	"ryu-cli agents access <agent-id> add provider:openai platform:treg",
	"ryu-cli agents access <agent-id> pick",
	"ryu-cli secrets run --env prod -- bun run start",
	"ryu-cli secrets scan . --json",
	"ryu-cli connect search create github issue",
	'ryu-cli connect call composio.GITHUB_GET_AN_ISSUE --args \'{"owner":"o","repo":"r","issue_number":1}\'',
];

/** Help paragraphs wrap here (the English text fits the historical layout). */
const HELP_WRAP_WIDTH = 79;

/** Greedy word wrap; a translation without spaces (CJK) stays one line. */
function wrapParagraph(text: string): string[] {
	const out: string[] = [];
	let line = "";
	for (const word of text.split(" ")) {
		if (line && line.length + 1 + word.length > HELP_WRAP_WIDTH) {
			out.push(line);
			line = word;
		} else {
			line = line ? `${line} ${word}` : word;
		}
	}
	if (line) {
		out.push(line);
	}
	return out;
}

/** Build the `ryu help` text from the registry so it never drifts from reality.
 *  Prose renders in the CLI locale; usages, flags and examples stay verbatim. */
export function renderHelp(): string {
	const lines: string[] = [
		tr("ryu-cli — interactive TUI + scriptable CLI for a Ryu Core node."),
		"",
		tr("Usage:"),
		`  ryu-cli              ${tr("Open the interactive TUI (same as 'ryu-cli tui')")}`,
		`  ryu-cli <command> …  ${tr("Run a one-shot command")}`,
		"",
		tr("Commands ('ryu' below is short for the installed 'ryu-cli' binary):"),
	];
	const all = [...BASE_COMMANDS, helpCommand];
	const appLine = "ryu-cli <app> <cmd>";
	const width = Math.max(...all.map((c) => c.usage.length), appLine.length);
	for (const cmd of all) {
		lines.push(`  ${cmd.usage.padEnd(width)}  ${tr(cmd.summary)}`);
	}
	// App-contributed subcommands (surfaces.cli.commands) — resolved at runtime
	// against the active node; run `ryu <app>` to list what an app contributes.
	lines.push(
		`  ${appLine.padEnd(width)}  ${tr("Run a command an installed app/plugin contributes")}`
	);
	lines.push("", tr("Global flags:"));
	for (const [flag, description] of GLOBAL_FLAG_ROWS) {
		lines.push(`  ${flag.padEnd(14)}  ${description}`);
	}
	lines.push(
		"",
		tr("Examples:"),
		...HELP_EXAMPLES.map((example) => `  ${example}`),
		"",
		...wrapParagraph(
			tr(
				"Apps vs plugins: both install, enable, disable and uninstall by id through the same commands — an app is a plugin that also ships a full-page UI. Use --kind to browse one at a time."
			)
		),
		"",
		...wrapParagraph(
			tr(
				"Node targeting: --node <name|url>, else RYU_CORE_URL / RYU_CORE_TOKEN (env), else the active node set by 'ryu node use <name|url>'."
			)
		)
	);
	return lines.join("\n");
}

/** `ryu help` / `ryu -h` / `ryu --help`. */
const helpCommand: Command = {
	name: "help",
	summary: "Show this help",
	usage: "ryu-cli help",
	run: async (ctx) => {
		ctx.io.out(`${renderHelp()}\n`);
		return 0;
	},
};

/** The complete registry, including `help`. */
export const COMMANDS: Command[] = [...BASE_COMMANDS, helpCommand];

/** Resolve a subcommand token to its {@link Command}, honoring aliases. */
export function findCommand(name: string): Command | undefined {
	return COMMANDS.find(
		(c) => c.name === name || (c.aliases?.includes(name) ?? false)
	);
}
