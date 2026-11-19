// `.ryu-vault.json`: the per-project defaults for `ryu secrets …`.
//
// `ryu secrets init` writes the file in the current directory. Value commands
// then look for it from the working directory up to the filesystem root and
// take their environment, folder, and tag filter from the nearest one unless a
// flag sets them, and say so on stderr. `export` and `run` also take the
// organization project (`orgProject`) whose values they include. Removals (`delete`, `destroy`) never
// take their target from the file: they need the flags. The file names coordinates only, never a value, so it is
// meant to be committed. `--no-project` ignores it for one invocation.
// The file may also live at `.ryu/vault.json` (`init --out .ryu/vault.json`).
// Its optional `broker` block names the services `run` brokers by default and
// extra placeholder variables; `run --no-broker` passes values instead.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { listVaultEnvironments } from "@ryuhq/core-client/vault";
import { z } from "zod";
import { tf } from "../i18n/translate.ts";
import { flag, type SecretsArgs } from "./secrets-args.ts";
import { printJson } from "./secrets-output.ts";
import { type CliContext, UsageError } from "./types.ts";

export const PROJECT_FILE = ".ryu-vault.json";
/** The same file inside a project's `.ryu/` directory. */
export const PROJECT_DIR_FILE = join(".ryu", "vault.json");
/** Names looked for in each directory, in order. */
export const PROJECT_FILES = [PROJECT_FILE, PROJECT_DIR_FILE];
export const NO_PROJECT_FLAG = "--no-project";

const brokerSchema = z.strictObject({
	/** Services `run` brokers by default (`--no-broker` opts out). */
	services: z
		.array(
			z
				.string()
				.trim()
				.min(1)
				.regex(/^[^,\s]+$/u)
		)
		.min(1),
	/** Extra variables a broker run sets to the dummy `__ryu_broker__`. */
	placeholders: z
		.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u))
		.optional(),
});

const projectSchema = z.strictObject({
	version: z.literal(1),
	environment: z.string().trim().min(1).optional(),
	path: z.string().startsWith("/").optional(),
	tags: z.array(z.string().trim().min(1)).optional(),
	/** Control-plane project whose values `export`/`run` include. */
	orgProject: z.string().trim().min(1).max(256).regex(/^\S+$/u).optional(),
	broker: brokerSchema.optional(),
});

export type VaultProject = z.infer<typeof projectSchema>;

export interface FoundProject {
	config: VaultProject;
	file: string;
}

/** Subcommands that read or write values at an environment and folder, and so
 *  take their defaults from the project file. */
const COORDINATE_SUBCOMMANDS = new Set([
	"delete",
	"destroy",
	"example-env",
	"export",
	"get",
	"import",
	"list",
	"ls",
	"restore",
	"rm",
	"rollback",
	"run",
	"set",
	"snapshot",
	"versions",
]);

/** Subcommands whose value selection a project's tag filter narrows. */
const TAG_SUBCOMMANDS = new Set(["example-env", "export", "run"]);

function isMissing(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

/** Parse one project file's text, naming the file in the error. */
export function parseProject(text: string, file: string): VaultProject {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new UsageError(tf("{file} is not valid JSON.", { file }));
	}
	const parsed = projectSchema.safeParse(raw);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		throw new UsageError(
			tf("{file} is not a valid vault project file: {detail}", {
				file,
				detail: `${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}`,
			})
		);
	}
	return parsed.data;
}

/** The nearest `.ryu-vault.json` or `.ryu/vault.json` from `start` up to the
 *  filesystem root. Both in one directory is ambiguous and refused. */
export async function findProject(start: string): Promise<FoundProject | null> {
	let directory = start;
	while (true) {
		const found: FoundProject[] = [];
		for (const name of PROJECT_FILES) {
			const file = join(directory, name);
			try {
				const text = await readFile(file, "utf8");
				found.push({ config: parseProject(text, file), file });
			} catch (error) {
				if (!isMissing(error)) {
					throw error;
				}
			}
		}
		if (found.length > 1) {
			throw new UsageError(
				tf("Both {first} and {second} exist. Keep one of them.", {
					first: found[0]?.file ?? "",
					second: found[1]?.file ?? "",
				})
			);
		}
		if (found[0]) {
			return found[0];
		}
		const parent = dirname(directory);
		if (parent === directory) {
			return null;
		}
		directory = parent;
	}
}

function workingDirectory(ctx: CliContext): string {
	return ctx.cwd ?? process.cwd();
}

/** Subcommands that remove values: a project file never picks their target.
 *  The file is meant to be committed, so one planted in a clone or a shared
 *  parent directory must not silently retarget a removal. */
const DESTRUCTIVE_SUBCOMMANDS = new Set(["delete", "destroy", "rm"]);

/** The coordinates `config` would supply where no flag sets them. */
function suppliedCoordinates(
	config: VaultProject,
	args: SecretsArgs
): { environment?: string; path?: string } {
	return {
		environment:
			config.environment && !args.values.has("--env")
				? config.environment
				: undefined,
		path: config.path && !args.values.has("--path") ? config.path : undefined,
	};
}

/** Fill `--env`, `--path`, and `--tags` from the project file where no flag
 *  set them, naming the file on stderr when it changed the target. Returns
 *  the file used, or null. */
export async function applyProjectDefaults(
	ctx: CliContext,
	args: SecretsArgs
): Promise<string | null> {
	const subcommand = args.positional[0] ?? "";
	if (
		args.booleans.has(NO_PROJECT_FLAG) ||
		!COORDINATE_SUBCOMMANDS.has(subcommand)
	) {
		return null;
	}
	const found = await findProject(workingDirectory(ctx));
	if (!found) {
		return null;
	}
	const { config, file } = found;
	const { environment, path } = suppliedCoordinates(config, args);
	if (DESTRUCTIVE_SUBCOMMANDS.has(subcommand) && (environment || path)) {
		const flags = [
			environment ? `--env ${environment}` : "",
			path ? `--path ${path}` : "",
		].filter(Boolean);
		throw new UsageError(
			tf(
				"'{subcommand}' does not take its target from {file}. Pass {flags} to confirm it, or --no-project to ignore the file.",
				{ subcommand, file, flags: flags.join(" ") }
			)
		);
	}
	if (environment) {
		args.values.set("--env", [environment]);
	}
	if (path) {
		args.values.set("--path", [path]);
	}
	if (environment || path) {
		ctx.io.err(
			`${tf(
				"ryu: using environment {environment}, folder {path} from {file}.",
				{
					environment: flag(args, "--env") ?? "-",
					path: flag(args, "--path") ?? "/",
					file,
				}
			)}\n`
		);
	}
	if (
		config.tags &&
		config.tags.length > 0 &&
		TAG_SUBCOMMANDS.has(subcommand) &&
		!args.values.has("--tags")
	) {
		args.values.set("--tags", [config.tags.join(",")]);
	}
	if (
		config.orgProject &&
		TAG_SUBCOMMANDS.has(subcommand) &&
		!args.values.has("--org-project")
	) {
		args.values.set("--org-project", [config.orgProject]);
		ctx.io.err(
			`${tf("ryu: including organization project {project} from {file}.", {
				project: config.orgProject,
				file,
			})}\n`
		);
	}
	if (subcommand === "run") {
		applyBrokerDefaults(ctx, args, config, file);
	}
	return file;
}

/** A project's `broker` block makes `run` broker its services unless the
 *  invocation picks its own (`--broker`), asks for values (`--no-broker`), or
 *  takes a dynamic credential (`--lease`, which needs a value run). */
function applyBrokerDefaults(
	ctx: CliContext,
	args: SecretsArgs,
	config: VaultProject,
	file: string
): void {
	const broker = config.broker;
	if (!broker || args.booleans.has("--no-broker")) {
		return;
	}
	if (!(args.values.has("--broker") || args.values.has("--lease"))) {
		args.values.set("--broker", [broker.services.join(",")]);
		ctx.io.err(
			`${tf("ryu: brokering {services} from {file} (--no-broker to pass values instead).", { services: broker.services.join(", "), file })}\n`
		);
	}
	if (
		broker.placeholders?.length &&
		args.values.has("--broker") &&
		!args.values.has("--placeholder")
	) {
		args.values.set("--placeholder", [broker.placeholders.join(",")]);
	}
}

/** A comma-separated, repeatable flag as a de-duplicated list. */
function listFlag(args: SecretsArgs, name: string): string[] {
	const values = (args.values.get(name) ?? []).flatMap((value) =>
		value
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean)
	);
	return [...new Set(values)];
}

/** `init --out` - the project file name, `.ryu-vault.json` by default. */
function projectFileName(out: string | undefined): string {
	if (out === undefined || out === PROJECT_FILE) {
		return PROJECT_FILE;
	}
	if (out.replaceAll("\\", "/") === ".ryu/vault.json") {
		return PROJECT_DIR_FILE;
	}
	throw new UsageError(
		tf("--out must be {file} or {dirFile}.", {
			file: PROJECT_FILE,
			dirFile: ".ryu/vault.json",
		})
	);
}

/** `--tags a,b` (repeatable) as a de-duplicated list. */
export function tagFilter(args: SecretsArgs): string[] {
	const tags = (args.values.get("--tags") ?? []).flatMap((value) =>
		value
			.split(",")
			.map((tag) => tag.trim())
			.filter(Boolean)
	);
	return [...new Set(tags)];
}

/** `ryu secrets init --env E [--path P] [--tags a,b] [--org-project ID]
 *  [--broker S,…] [--placeholder V,…] [--out .ryu/vault.json]` - write the project file in the working directory after checking the
 *  environment exists. */
export async function init(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const environment = flag(args, "--env");
	if (!environment) {
		throw new UsageError(
			"Usage: ryu-cli secrets init --env ENV [--path /folder] [--tags a,b] [--org-project ID] [--broker SVC,…] [--placeholder VAR,…] [--out .ryu/vault.json]"
		);
	}
	const config: VaultProject = { version: 1, environment };
	const path = flag(args, "--path");
	if (path !== undefined) {
		config.path = path;
	}
	const tags = tagFilter(args);
	if (tags.length > 0) {
		config.tags = tags;
	}
	const orgProject = flag(args, "--org-project");
	if (orgProject !== undefined) {
		config.orgProject = orgProject;
	}
	const services = listFlag(args, "--broker");
	const placeholders = listFlag(args, "--placeholder");
	if (services.length > 0) {
		config.broker = { services };
		if (placeholders.length > 0) {
			config.broker.placeholders = placeholders;
		}
	} else if (placeholders.length > 0) {
		throw new UsageError("--placeholder needs --broker.");
	}
	const name = projectFileName(flag(args, "--out"));
	const file = join(workingDirectory(ctx), name);
	parseProject(JSON.stringify(config), file);
	const { environments } = await listVaultEnvironments(ctx.target);
	if (!environments.some((entry) => entry.slug === environment)) {
		throw new UsageError(
			tf(
				"No environment '{environment}' on this node. Create it with 'ryu-cli secrets env set {environment}' or pick one of: {known}.",
				{
					environment,
					known: environments.map((entry) => entry.slug).join(", ") || "-",
				}
			)
		);
	}
	if (name === PROJECT_DIR_FILE) {
		await mkdir(dirname(file), { recursive: true });
	}
	try {
		await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, {
			flag: ctx.flags.force ? "w" : "wx",
		});
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "EEXIST") {
			throw new UsageError(
				tf("{file} already exists. Pass --force to replace it.", { file })
			);
		}
		throw error;
	}
	if (ctx.flags.json) {
		printJson(ctx, { file, project: config });
	} else {
		ctx.io.out(
			`${tf("Wrote {file}. Commands under this directory now use environment {environment}.", { file, environment })}\n`
		);
	}
	return 0;
}
