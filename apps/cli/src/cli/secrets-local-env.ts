// Local `.env` layering for `ryu secrets run` (without `--broker`).
//
// Opt-in only, so an existing `run` never picks up a file by surprise:
//
// * `--dotenv` reads `.env`, then `.env.local`, from the working directory
//   (each only if present);
// * `--env-file FILE` (repeatable) reads FILE, which must exist, after them.
//
// Later files win over earlier ones. By default the vault wins: the files only
// fill in names the vault does not set, so a stale local file can never stand
// in for a rotated value. `--dotenv-override` makes the files win instead,
// for pointing one variable at a local service. Either way `--lease`
// credentials are added last and refuse to replace any name already set.
//
// Precedence, lowest first:
//   default:            runtime allowlist < .env < .env.local < --env-file… < vault < --lease
//   --dotenv-override:  runtime allowlist < vault < .env < .env.local < --env-file… < --lease
//
// Parse errors name the file and line, never a value.

import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tf } from "../i18n/translate.ts";
import type { SecretsArgs } from "./secrets-args.ts";
import { type CliContext, UsageError } from "./types.ts";

export const DOTENV_FLAG = "--dotenv";
export const ENV_FILE_FLAG = "--env-file";
export const DOTENV_OVERRIDE_FLAG = "--dotenv-override";

/** The files `--dotenv` reads, lowest precedence first. */
export const DEFAULT_DOTENV_FILES = [".env", ".env.local"];

const KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const ESCAPES = new Map([
	["n", "\n"],
	["r", "\r"],
	["t", "\t"],
	['"', '"'],
	["\\", "\\"],
]);

/** Whether `args` asks for any local layering. */
export function wantsLocalEnv(args: SecretsArgs): boolean {
	return args.booleans.has(DOTENV_FLAG) || args.values.has(ENV_FILE_FLAG);
}

function unescapeDouble(raw: string): string {
	return raw.replace(
		/\\(.)/g,
		(whole, char: string) => ESCAPES.get(char) ?? whole
	);
}

/** The closing quote of a value opened with `quote` at index 0, or -1. */
function closingQuote(text: string, quote: string): number {
	for (let index = 1; index < text.length; index++) {
		if (text[index] === "\\" && quote === '"') {
			index++;
			continue;
		}
		if (text[index] === quote) {
			return index;
		}
	}
	return -1;
}

function parseValue(raw: string, file: string, line: number): string {
	const value = raw.trim();
	const quote = value[0];
	if (quote === '"' || quote === "'") {
		const end = closingQuote(value, quote);
		const rest = end === -1 ? "" : value.slice(end + 1).trim();
		if (end === -1 || !(rest === "" || rest.startsWith("#"))) {
			throw new UsageError(
				tf("{file}:{line}: unterminated or malformed quoted value.", {
					file,
					line: String(line),
				})
			);
		}
		const inner = value.slice(1, end);
		return quote === '"' ? unescapeDouble(inner) : inner;
	}
	// An unquoted value ends at ` #` (an inline comment).
	const comment = value.search(/\s#/);
	return (comment === -1 ? value : value.slice(0, comment)).trim();
}

/**
 * Parse dotenv text: `KEY=value`, optional `export `, blank lines and `#`
 * comments, single quotes (literal), double quotes (`\n`, `\t`, `\"`, `\\`
 * escapes). Values are single-line. A later duplicate key wins.
 */
export function parseDotenv(
	text: string,
	file: string
): Record<string, string> {
	const out: Record<string, string> = {};
	const lines = text.replace(/^﻿/, "").split(/\r?\n/);
	for (const [index, rawLine] of lines.entries()) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) {
			continue;
		}
		const body = line.startsWith("export ") ? line.slice(7).trimStart() : line;
		const eq = body.indexOf("=");
		const key = eq === -1 ? "" : body.slice(0, eq).trim();
		if (!KEY.test(key)) {
			throw new UsageError(
				tf("{file}:{line}: expected KEY=value.", {
					file,
					line: String(index + 1),
				})
			);
		}
		out[key] = parseValue(body.slice(eq + 1), file, index + 1);
	}
	return out;
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readLayer(
	path: string,
	shown: string,
	required: boolean
): Promise<Record<string, string> | null> {
	try {
		return parseDotenv(await readFile(path, "utf8"), shown);
	} catch (error) {
		if (!required && isMissing(error)) {
			return null;
		}
		if (isMissing(error)) {
			throw new UsageError(tf("{file} does not exist.", { file: shown }));
		}
		throw error;
	}
}

/** The merged local files, later files winning, and the files that were read. */
export async function readLocalEnv(
	ctx: CliContext,
	args: SecretsArgs
): Promise<{ files: string[]; values: Record<string, string> }> {
	const cwd = ctx.cwd ?? process.cwd();
	const layers: { required: boolean; shown: string }[] = [];
	if (args.booleans.has(DOTENV_FLAG)) {
		for (const name of DEFAULT_DOTENV_FILES) {
			layers.push({ shown: name, required: false });
		}
	}
	for (const name of args.values.get(ENV_FILE_FLAG) ?? []) {
		layers.push({ shown: name, required: true });
	}
	const values: Record<string, string> = {};
	const files: string[] = [];
	for (const layer of layers) {
		const path = isAbsolute(layer.shown) ? layer.shown : join(cwd, layer.shown);
		const parsed = await readLayer(path, layer.shown, layer.required);
		if (parsed) {
			files.push(layer.shown);
			Object.assign(values, parsed);
		}
	}
	return { files, values };
}

/** Layer the local files onto the vault values with the documented precedence. */
export async function layerLocalEnv(
	ctx: CliContext,
	args: SecretsArgs,
	vault: Record<string, string>
): Promise<Record<string, string>> {
	if (!wantsLocalEnv(args)) {
		if (args.booleans.has(DOTENV_OVERRIDE_FLAG)) {
			throw new UsageError("--dotenv-override needs --dotenv or --env-file.");
		}
		return vault;
	}
	const local = await readLocalEnv(ctx, args);
	const override = args.booleans.has(DOTENV_OVERRIDE_FLAG);
	if (local.files.length > 0) {
		ctx.io.err(
			`${tf(
				override
					? "Local files {files} override vault values."
					: "Local files {files} fill in names the vault does not set.",
				{ files: local.files.join(", ") }
			)}\n`
		);
	}
	return override
		? { ...vault, ...local.values }
		: { ...local.values, ...vault };
}

/** `run --broker` hands the child only the proxy environment, so local files
 *  and sub-folder values have nowhere to go; refuse rather than drop them. */
export function refuseValueLayersWithBroker(args: SecretsArgs): void {
	if (
		wantsLocalEnv(args) ||
		args.booleans.has(DOTENV_OVERRIDE_FLAG) ||
		args.booleans.has("--recursive")
	) {
		throw new UsageError(
			"--recursive, --dotenv and --env-file apply to value runs; a --broker run (also the one an AI agent session switches to) gives the command only the broker proxy environment."
		);
	}
}
