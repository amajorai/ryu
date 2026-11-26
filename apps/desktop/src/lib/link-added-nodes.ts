// Which saved nodes came from a `ryu://nodes/connect` link.
//
// A node link supplies the address and the token together, so a node saved
// from one must never receive the signed-in account's JWT: the shared gate
// (`@ryuhq/protocol/account-jwt-gate`) asks this module. The node list itself
// lives in the native `nodes.json`, which has no field for where a node came
// from, so the answer is kept beside it in localStorage, keyed by server
// (scheme, host and port).
//
// A mark is set when the confirm dialog saves a link's node and cleared when
// the user adds the same server by hand in the Add node dialog. A mark that
// outlives its node only withholds the JWT, so nothing here has to run when a
// node is removed. Every window reads the same storage on each call, so a mark
// set in one window holds in the others at once.

import { parseNodeUrl, sameNodeOrigin } from "@ryuhq/protocol/node-url";
import { z } from "zod";

const STORAGE_KEY = "ryu:node-added-by-link";
const originsSchema = z.array(z.string()).catch([]);

/** Marks storage refused to keep; they hold until the app restarts. */
const unsaved = new Set<string>();
let cachedRaw: string | null = null;
let cachedOrigins: ReadonlySet<string> = new Set();

function readStored(): ReadonlySet<string> {
	let raw: string | null = null;
	try {
		raw = globalThis.localStorage.getItem(STORAGE_KEY);
	} catch {
		return new Set();
	}
	if (raw === cachedRaw) {
		return cachedOrigins;
	}
	let origins: string[] = [];
	try {
		origins = originsSchema.parse(raw ? JSON.parse(raw) : []);
	} catch {
		// Unreadable marks are dropped; the next write replaces them.
	}
	cachedRaw = raw;
	cachedOrigins = new Set(origins);
	return cachedOrigins;
}

function writeStored(origins: ReadonlySet<string>): boolean {
	try {
		globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify([...origins]));
		return true;
	} catch {
		return false;
	}
}

/** Record that the node at `url` is being saved from a link. */
export function markLinkAddedNode(url: string): void {
	const origin = parseNodeUrl(url)?.origin;
	if (!origin) {
		return;
	}
	const origins = new Set(readStored());
	origins.add(origin);
	if (!writeStored(origins)) {
		unsaved.add(origin);
	}
}

/** The user added the node at `url` by hand: it is theirs to vouch for. */
export function clearLinkAddedNode(url: string): void {
	const origin = parseNodeUrl(url)?.origin;
	if (!origin) {
		return;
	}
	unsaved.delete(origin);
	const origins = new Set(readStored());
	if (origins.delete(origin)) {
		writeStored(origins);
	}
}

/**
 * Save the node a link named through `save`, marked as link-added. The mark is
 * set before the node is saved, so no request can reach it unmarked, and taken
 * back when saving fails. A server the user already has (`savedUrls`) is left
 * as it is: a link cannot strip the JWT from a node added by hand.
 */
export async function saveLinkAddedNode(
	url: string,
	savedUrls: readonly string[],
	save: () => Promise<void>
): Promise<void> {
	const known = savedUrls.some((saved) => sameNodeOrigin(saved, url));
	if (!known) {
		markLinkAddedNode(url);
	}
	try {
		await save();
	} catch (error) {
		if (!known) {
			clearLinkAddedNode(url);
		}
		throw error;
	}
}

/** Whether the server at `url` was saved from a link and not by hand since. */
export function isLinkAddedNode(url: string): boolean {
	const origin = parseNodeUrl(url)?.origin;
	if (!origin) {
		return false;
	}
	return readStored().has(origin) || unsaved.has(origin);
}
