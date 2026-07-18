// The `ryu` subcommand registry: a flat list of {@link Command}s, each mapping to
// an existing Core endpoint via the injected {@link CoreApi}. A registry (name →
// handler) is deliberately used over a big switch so app-contributed subcommands
// can later extend it (see the extension seam in dispatch.ts).
//
// Endpoint map (all pre-existing Core lifecycle routes, wrapped by core-client):
//   list/ls           GET  /api/plugins                (fetchApps)
//   catalog/search    GET  /api/plugins/catalog        (fetchAppsCatalog)
//   add/install       POST /api/plugins/:id/install    (installApp)
//   enable            POST /api/plugins/:id/enable      (enableApp)
//   disable           POST /api/plugins/:id/disable     (disableApp)
//   uninstall/rm      POST /api/plugins/:id/uninstall   (uninstallApp)
//   chat              POST /api/chat/stream             (streamChat, SSE)
//   node ls/use       local ~/.ryu/nodes.json store     (loadNodes/setActive)
//   help / version    local

import {
	loadNodes,
	resolveActive,
	setActive,
} from "../core/nodes.ts";
import { formatTable, truncate } from "./output.ts";
import { type CliContext, type Command, UsageError } from "./types.ts";
import { VERSION } from "./version.ts";

const DESCRIPTION_WIDTH = 50;

/** Read the first positional arg or throw a usage error naming the correct form. */
function requireArg(ctx: CliContext, name: string, usage: string): string {
	const value = ctx.args[0];
	if (!value) {
		throw new UsageError(`Missing ${name}. Usage: ${usage}`);
	}
	return value;
}

/** `ryu list` / `ryu ls` — installed apps (id, name, enabled). */
const listCommand: Command = {
	name: "list",
	aliases: ["ls"],
	summary: "List installed apps",
	usage: "ryu list [--json]",
	run: async (ctx) => {
		const apps = await ctx.api.fetchApps(ctx.target);
		const installed = apps.filter((a) => a.installed || a.builtIn);
		if (ctx.flags.json) {
			ctx.io.out(`${JSON.stringify(installed, null, 2)}\n`);
			return 0;
		}
		if (installed.length === 0) {
			ctx.io.out("No apps installed.\n");
			return 0;
		}
		const rows = installed.map((a) => [a.id, a.name, a.enabled ? "yes" : "no"]);
		ctx.io.out(`${formatTable(["ID", "NAME", "ENABLED"], rows)}\n`);
		return 0;
	},
};

/** `ryu catalog` / `ryu search [q]` — installable apps from the remote registry. */
const catalogCommand: Command = {
	name: "catalog",
	aliases: ["search"],
	summary: "Browse/search installable apps",
	usage: "ryu catalog [query] [--json]",
	run: async (ctx) => {
		const entries = await ctx.api.fetchAppsCatalog(ctx.target);
		const query = ctx.args[0]?.toLowerCase();
		const matches = query
			? entries.filter(
					(e) =>
						e.id.toLowerCase().includes(query) ||
						e.name.toLowerCase().includes(query) ||
						e.tags.some((t) => t.toLowerCase().includes(query))
				)
			: entries;
		if (ctx.flags.json) {
			ctx.io.out(`${JSON.stringify(matches, null, 2)}\n`);
			return 0;
		}
		if (matches.length === 0) {
			ctx.io.out("No matching apps.\n");
			return 0;
		}
		const rows = matches.map((e) => [
			e.id,
			e.name,
			e.version,
			truncate(e.description, DESCRIPTION_WIDTH),
		]);
		ctx.io.out(
			`${formatTable(["ID", "NAME", "VERSION", "DESCRIPTION"], rows)}\n`
		);
		return 0;
	},
};

/** `ryu add <id>` / `ryu install <id>` — the shadcn-style install command. */
const addCommand: Command = {
	name: "add",
	aliases: ["install"],
	summary: "Install an app from the catalog",
	usage: "ryu add <id> [--json]",
	run: async (ctx) => {
		const id = requireArg(ctx, "app id", "ryu add <id>");
		const record = await ctx.api.installApp(ctx.target, id);
		if (ctx.flags.json) {
			ctx.io.out(`${JSON.stringify(record, null, 2)}\n`);
			return 0;
		}
		ctx.io.out(
			`Installed ${record.id}@${record.version} (disabled). Run 'ryu enable ${record.id}' to turn it on.\n`
		);
		return 0;
	},
};

/** `ryu enable <id>`. */
const enableCommand: Command = {
	name: "enable",
	summary: "Enable an installed app",
	usage: "ryu enable <id> [--json]",
	run: async (ctx) => {
		const id = requireArg(ctx, "app id", "ryu enable <id>");
		const record = await ctx.api.enableApp(ctx.target, id);
		if (ctx.flags.json) {
			ctx.io.out(`${JSON.stringify(record, null, 2)}\n`);
			return 0;
		}
		ctx.io.out(`Enabled ${record.id}.\n`);
		return 0;
	},
};

/** `ryu disable <id>` (`--cascade` to disable dependents too). */
const disableCommand: Command = {
	name: "disable",
	summary: "Disable an app",
	usage: "ryu disable <id> [--cascade] [--json]",
	run: async (ctx) => {
		const id = requireArg(ctx, "app id", "ryu disable <id>");
		const record = await ctx.api.disableApp(ctx.target, id, {
			cascade: ctx.flags.cascade,
		});
		if (ctx.flags.json) {
			ctx.io.out(`${JSON.stringify(record, null, 2)}\n`);
			return 0;
		}
		ctx.io.out(`Disabled ${record.id}.\n`);
		return 0;
	},
};

/** `ryu uninstall <id>` / `ryu rm <id>` (`--cascade` for dependents). */
const uninstallCommand: Command = {
	name: "uninstall",
	aliases: ["rm"],
	summary: "Uninstall an app",
	usage: "ryu uninstall <id> [--cascade] [--json]",
	run: async (ctx) => {
		const id = requireArg(ctx, "app id", "ryu uninstall <id>");
		const result = await ctx.api.uninstallApp(ctx.target, id, {
			cascade: ctx.flags.cascade,
		});
		if (ctx.flags.json) {
			ctx.io.out(`${JSON.stringify(result, null, 2)}\n`);
			return 0;
		}
		ctx.io.out(`Uninstalled ${result.removed}.\n`);
		if (result.notice) {
			ctx.io.out(`${result.notice}\n`);
		}
		return 0;
	},
};

/** `ryu chat "<msg>"` — one-shot chat: stream the assistant reply, then exit. */
const chatCommand: Command = {
	name: "chat",
	summary: "Send one message and print the reply",
	usage: 'ryu chat "<message>" [--json]',
	run: async (ctx) => {
		const message = ctx.args.join(" ").trim();
		if (!message) {
			throw new UsageError('Missing message. Usage: ryu chat "<message>"');
		}
		let collected = "";
		let streamError: string | null = null;
		await ctx.api.streamChat(
			ctx.target,
			[{ role: "user", content: message }],
			{},
			{
				onTextDelta: (delta) => {
					if (ctx.flags.json) {
						collected += delta;
					} else {
						ctx.io.out(delta);
					}
				},
				onError: (m) => {
					streamError = m;
				},
				onDone: () => {
					/* resolved by streamChat returning */
				},
			}
		);
		if (streamError) {
			throw new Error(streamError);
		}
		if (ctx.flags.json) {
			ctx.io.out(`${JSON.stringify({ text: collected })}\n`);
		} else {
			ctx.io.out("\n");
		}
		return 0;
	},
};

/** `ryu node ls` / `ryu node use <name|url>` — the local multi-node store. */
const nodeCommand: Command = {
	name: "node",
	summary: "List or switch the active Core node",
	usage: "ryu node <ls | use <name|url>> [--json]",
	run: async (ctx) => {
		const sub = ctx.args[0] ?? "ls";
		if (sub === "ls" || sub === "list") {
			const config = loadNodes();
			const active = resolveActive(config).name;
			if (ctx.flags.json) {
				ctx.io.out(
					`${JSON.stringify({ active, nodes: config.nodes }, null, 2)}\n`
				);
				return 0;
			}
			const rows = config.nodes.map((n) => [
				n.name === active ? "*" : "",
				n.name,
				n.url,
			]);
			ctx.io.out(`${formatTable(["", "NAME", "URL"], rows)}\n`);
			return 0;
		}
		if (sub === "use") {
			const ref = ctx.args[1];
			if (!ref) {
				throw new UsageError("Usage: ryu node use <name|url>");
			}
			const config = loadNodes();
			const match = config.nodes.find((n) => n.name === ref || n.url === ref);
			if (match) {
				setActive(match.name);
				ctx.io.out(`Active node set to ${match.name} (${match.url}).\n`);
				return 0;
			}
			// The node store keys on NAME, not arbitrary URLs — be honest about the
			// per-invocation escape hatch rather than silently inventing a node.
			const names = config.nodes.map((n) => n.name).join(", ");
			ctx.io.err(
				`No configured node named or matching '${ref}'. Configured: ${names}.\nTo target an arbitrary node for one command, use --node <url> or set RYU_CORE_URL.\n`
			);
			return 1;
		}
		throw new UsageError("Usage: ryu node <ls | use <name|url>>");
	},
};

/** `ryu version` / `ryu --version`. */
const versionCommand: Command = {
	name: "version",
	summary: "Print the ryu version",
	usage: "ryu version",
	run: async (ctx) => {
		if (ctx.flags.json) {
			ctx.io.out(`${JSON.stringify({ version: VERSION })}\n`);
		} else {
			ctx.io.out(`ryu ${VERSION}\n`);
		}
		return 0;
	},
};

/** All built-in commands, in help-display order. `help` is appended below so its
 *  handler can close over this same list. */
const BASE_COMMANDS: Command[] = [
	listCommand,
	catalogCommand,
	addCommand,
	enableCommand,
	disableCommand,
	uninstallCommand,
	chatCommand,
	nodeCommand,
	versionCommand,
];

/** Build the `ryu help` text from the registry so it never drifts from reality. */
export function renderHelp(): string {
	const lines: string[] = [
		"ryu — interactive TUI + scriptable CLI for a Ryu Core node.",
		"",
		"Usage:",
		"  ryu               Open the interactive TUI (same as 'ryu tui')",
		"  ryu <command> …   Run a one-shot command",
		"",
		"Commands:",
	];
	const all = [...BASE_COMMANDS, helpCommand];
	const appLine = "ryu <app> <cmd>";
	const width = Math.max(...all.map((c) => c.usage.length), appLine.length);
	for (const cmd of all) {
		lines.push(`  ${cmd.usage.padEnd(width)}  ${cmd.summary}`);
	}
	// App-contributed subcommands (surfaces.cli.commands) — resolved at runtime
	// against the active node; run `ryu <app>` to list what an app contributes.
	lines.push(
		`  ${appLine.padEnd(width)}  Run a command an installed app contributes`
	);
	lines.push(
		"",
		"Global flags:",
		"  --json          Machine-readable output (for agents/CI)",
		"  --node <url>    Target a specific Core node for this invocation",
		"  --force         Override a refused operation where supported",
		"  --cascade       Include dependents on disable/uninstall",
		"  -h, --help      Show this help",
		"  --version       Print the version",
		"",
		"Node targeting: RYU_CORE_URL / RYU_CORE_TOKEN (env) or --node <url>.",
	);
	return lines.join("\n");
}

/** `ryu help` / `ryu -h` / `ryu --help`. */
const helpCommand: Command = {
	name: "help",
	summary: "Show this help",
	usage: "ryu help",
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
