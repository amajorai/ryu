// `ryu migrate …` — move an existing agent setup into Ryu in one command.
//
// The command is a thin, scriptable front end over Core's setup importer
// (`POST /api/import/scan` → `POST /api/import/run`). Core owns detection,
// parsing, and every write; this file only resolves where the source lives,
// prints the plan, asks for confirmation, and reports outcomes. Re-running is
// safe: Core dedupes agents by name, memories by content hash, and MCP servers
// and skills by name.
//
// Credentials are never part of a scan. `--secrets` is the one explicit,
// opt-in path: it reads credential-looking keys from the source's `.env` on
// this machine and imports them into the Secret Vault without printing values.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { importVaultSecrets } from "@ryuhq/core-client/vault";
import { tf } from "../i18n/translate.ts";
import { parseMigrateArgs } from "./migrate-args.ts";
import {
	CORE_SOURCE_IDS,
	ITEM_KINDS,
	type ItemKind,
	itemKindSchema,
	KIND_LABELS,
	type Outcome,
	runSchema,
	type Scan,
	type ScanItem,
	SOURCES,
	type SourceId,
	scanSchema,
	sourceIdSchema,
} from "./migrate-sources.ts";
import { type CliContext, type Command, UsageError } from "./types.ts";

export { type MigrateArgs, parseMigrateArgs } from "./migrate-args.ts";

/** Turn a Core error into "not found" (try the next default) vs a real error. */
function isMissingFolder(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /cannot resolve folder|not a directory|No such file/i.test(message);
}

async function scanFolder(ctx: CliContext, path: string): Promise<Scan> {
	if (!ctx.api.call) {
		throw new Error("This command requires the live Core client.");
	}
	return scanSchema.parse(
		await ctx.api.call(ctx.target, "/api/import/scan", {
			method: "POST",
			body: { path },
		})
	);
}

async function runImport(
	ctx: CliContext,
	root: string,
	items: ScanItem[]
): Promise<Outcome[]> {
	if (!ctx.api.call) {
		throw new Error("This command requires the live Core client.");
	}
	const reply = runSchema.parse(
		await ctx.api.call(ctx.target, "/api/import/run", {
			method: "POST",
			body: {
				path: root,
				items: items.map(({ kind, id }) => ({ kind, id })),
			},
		})
	);
	return reply.results;
}

/** Scan the first candidate folder that exists on the node. */
async function scanFirst(
	ctx: CliContext,
	candidates: readonly string[]
): Promise<Scan | null> {
	for (const candidate of candidates) {
		try {
			return await scanFolder(ctx, candidate);
		} catch (error) {
			if (!isMissingFolder(error)) {
				throw error;
			}
		}
	}
	return null;
}

function candidatesFor(source: SourceId, path: string | null): string[] {
	if (path) {
		return [path === "." ? process.cwd() : path];
	}
	return SOURCES[source].defaults.map((p) => (p === "." ? process.cwd() : p));
}

/** The CLI source id for a source Core reported (`claude-ai` → `claude`). */
function cliSourceId(coreId: string | null | undefined): SourceId | null {
	for (const [cli, core] of CORE_SOURCE_IDS) {
		if (core === coreId && cli !== "dots") {
			return cli;
		}
	}
	const parsed = sourceIdSchema.safeParse(coreId);
	return parsed.success ? parsed.data : null;
}

function sourceLabel(id: string | null | undefined): string {
	const source = cliSourceId(id);
	if (source) {
		return SOURCES[source].label;
	}
	return id === "persona" ? "a persona folder" : "a local folder";
}

function isItemKind(kind: string): kind is ItemKind {
	return itemKindSchema.safeParse(kind).success;
}

function renderPlan(scan: Scan, selected: ScanItem[]): string {
	const lines = [`Found ${sourceLabel(scan.source)} setup at ${scan.root}`, ""];
	const selectedIds = new Set(
		selected.map((item) => `${item.kind}:${item.id}`)
	);
	for (const kind of ITEM_KINDS) {
		const items = scan.items.filter((item) => item.kind === kind);
		if (items.length === 0) {
			continue;
		}
		lines.push(`${KIND_LABELS[kind]} (${items.length})`);
		for (const item of items) {
			const marker = selectedIds.has(`${item.kind}:${item.id}`)
				? "+"
				: item.already_exists
					? "="
					: "-";
			const note = item.already_exists ? "  (already in Ryu)" : "";
			lines.push(`  ${marker} ${item.title}${note}`);
		}
	}
	if (scan.items.length === 0) {
		lines.push("Nothing importable was found.");
	}
	if (scan.warnings.length > 0) {
		lines.push("", "Review before cutover:");
		for (const warning of scan.warnings) {
			lines.push(`  ! ${warning}`);
		}
	}
	return `${lines.join("\n")}\n`;
}

function renderReport(outcomes: Outcome[]): string {
	const count = (status: string) =>
		outcomes.filter((outcome) => outcome.status === status).length;
	const lines = [
		`Migration complete: ${count("imported")} imported, ${count("skipped")} skipped, ${count("failed")} failed.`,
	];
	for (const outcome of outcomes) {
		if (outcome.status === "imported" && !outcome.detail) {
			continue;
		}
		lines.push(
			`  ${outcome.status.padEnd(8)} ${outcome.title}${outcome.detail ? ` — ${outcome.detail}` : ""}`
		);
	}
	return `${lines.join("\n")}\n`;
}

const NEXT_STEPS = `Next steps:
  1. Start a new chat; imported agents, skills, and memory apply to new sessions.
  2. Review imported MCP servers in Settings → MCP; sign in again where they use OAuth or headers.
  3. Reconnect messaging channels and schedules listed under "Review before cutover".
  4. Keep the source folder until you have checked Ryu; migration copies, it never moves.
`;

async function confirm(ctx: CliContext, question: string): Promise<boolean> {
	if (!(process.stdin.isTTY && process.stdout.isTTY)) {
		throw new UsageError(
			"Pass --yes to import without a prompt, or --dry-run to preview."
		);
	}
	const { createInterface } = await import("node:readline/promises");
	const readline = createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	try {
		const answer = await readline.question(`${question} [y/N] `);
		return /^y(es)?$/i.test(answer.trim());
	} catch {
		ctx.io.err("Cancelled.\n");
		return false;
	} finally {
		readline.close();
	}
}

/** Credential-looking `KEY=value` lines of a dotenv file, as dotenv text. */
export function credentialDotenv(raw: string): {
	content: string;
	names: string[];
} {
	const lines: string[] = [];
	const names: string[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim().replace(/^export\s+/, "");
		const match = /^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
		if (!match) {
			continue;
		}
		const [, key = "", value = ""] = match;
		const bare = value.trim().replace(/^["']|["']$/g, "");
		if (!(bare && /_(KEY|TOKEN|SECRET|PASSWORD)$/.test(key))) {
			continue;
		}
		if (!names.includes(key)) {
			names.push(key);
			lines.push(`${key}=${value.trim()}`);
		}
	}
	return { content: lines.length > 0 ? `${lines.join("\n")}\n` : "", names };
}

/** What `--secrets` did, for the text report or the `--json` result. */
interface SecretsResult {
	created: number;
	message: string;
	names: string[];
	skipped: number;
}

async function migrateSecrets(
	ctx: CliContext,
	root: string
): Promise<SecretsResult> {
	let raw: string;
	try {
		raw = await readFile(join(root, ".env"), "utf8");
	} catch {
		return {
			created: 0,
			message: tf(
				"No readable {path} on this machine; add credentials with `ryu secrets set` instead.",
				{ path: join(root, ".env") }
			),
			names: [],
			skipped: 0,
		};
	}
	const { content, names } = credentialDotenv(raw);
	if (names.length === 0) {
		return {
			created: 0,
			message: "No credentials found in the source .env.",
			names,
			skipped: 0,
		};
	}
	const { report } = await importVaultSecrets(ctx.target, {
		scope: "user",
		format: "dotenv",
		content,
		onConflict: "skip",
	});
	return {
		created: report.created,
		message: tf(
			"Secret Vault: {created} created, {skipped} skipped ({names}). Values were not printed.",
			{
				created: String(report.created),
				skipped: String(report.skipped),
				names: names.join(", "),
			}
		),
		names,
		skipped: report.skipped,
	};
}

/** `ryu migrate` with no source: list what this node has to migrate. */
async function detectAll(ctx: CliContext): Promise<number> {
	const found: { command: string; scan: Scan }[] = [];
	for (const source of ["openclaw", "hermes"] as const) {
		const scan = await scanFirst(ctx, SOURCES[source].defaults);
		if (scan && scan.items.length > 0) {
			found.push({ command: `ryu migrate ${source}`, scan });
		}
	}
	const project = await scanFirst(ctx, [process.cwd()]);
	const projectSource =
		project?.source === "persona" ? "dots" : cliSourceId(project?.source);
	if (
		project &&
		projectSource &&
		projectSource !== "openclaw" &&
		projectSource !== "hermes"
	) {
		found.push({
			command: `ryu migrate ${projectSource} ${project.root}`,
			scan: project,
		});
	}
	if (ctx.flags.json) {
		ctx.io.out(
			`${JSON.stringify(
				found.map(({ command, scan }) => ({
					command,
					root: scan.root,
					source: scan.source ?? null,
					items: scan.items.length,
				})),
				null,
				2
			)}\n`
		);
		return 0;
	}
	if (found.length === 0) {
		ctx.io.out(
			`${tf("No OpenClaw or Hermes home, and no Mastra or LangChain project in {cwd}.", { cwd: process.cwd() })}\n${MIGRATE_USAGE}\n`
		);
		return 0;
	}
	ctx.io.out("Found setups you can migrate:\n");
	for (const { command, scan } of found) {
		ctx.io.out(
			`  ${tf("{label} {root} ({count} items)\n    → {command} --dry-run", { label: sourceLabel(scan.source).padEnd(10), root: scan.root, count: String(scan.items.length), command })}\n`
		);
	}
	return 0;
}

const MIGRATE_USAGE =
	"ryu migrate [chatgpt|claude|openclaw|hermes|muse|mastra|langchain|dots] [path] [--dry-run] [--yes] [--only kinds] [--secrets] [--json]";

export const migrateCommand: Command = {
	name: "migrate",
	summary:
		"Migrate chats, projects, agents, memory, skills, and MCP servers from ChatGPT, Claude, OpenClaw, Hermes, Muse, Mastra, LangChain, or Dots",
	usage: MIGRATE_USAGE,
	run: async (ctx) => {
		const args = parseMigrateArgs(ctx.rawArgs);
		if (!(args.source || args.path)) {
			return detectAll(ctx);
		}
		const spec = args.source ? SOURCES[args.source] : null;
		if (spec && "needsPath" in spec && !args.path) {
			throw new UsageError(`${spec.needsPath}\nUsage: ${MIGRATE_USAGE}`);
		}
		const candidates = args.source
			? candidatesFor(args.source, args.path)
			: [args.path ?? process.cwd()];
		const scan = await scanFirst(ctx, candidates);
		if (!scan) {
			throw new Error(
				`No ${spec?.label ?? "source"} folder found at ${candidates.join(", ")}. Pass the folder: ryu migrate ${args.source ?? ""} <path>`
			);
		}
		const wanted = args.source
			? (CORE_SOURCE_IDS.get(args.source) ?? args.source)
			: null;
		if (wanted && scan.source && scan.source !== wanted) {
			ctx.io.err(
				`${tf("Note: {root} looks like {found}, not {wanted}; importing what was found.", { root: scan.root, found: sourceLabel(scan.source), wanted: sourceLabel(wanted) })}\n`
			);
		}
		const selected = scan.items.filter(
			(item) =>
				!item.already_exists &&
				isItemKind(item.kind) &&
				(args.only === null || args.only.includes(item.kind))
		);
		if (ctx.flags.json && (ctx.flags.dryRun || !args.yes)) {
			ctx.io.out(
				`${JSON.stringify({ ...scan, selected, dryRun: true }, null, 2)}\n`
			);
			return 0;
		}
		if (!ctx.flags.json) {
			ctx.io.out(renderPlan(scan, selected));
		}
		if (ctx.flags.dryRun) {
			ctx.io.out(
				`\n${tf("Dry run: {count} item(s) would be imported. Nothing was changed.", { count: String(selected.length) })}\n`
			);
			return 0;
		}
		if (selected.length === 0 && !args.secrets) {
			ctx.io.out(
				ctx.flags.json
					? `${JSON.stringify({ root: scan.root, source: scan.source ?? null, results: [] }, null, 2)}\n`
					: "\nNothing new to import.\n"
			);
			return 0;
		}
		if (
			!(
				args.yes ||
				(await confirm(
					ctx,
					`\n${
						args.secrets
							? tf(
									"Import {count} item(s) and move credentials into the Secret Vault?",
									{ count: String(selected.length) }
								)
							: tf("Import {count} item(s)?", {
									count: String(selected.length),
								})
					}`
				))
			)
		) {
			ctx.io.out("Nothing was changed.\n");
			return 1;
		}
		const outcomes =
			selected.length > 0 ? await runImport(ctx, scan.root, selected) : [];
		const failed = outcomes.some((outcome) => outcome.status === "failed");
		if (!ctx.flags.json) {
			ctx.io.out(`\n${renderReport(outcomes)}`);
			if (args.secrets) {
				ctx.io.out(`${(await migrateSecrets(ctx, scan.root)).message}\n`);
			}
			ctx.io.out(`\n${NEXT_STEPS}`);
			return failed ? 1 : 0;
		}
		// One JSON document on stdout: the secrets report joins the results.
		let secrets: SecretsResult | { error: string } | undefined;
		if (args.secrets) {
			try {
				secrets = await migrateSecrets(ctx, scan.root);
			} catch (error) {
				secrets = {
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}
		ctx.io.out(
			`${JSON.stringify({ root: scan.root, source: scan.source ?? null, results: outcomes, ...(secrets ? { secrets } : {}) }, null, 2)}\n`
		);
		return failed || (secrets && "error" in secrets) ? 1 : 0;
	},
};
