// Writing a secret or one-time result to a file the user named (`pki issue
// --key-out`, `ssh sign --out`, `ssh krl --out`, `rekey update --out`).
//
// - `checkOutParent` runs before the server is asked for anything: a missing
//   or unwritable parent directory (write and search permission) is refused
//   then, not after a certificate was issued or the shares rotated.
// - `createExclusive` creates the file with O_EXCL through an open handle and
//   sets its mode on that handle (fchmod), so no symlink is followed and the
//   umask cannot loosen or tighten it; a write or close that fails removes
//   the file it created, after checking (device and inode) that the path
//   still names that file and not one another writer swapped in.
// - `replaceExclusive` (for `--force`) writes a new exclusive file beside the
//   path and renames it over the path: the rename replaces a symlink itself,
//   and a failed write leaves the old file.

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	access,
	type FileHandle,
	lstat,
	open,
	rename,
	rm,
	stat,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tf } from "../i18n/translate.ts";
import { UsageError } from "./types.ts";

/** How a folder's permissions are checked; tests swap it to simulate a
 *  folder this process may write but not search, which root cannot see. */
export type AccessCheck = (path: string, mode: number) => Promise<void>;

/** Refuse a path whose parent directory is missing, or one this process
 *  cannot create a file in (write and search permission). */
export async function checkOutParent(
	path: string,
	shown: string,
	accessCheck: AccessCheck = access
): Promise<void> {
	const parent = dirname(path);
	const info = await stat(parent).catch(() => null);
	if (!info?.isDirectory()) {
		throw new UsageError(
			tf("The folder for {file} does not exist.", { file: shown })
		);
	}
	try {
		await accessCheck(parent, constants.W_OK | constants.X_OK);
	} catch {
		throw new UsageError(
			tf("The folder for {file} is not writable.", { file: shown })
		);
	}
}

/** How a file is opened; tests swap it to make a write or close fail. */
export type OpenFile = (
	path: string,
	flags: string,
	mode: number
) => Promise<FileHandle>;

/** Create `path` exclusively with `mode`; remove it if the write or the
 *  close fails, since a close can be where a full disk shows up. */
export async function createExclusive(
	path: string,
	data: string | Uint8Array,
	mode = 0o644,
	openFile: OpenFile = open
): Promise<void> {
	const handle = await openFile(path, "wx", mode);
	let closing = false;
	let created: { dev: number; ino: number } | null = null;
	try {
		created = await handle.stat();
		await handle.chmod(mode);
		await handle.writeFile(data);
		closing = true;
		await handle.close();
	} catch (error) {
		if (!closing) {
			await handle.close().catch(() => undefined);
		}
		// This process created the file a moment ago: a partial one goes, but
		// only while the path still names that file.
		await removeIfSame(path, created);
		throw error;
	}
}

/** Remove `path` only when it is still the file `created` describes. */
async function removeIfSame(
	path: string,
	created: { dev: number; ino: number } | null
): Promise<void> {
	if (!created) {
		return;
	}
	const now = await lstat(path).catch(() => null);
	if (now && now.dev === created.dev && now.ino === created.ino) {
		await rm(path, { force: true });
	}
}

/** Write a new exclusive file beside `path` and rename it over `path`. */
export async function replaceExclusive(
	path: string,
	data: string | Uint8Array,
	mode = 0o644
): Promise<void> {
	const staging = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	await createExclusive(staging, data, mode);
	try {
		await rename(staging, path);
	} catch (error) {
		await rm(staging, { force: true });
		throw error;
	}
}

/** Why a write failed (its error code), never the data. */
export function writeFailure(error: unknown): string {
	if (error && typeof error === "object" && "code" in error) {
		return String((error as { code: unknown }).code);
	}
	return error instanceof Error ? error.message : String(error);
}
