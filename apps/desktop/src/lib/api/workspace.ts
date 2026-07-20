// apps/desktop/src/lib/api/workspace.ts
//
// Typed client for Core's workspace filesystem endpoints:
//   - `GET  /api/workspace/list?path=<abs>` (the node-aware folder browser —
//     lists directories on the ACTIVE node's filesystem, which may be remote).
//   - `POST /api/workspace/new-folder` `{ name }` (the composer's "Start from
//     scratch" flow — Core creates ~/Documents/Ryu/<name> and returns its path).

import { type ApiTarget, apiUrl, makeHeaders } from "./client.ts";

export interface CreateFolderResult {
	error?: string;
	path?: string;
}

/** A single child directory returned by the node's list endpoint. */
export interface DirectoryEntry {
	name: string;
	path: string;
}

/**
 * A listing of one directory on a node's filesystem. `parent` is null at the
 * filesystem root (nothing to go "up" to); `home` is the node user's home dir,
 * offered as a quick jump-to.
 */
export interface DirectoryListing {
	entries: DirectoryEntry[];
	home: string;
	parent: string | null;
	path: string;
}

/**
 * List the directories inside `path` on the ACTIVE node's filesystem. Omitting
 * `path` lists the node's home directory. Since the node may be remote, this is
 * the node-aware replacement for the desktop-host-only native folder picker.
 * Throws with the status code on a non-2xx (404 not-a-dir, 403 unreadable) so
 * the browser can show the node's error inline.
 */
export async function listDirectory(
	target: ApiTarget,
	path?: string
): Promise<DirectoryListing> {
	const query = path ? `?path=${encodeURIComponent(path)}` : "";
	const resp = await fetch(apiUrl(target, `/api/workspace/list${query}`), {
		headers: makeHeaders(target.token),
	});
	if (!resp.ok) {
		let message = `list failed: ${resp.status}`;
		try {
			const json = (await resp.json()) as { error?: string };
			if (json.error) {
				message = json.error;
			}
		} catch {
			// Non-JSON body — keep the status-based message.
		}
		throw new Error(message);
	}
	return (await resp.json()) as DirectoryListing;
}

/**
 * Create a fresh, empty project folder under ~/Documents/Ryu/<name> via Core and
 * return its absolute path. Core owns the filesystem (the desktop's Tauri fs ACL
 * is intentionally narrow), validates the name to a single path segment, and
 * returns a 409 when the name is taken — surfaced here as `{ error }` rather than
 * a throw so the picker can show it inline.
 */
export async function createProjectFolder(
	target: ApiTarget,
	name: string
): Promise<CreateFolderResult> {
	const url = apiUrl(target, "/api/workspace/new-folder");
	try {
		const resp = await fetch(url, {
			method: "POST",
			headers: {
				...makeHeaders(target.token),
				"content-type": "application/json",
			},
			body: JSON.stringify({ name }),
		});
		const json = (await resp.json()) as CreateFolderResult;
		if (!resp.ok) {
			return { error: json.error ?? `create failed: ${resp.status}` };
		}
		return { path: json.path };
	} catch (e) {
		return { error: e instanceof Error ? e.message : "create failed" };
	}
}
