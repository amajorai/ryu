// App and plugin lifecycle: list, catalog, add, enable, disable, uninstall, init.

import { tf, tr } from "../../i18n/translate.ts";
import {
	catalogEntryKind,
	installedAppKind,
	type KindFilter,
	matchesKind,
	parseKindFilter,
} from "../kind.ts";
import { LocalizedError, localize } from "../localizedText.ts";
import { formatTable, truncate } from "../output.ts";
import type { CliContext, Command } from "../types.ts";
import {
	asRecord,
	DESCRIPTION_WIDTH,
	isCommandString,
	requireArg,
} from "./shared.ts";

/** Whole sentences per filter, so a translation never assembles "No" + noun. */
function noneInstalled(filter: KindFilter): string {
	if (filter === "app") {
		return tr("No apps installed.");
	}
	if (filter === "plugin") {
		return tr("No plugins installed.");
	}
	return tr("No apps or plugins installed.");
}

function noneMatching(filter: KindFilter): string {
	if (filter === "app") {
		return tr("No matching apps.");
	}
	if (filter === "plugin") {
		return tr("No matching plugins.");
	}
	return tr("No matching apps or plugins.");
}

/** `ryu list` / `ryu ls` — installed apps and plugins (id, name, kind, enabled).
 *  `--kind` narrows to one classification; unset = both, which is the pre-flag
 *  behavior and so cannot break a script that predates it. `--json` keeps emitting
 *  the raw AppInfo records (filtered, never reshaped) — a consumer that wants the
 *  classification derives it from `runnables` exactly as the KIND column does. */
export const listCommand: Command = {
	name: "list",
	aliases: ["ls"],
	summary: "List installed apps and plugins",
	usage: "ryu-cli list [--kind app|plugin|all] [--json]",
	run: async (ctx) => {
		const filter = parseKindFilter(ctx.flags.kind);
		const apps = await ctx.api.fetchApps(ctx.target);
		const installed = apps.filter(
			(a) =>
				(a.installed || a.builtIn) && matchesKind(filter, installedAppKind(a))
		);
		if (ctx.flags.json) {
			ctx.io.out(`${JSON.stringify(installed, null, 2)}\n`);
			return 0;
		}
		if (installed.length === 0) {
			ctx.io.out(`${noneInstalled(filter)}\n`);
			return 0;
		}
		const rows = installed.map((a) => [
			a.id,
			a.name,
			installedAppKind(a),
			a.enabled ? "yes" : "no",
		]);
		ctx.io.out(`${formatTable(["ID", "NAME", "KIND", "ENABLED"], rows)}\n`);
		return 0;
	},
};

/** `ryu catalog` / `ryu search [q]` — installable apps AND plugins from the remote
 *  registry. One Core endpoint returns both, so both have always been listed here;
 *  the KIND column is what finally makes them distinguishable, and `--kind` is the
 *  narrowing a scripted caller needs. */
export const catalogCommand: Command = {
	name: "catalog",
	aliases: ["search"],
	summary: "Browse/search installable apps and plugins",
	usage: "ryu-cli catalog [query] [--kind app|plugin|all] [--json]",
	run: async (ctx) => {
		const filter = parseKindFilter(ctx.flags.kind);
		const entries = await ctx.api.fetchAppsCatalog(ctx.target);
		const query = ctx.args[0]?.toLowerCase();
		const matches = entries
			.filter((e) => matchesKind(filter, catalogEntryKind(e)))
			.filter(
				(e) =>
					!query ||
					e.id.toLowerCase().includes(query) ||
					e.name.toLowerCase().includes(query) ||
					e.tags.some((t) => {
						// Core preserves upstream JSON tag cells. Keep the original method-call
						// phase and TypeError category when a queried cell is not a string.
						if (!isCommandString(t)) {
							throw new TypeError(
								"Catalog tag must be a string to match a query"
							);
						}
						return t.toLowerCase().includes(query);
					})
			);
		if (ctx.flags.json) {
			ctx.io.out(`${JSON.stringify(matches, null, 2)}\n`);
			return 0;
		}
		if (matches.length === 0) {
			ctx.io.out(`${noneMatching(filter)}\n`);
			return 0;
		}
		const rows = matches.map((e) => [
			e.id,
			e.name,
			catalogEntryKind(e),
			e.version,
			truncate(e.description, DESCRIPTION_WIDTH),
		]);
		ctx.io.out(
			`${formatTable(["ID", "NAME", "KIND", "VERSION", "DESCRIPTION"], rows)}\n`
		);
		return 0;
	},
};

/** `ryu add <id>` / `ryu install <id>` — the shadcn-style install command. Takes
 *  the id of an app OR a plugin: `POST /api/plugins/:id/install` is the single
 *  lifecycle route for both, so there is nothing to branch on here. */
async function runLifecyclePreview(
	ctx: CliContext,
	id: string,
	action: "install" | "enable" | "disable" | "uninstall" | "update",
	options: { cascade?: boolean; force?: boolean } = {}
): Promise<number> {
	if (!ctx.api.previewAppLifecycle) {
		throw new LocalizedError(
			localize(
				"Core does not expose a dry-run planner for '{action}'. Run the live command without --dry-run only after reviewing its effects.",
				{ action }
			)
		);
	}
	const plan = await ctx.api.previewAppLifecycle(
		ctx.target,
		id,
		action,
		options
	);
	if (ctx.flags.json) {
		ctx.io.out(`${JSON.stringify(plan, null, 2)}\n`);
		return 0;
	}
	const record = asRecord(plan) ?? {};
	const list = (key: string): string[] =>
		Array.isArray(record[key])
			? record[key].filter((value): value is string => isCommandString(value))
			: [];
	const affected =
		list("wouldEnable").length > 0
			? list("wouldEnable")
			: list("wouldDisable").length > 0
				? list("wouldDisable")
				: list("installedDependencies");
	const suffix = affected.length > 0 ? `\n  ${affected.join(" → ")}` : "";
	ctx.io.out(
		`${tf("Dry run · {action} {id} (nothing changed).", { action, id })}${suffix}\n`
	);
	return 0;
}

export const addCommand: Command = {
	name: "add",
	aliases: ["install"],
	summary: "Install an app or plugin from the catalog",
	usage: "ryu-cli add <id> [--dry-run] [--json]",
	run: async (ctx) => {
		const id = requireArg(
			ctx,
			localize("app or plugin id"),
			"ryu-cli add <id>"
		);
		if (ctx.flags.dryRun) {
			return runLifecyclePreview(ctx, id, "install");
		}
		const record = await ctx.api.installApp(ctx.target, id);
		if (ctx.flags.json) {
			ctx.io.out(`${JSON.stringify(record, null, 2)}\n`);
			return 0;
		}
		ctx.io.out(
			`${tf(
				"Installed {id}@{version} (disabled). Run 'ryu-cli enable {id}' to turn it on.",
				{ id: record.id, version: record.version }
			)}\n`
		);
		return 0;
	},
};

/** `ryu enable <id>` — apps and plugins alike (one Core route for both). */
export const enableCommand: Command = {
	name: "enable",
	summary: "Enable an installed app or plugin",
	usage: "ryu-cli enable <id> [--dry-run] [--json]",
	run: async (ctx) => {
		const id = requireArg(
			ctx,
			localize("app or plugin id"),
			"ryu-cli enable <id>"
		);
		if (ctx.flags.dryRun) {
			return runLifecyclePreview(ctx, id, "enable");
		}
		const record = await ctx.api.enableApp(ctx.target, id);
		if (ctx.flags.json) {
			ctx.io.out(`${JSON.stringify(record, null, 2)}\n`);
			return 0;
		}
		ctx.io.out(`${tf("Enabled {id}.", { id: record.id })}\n`);
		return 0;
	},
};

/** `ryu disable <id>` (`--cascade` to disable dependents too). */
export const disableCommand: Command = {
	name: "disable",
	summary: "Disable an app or plugin",
	usage: "ryu-cli disable <id> [--cascade] [--dry-run] [--json]",
	run: async (ctx) => {
		const id = requireArg(
			ctx,
			localize("app or plugin id"),
			"ryu-cli disable <id>"
		);
		if (ctx.flags.dryRun) {
			return runLifecyclePreview(ctx, id, "disable", {
				cascade: ctx.flags.cascade,
				force: ctx.flags.force,
			});
		}
		const record = await ctx.api.disableApp(ctx.target, id, {
			cascade: ctx.flags.cascade,
		});
		if (ctx.flags.json) {
			ctx.io.out(`${JSON.stringify(record, null, 2)}\n`);
			return 0;
		}
		ctx.io.out(`${tf("Disabled {id}.", { id: record.id })}\n`);
		return 0;
	},
};

/** `ryu uninstall <id>` / `ryu rm <id>` (`--cascade` for dependents). */
export const uninstallCommand: Command = {
	name: "uninstall",
	aliases: ["rm"],
	summary: "Uninstall an app or plugin",
	usage: "ryu-cli uninstall <id> [--cascade] [--dry-run] [--json]",
	run: async (ctx) => {
		const id = requireArg(
			ctx,
			localize("app or plugin id"),
			"ryu-cli uninstall <id>"
		);
		if (ctx.flags.dryRun) {
			return runLifecyclePreview(ctx, id, "uninstall", {
				cascade: ctx.flags.cascade,
			});
		}
		const result = await ctx.api.uninstallApp(ctx.target, id, {
			cascade: ctx.flags.cascade,
		});
		if (ctx.flags.json) {
			ctx.io.out(`${JSON.stringify(result, null, 2)}\n`);
			return 0;
		}
		ctx.io.out(`${tf("Uninstalled {id}.", { id: result.removed })}\n`);
		if (result.notice) {
			ctx.io.out(`${result.notice}\n`);
		}
		return 0;
	},
};

/** `ryu init <name> [--template <t>]` — scaffold a new app or plugin project.
 *
 *  Templates are NOT reimplemented here. `create-ryu-app` is the source of truth
 *  for what an app/plugin skeleton looks like, and `ctx.scaffold` shells out to it
 *  exactly as a user would (`bunx create-ryu-app <name> [--template <t>]`). Two
 *  things that would look tempting are wrong: importing the package would give the
 *  tui a build-time dependency on a package it does not own AND freeze its template
 *  list into this binary; and validating `<name>`/`--template` here would duplicate
 *  the scaffolder's own gates, so a template added upstream would be rejected by a
 *  stale copy of the list. Both are deliberately left to the child, whose usage
 *  text is forwarded verbatim on failure. */
export const initCommand: Command = {
	name: "init",
	summary: "Scaffold a new app or plugin project",
	usage: "ryu-cli init <name> [--template <t>]",
	run: async (ctx) => {
		const name = requireArg(
			ctx,
			localize("project name"),
			"ryu-cli init <name>"
		);
		const template = ctx.flags.template;
		const argv = template ? [name, "--template", template] : [name];
		const result = await ctx.scaffold(argv);
		const ok = result.exitCode === 0;
		if (ctx.flags.json) {
			ctx.io.out(
				`${JSON.stringify({
					name,
					template: template ?? null,
					exitCode: result.exitCode,
					stdout: result.stdout,
					stderr: result.stderr,
				})}\n`
			);
			return ok ? 0 : 1;
		}
		// The scaffolder prints its own "created …/ next steps:" block — forward it
		// rather than paraphrasing, so `ryu init` and `bunx create-ryu-app` never
		// tell a user two different things about the project they just made.
		if (result.stdout) {
			ctx.io.out(result.stdout);
		}
		if (result.stderr) {
			ctx.io.err(result.stderr);
		}
		return ok ? 0 : 1;
	},
};
