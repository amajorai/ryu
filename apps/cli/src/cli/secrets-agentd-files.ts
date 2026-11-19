// File writes for `ryu secrets agent`: token sinks and rendered templates.
//
// A write goes to a temp file created next to the destination (so the rename
// stays on one filesystem) with the final mode at open time and `wx`, then
// renames over the destination. A reader sees the old file or the new one,
// never a partial one, and never a window where the file is readable by
// others. Windows ignores the POSIX mode; the file keeps the directory's ACL.

import { randomBytes } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

function isMissing(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

/** The file's current text, or null when it does not exist. */
export async function readIfPresent(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (isMissing(error)) {
			return null;
		}
		throw error;
	}
}

/** Write `content` to `path` atomically with `mode`. */
export async function writeAtomic(
	path: string,
	content: string,
	mode: number
): Promise<void> {
	const temp = join(
		dirname(path),
		`.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`
	);
	const handle = await open(temp, "wx", mode);
	try {
		await handle.writeFile(content, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await rename(temp, path);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

/** Write only when the content differs from what is on disk. Resolves true
 *  when the file changed, so the caller runs its command only then. */
export async function writeIfChanged(
	path: string,
	content: string,
	mode: number
): Promise<boolean> {
	if ((await readIfPresent(path)) === content) {
		return false;
	}
	await writeAtomic(path, content, mode);
	return true;
}

/** A credential file's content without surrounding whitespace. */
export async function readCredentialFile(path: string): Promise<string> {
	return (await readFile(path, "utf8")).trim();
}
