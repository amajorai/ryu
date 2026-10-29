import { z } from "zod";
// apps/desktop/src/lib/api/workspace.ts
//
// Typed client for Core's workspace filesystem endpoints:
//   - `GET  /api/workspace/list?path=<abs>` (the node-aware folder browser —
//     lists directories on the ACTIVE node's filesystem, which may be remote).
//   - `POST /api/workspace/new-folder` `{ name }` (the composer's "Start from
//     scratch" flow — Core creates ~/Documents/Ryu/<name> and returns its path).
//   - `POST /api/workspace/clone` `{ url, name? }` (clone a Git repository
//     onto the ACTIVE node and return its new project path).

import { type ApiTarget, authenticatedFetch, readJsonBody } from "./client.ts";

export interface CreateFolderResult {
	error?: string;
	path?: string;
}

export interface CloneFolderResult {
	error?: string;
	name?: string;
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
	/** A friendly name for a VIRTUAL location (e.g. "This PC", the Windows drive
	    list) whose `path` is an internal sentinel, not a real folder. Present only
	    for such roots; when set, the location is a container to browse, not a
	    folder that can itself be selected. */
	label?: string;
	parent: string | null;
	path: string;
}

// Core's response publishers live in server/git.rs: create_project_folder,
// clone_project_folder, and list_directory. Validate their filesystem DTOs before
// a desktop caller can render entries or register a returned project path.
const directoryEntrySchema = z.object({ name: z.string(), path: z.string() });
const directoryListingSchema = z.object({
	entries: z.array(directoryEntrySchema),
	home: z.string(),
	label: z.string().optional(),
	parent: z.string().nullable(),
	path: z.string(),
});
const createdFolderSchema = z.object({ path: z.string() });
const clonedFolderSchema = z.object({
	success: z.literal(true).optional(),
	name: z.string(),
	path: z.string(),
});

/** Return the default folder name for an HTTPS or SSH Git clone URL. */
export function gitRepositoryName(source: string): string | null {
	const trimmed = source.trim();
	const scpMatch = /^git@[^/:]+:(.+)$/i.exec(trimmed);
	let repositoryPath: string | null = scpMatch?.[1] ?? null;

	if (repositoryPath === null) {
		try {
			const parsed = new URL(trimmed);
			if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") {
				return null;
			}
			repositoryPath = parsed.pathname;
		} catch {
			return null;
		}
	}

	const segments = repositoryPath.split("/").filter(Boolean);
	const leaf = segments.at(-1);
	if (!leaf || leaf === "." || leaf === "..") {
		return null;
	}
	const name = leaf.replace(/\.git$/i, "");
	return name && name !== "." && name !== ".." ? name : null;
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
	const resp = await authenticatedFetch(target, `/api/workspace/list${query}`);
	const { data, error } = await readJsonBody(
		resp,
		"list",
		directoryListingSchema
	);
	if (error || !data) {
		throw new Error(error ?? `list failed: ${resp.status}`);
	}
	return data;
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
	try {
		const resp = await authenticatedFetch(target, "/api/workspace/new-folder", {
			method: "POST",
			body: JSON.stringify({ name }),
		});
		const { data, error } = await readJsonBody(
			resp,
			"create",
			createdFolderSchema
		);
		if (error) {
			return { error };
		}
		return { path: data?.path };
	} catch (e) {
		return { error: e instanceof Error ? e.message : "create failed" };
	}
}

/** Clone a Git repository onto the active node and return its project path. */
export async function cloneProjectFolder(
	target: ApiTarget,
	url: string,
	name?: string
): Promise<CloneFolderResult> {
	try {
		const trimmedName = name?.trim();
		const resp = await authenticatedFetch(target, "/api/workspace/clone", {
			method: "POST",
			body: JSON.stringify({
				url,
				...(trimmedName ? { name: trimmedName } : undefined),
			}),
		});
		const { data, error } = await readJsonBody(
			resp,
			"clone",
			clonedFolderSchema
		);
		if (error) {
			return { error };
		}
		return { name: data?.name, path: data?.path };
	} catch (error) {
		return {
			error: error instanceof Error ? error.message : "clone failed",
		};
	}
}
