// Raw Core passthroughs and catalog lifecycle commands (update, models, skills,
// apps, mcp, okf, stack) plus the gateway config apply/diff/config commands.

import { readFile } from "node:fs/promises";
import { tf, tr } from "../../i18n/translate.ts";
import {
	gatewayConfigDiff,
	parseGatewayConfigPatch,
	redactGatewayConfig,
} from "../gatewayConfig.ts";
import { LocalizedError, localize } from "../localizedText.ts";
import { type CliContext, type Command, UsageError } from "../types.ts";
import { type CommandJsonRecord, callCore, rawCommand } from "./shared.ts";

export const updateCommand = rawCommand(
	"update",
	"ryu-cli update",
	"Check for an available Ryu update",
	"/api/update/check",
	"GET"
);
function catalogLifecycleCommand(
	name: string,
	usage: string,
	summary: string,
	catalogPath: string,
	installPath: (id: string) => string,
	extraBody?: CommandJsonRecord
): Command {
	return {
		name,
		summary,
		usage,
		run: async (ctx) => {
			const sub = ctx.args[0] ?? "list";
			if (sub === "list") {
				const result = await ctx.api.call?.(ctx.target, catalogPath, {
					method: "GET",
				});
				ctx.io.out(
					`${ctx.flags.json ? JSON.stringify(result, null, 2) : JSON.stringify(result)}\n`
				);
				return 0;
			}
			if (sub !== "add" && sub !== "install") {
				throw new UsageError(localize("Usage: {usage}", { usage }));
			}
			const id = ctx.args[1];
			if (!id) {
				throw new UsageError(localize("Usage: {usage}", { usage }));
			}
			const result = await callCore(ctx, installPath(id), {
				method: "POST",
				body: { id, ...extraBody },
			});
			ctx.io.out(
				`${ctx.flags.json ? JSON.stringify(result, null, 2) : tf("Installed {id}.", { id })}\n`
			);
			return 0;
		},
	};
}

export const modelsCommand = catalogLifecycleCommand(
	"models",
	"ryu-cli models <list|add> [id]",
	"Browse or install models",
	"/api/models/catalog",
	() => "/api/models/catalog/install",
	{ format: "gguf" }
);
export const skillsCommand = catalogLifecycleCommand(
	"skills",
	"ryu-cli skills <list|add> [id]",
	"Browse or install skills",
	"/api/skills/catalog",
	() => "/api/skills/catalog/install"
);
export const appsCommand = catalogLifecycleCommand(
	"apps",
	"ryu-cli apps <list|add> [id]",
	"List or install apps",
	"/api/plugins",
	(id) => `/api/plugins/${encodeURIComponent(id)}/install`
);
export const mcpCommand = catalogLifecycleCommand(
	"mcp",
	"ryu-cli mcp <list|add> [id]",
	"Browse or install MCP servers",
	"/api/mcp/catalog",
	() => "/api/mcp/catalog/install"
);
export const okfCommand = rawCommand(
	"okf",
	"ryu-cli okf export <dir>",
	"Export an OKF knowledge bundle",
	"/api/okf/export",
	"POST",
	true
);
// Core serves only `GET /api/fleet/stack/export`; there is no import route, so
// any other subcommand is a usage error instead of a silent export.
const stackExportCommand = rawCommand(
	"stack",
	"ryu-cli stack export",
	"Export the fleet stack template",
	"/api/fleet/stack/export",
	"GET"
);
export const stackCommand: Command = {
	...stackExportCommand,
	run: async (ctx) => {
		const sub = ctx.args[0] ?? "export";
		if (sub !== "export" || ctx.args.length > 1) {
			throw new UsageError(
				localize("Usage: {usage}", { usage: stackExportCommand.usage })
			);
		}
		return await stackExportCommand.run(ctx);
	},
};
async function readGatewayPatch(ctx: CliContext, command: "apply" | "diff") {
	const usage = `ryu-cli ${command} -f <file> [--dry-run]`;
	const path = ctx.flags.file;
	if (!path || ctx.args.length !== 0) {
		throw new UsageError(localize("Usage: {usage}", { usage }));
	}
	let source: string;
	try {
		source = await readFile(path, "utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new LocalizedError(
			localize("Could not read gateway config file '{path}': {message}", {
				message,
				path,
			})
		);
	}
	try {
		return parseGatewayConfigPatch(source);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new UsageError(
			localize("Invalid gateway config '{path}': {message}", { message, path })
		);
	}
}

export const applyGatewayConfigCommand: Command = {
	name: "apply",
	summary: "Apply the Core-writable gateway TOML config",
	usage: "ryu-cli apply -f <file> [--dry-run]",
	run: async (ctx) => {
		const patch = await readGatewayPatch(ctx, "apply");
		if (ctx.flags.dryRun) {
			const changes = gatewayConfigDiff(patch, {});
			ctx.io.out(
				`${ctx.flags.json ? JSON.stringify({ dryRun: true, changes }, null, 2) : `${tf("Dry run · {count, plural, one {# gateway config change} other {# gateway config changes}}", { count: changes.length })}\n${changes.map((change) => `${change.path}: ${JSON.stringify(change.after)}`).join("\n")}`}\n`
			);
			return 0;
		}
		const result = await callCore(ctx, "/api/gateway/config", {
			method: "PUT",
			body: patch,
		});
		ctx.io.out(
			ctx.flags.json
				? `${JSON.stringify(redactGatewayConfig(result), null, 2)}\n`
				: `${tr("Gateway configuration applied.")}\n${JSON.stringify(redactGatewayConfig(result))}\n`
		);
		return 0;
	},
};

export const diffGatewayConfigCommand: Command = {
	name: "diff",
	summary: "Compare gateway TOML against the active Gateway",
	usage: "ryu-cli diff -f <file>",
	run: async (ctx) => {
		const patch = await readGatewayPatch(ctx, "diff");
		const current = await callCore(ctx, "/api/gateway/config", {
			method: "GET",
		});
		const changes = gatewayConfigDiff(patch, current);
		ctx.io.out(
			ctx.flags.json
				? `${JSON.stringify({ changes }, null, 2)}\n`
				: changes.length === 0
					? `${tr("Gateway config matches the file.")}\n`
					: `${changes.map((change) => `${change.path}: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`).join("\n")}\n`
		);
		return 0;
	},
};

export const configCommand: Command = {
	name: "config",
	summary: "Show the active Gateway config",
	usage: "ryu-cli config [show]",
	run: async (ctx) => {
		const action = ctx.args[0] ?? "show";
		if (action !== "show" || ctx.args.length > 1) {
			throw new UsageError("Usage: ryu-cli config [show]");
		}
		const result = await callCore(ctx, "/api/gateway/config", {
			method: "GET",
		});
		ctx.io.out(`${JSON.stringify(redactGatewayConfig(result), null, 2)}\n`);
		return 0;
	},
};
