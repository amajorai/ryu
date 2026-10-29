import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

/** Directory names never offered by `@path` completion. */
const SKIPPED_ENTRIES = new Set([".git", "node_modules"]);

/** Default cap so one huge directory never floods the completion list. */
export const FILE_MENTION_LIMIT = 200;

/**
 * List the entries of the directory named by an `@path` query, relative to
 * `cwd`. Listing is one level deep (never recursive): `src/co` lists `./src`
 * and keeps names starting with `co`, prefix matches before substring matches.
 * Directories carry a trailing `/` so completing one keeps the token open.
 * Dot entries appear only when the typed segment starts with `.`; `.git` and
 * `node_modules` never appear. Within a match tier, directories sort before
 * files. An unreadable directory yields no entries.
 */
export async function searchFiles(
	cwd: string,
	query: string,
	limit: number = FILE_MENTION_LIMIT
): Promise<string[]> {
	const slash = query.lastIndexOf("/");
	const directory = query.slice(0, slash + 1);
	const segment = query.slice(slash + 1).toLowerCase();
	let entries: Dirent[];
	try {
		entries = await readdir(resolve(cwd, directory || "."), {
			withFileTypes: true,
		});
	} catch {
		return [];
	}
	const showHidden = segment.startsWith(".");
	const ranked: { directory: boolean; path: string; rank: number }[] = [];
	for (const entry of entries) {
		const name = entry.name;
		if (SKIPPED_ENTRIES.has(name) || (name.startsWith(".") && !showHidden)) {
			continue;
		}
		const key = name.toLowerCase();
		const rank = key.startsWith(segment) ? 0 : key.includes(segment) ? 1 : -1;
		if (rank < 0) {
			continue;
		}
		const isDirectory = entry.isDirectory();
		ranked.push({
			directory: isDirectory,
			path: `${directory}${name}${isDirectory ? "/" : ""}`,
			rank,
		});
	}
	return ranked
		.sort(
			(left, right) =>
				left.rank - right.rank ||
				Number(right.directory) - Number(left.directory) ||
				left.path.localeCompare(right.path)
		)
		.slice(0, limit)
		.map(({ path }) => path);
}
