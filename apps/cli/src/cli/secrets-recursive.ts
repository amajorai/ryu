// `--recursive` for `ryu secrets run` and `example-env`: also take values from
// the sub-folders of the selected folder.
//
// Core's export resolves one folder and its ancestors, so the CLI lists the
// environment's rows under the folder (metadata only) to find the sub-folders,
// then exports each one. Precedence:
//
// * the selected folder's own export (its values, inherited values and shared
//   values) always wins;
// * a sub-folder only fills in names nothing above has set, shallower
//   sub-folders first, siblings in path order;
// * from a sub-folder export the CLI takes only names that have a row defined
//   in exactly that sub-folder, so a value the sub-folder merely inherits can
//   never clobber a sibling's own value.
//
// A name defined in two places is reported on stderr by name and folders,
// never by value.

import {
	listVaultSecrets,
	parseVaultJsonExport,
	type VaultSecret,
} from "@ryuhq/core-client/vault";
import { tf } from "../i18n/translate.ts";
import { flag, type SecretsArgs } from "./secrets-args.ts";
import { agentTarget, exportResult } from "./secrets-output.ts";
import { type CliContext, UsageError } from "./types.ts";

export const RECURSIVE_FLAG = "--recursive";

/** `/a/b/` → `/a/b`; empty → `/`. */
export function normalizeFolder(path: string | undefined): string {
	const trimmed = (path ?? "/").trim().replace(/\/+$/, "");
	if (trimmed === "") {
		return "/";
	}
	return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function depth(path: string): number {
	return path === "/" ? 0 : path.split("/").length - 1;
}

/** Whether `path` is strictly below `root`. */
export function isBelow(path: string, root: string): boolean {
	const folder = normalizeFolder(path);
	if (folder === root) {
		return false;
	}
	return root === "/" || folder.startsWith(`${root}/`);
}

/** The sub-folders of `root` that define a live row, each with the names
 *  defined there, shallowest first and then in path order. */
export function subFolders(
	rows: VaultSecret[],
	root: string
): [string, Set<string>][] {
	const folders = new Map<string, Set<string>>();
	for (const row of rows) {
		if (row.status === "deleted" || !isBelow(row.path, root)) {
			continue;
		}
		const folder = normalizeFolder(row.path);
		const names = folders.get(folder) ?? new Set<string>();
		names.add(row.name);
		folders.set(folder, names);
	}
	return [...folders].sort(
		([a], [b]) => depth(a) - depth(b) || (a < b ? -1 : Number(a > b))
	);
}

function withPath(args: SecretsArgs, path: string): SecretsArgs {
	const values = new Map(
		[...args.values].map(([key, list]) => [key, [...list]])
	);
	values.set("--path", [path]);
	return { ...args, values };
}

/** The values `run` injects: the selected folder's export, plus with
 *  `--recursive` the sub-folders' own values under the precedence above. */
export async function exportRunValues(
	ctx: CliContext,
	args: SecretsArgs
): Promise<Record<string, string>> {
	const recursive = args.booleans.has(RECURSIVE_FLAG);
	if (recursive && agentTarget(ctx)) {
		throw new UsageError("--recursive is not supported with RYU_VAULT_TOKEN.");
	}
	const base = parseVaultJsonExport(await exportResult(ctx, args, "json"));
	if (!recursive) {
		return base;
	}
	const root = normalizeFolder(flag(args, "--path"));
	const { secrets } = await listVaultSecrets(ctx.target, {
		environment: flag(args, "--env"),
		path: root,
		recursive: true,
	});
	const merged: Record<string, string> = { ...base };
	const origin = new Map<string, string>(
		Object.keys(base).map((name) => [name, root])
	);
	for (const [folder, names] of subFolders(secrets, root)) {
		const values = parseVaultJsonExport(
			await exportResult(ctx, withPath(args, folder), "json")
		);
		for (const name of [...names].sort()) {
			const value = values[name];
			if (value === undefined) {
				// Not readable, sealed, or outside --name/--tags.
				continue;
			}
			const kept = origin.get(name);
			if (kept !== undefined) {
				ctx.io.err(
					`${tf("{name} in {folder} is ignored: {kept} already sets it.", { name, folder, kept })}\n`
				);
				continue;
			}
			merged[name] = value;
			origin.set(name, folder);
		}
	}
	return merged;
}
