// packages/app-host/src/frame-rpc.ts
//
// The dispatch entry of the frame bridges (`ExtensionHost` on desktop and web,
// the WebView host on the phone). It adds the checks a host must make on a
// frame-chosen argument whatever its own Core client does with it afterwards.
//
// A record id becomes one segment of a Core path that is fetched with the node
// bearer. An id that carries a path character could aim that request at another
// route, so it is refused here before any host service runs. The ids of these
// families are minted by Core or by the app's backend (`quest_<hex>`,
// `mon_<hex>`, `appr_<hex>`, `ntf_<hex>`, `mtg_<hex>`, UUIDs, and workflow, run,
// version and template ids of `[A-Za-z0-9_-]`), so nothing legitimate is refused.

import { z } from "zod";
import {
	assertGranted,
	type Capability,
	CodedRpcError,
	dispatchRpc,
	type HostServices,
} from "./rpc.ts";

const ID: readonly string[] = ["id"];

/**
 * Frame methods whose named string arguments a host puts into a path (a Core
 * route, an app mount, or a shell route). Every key of `args[0]` listed here is
 * checked. `frame-rpc-path-ids.test.ts` reads `HostServices` and fails when a
 * method of these families takes an id key that is neither here nor exempt.
 */
export const FRAME_PATH_ID_KEYS: ReadonlyMap<string, readonly string[]> =
	new Map<string, readonly string[]>([
		["quests.use", ID],
		["quests.pin", ID],
		["quests.update", ID],
		["quests.delete", ID],
		["quests.complete", ID],
		["quests.dismiss", ID],
		["quests.acceptSuggestion", ID],
		["quests.dismissSuggestion", ID],
		["quests.judge", ID],
		["monitors.alerts", ID],
		["monitors.delete", ID],
		["monitors.get", ID],
		["monitors.run", ID],
		["monitors.snapshots", ID],
		["monitors.update", ID],
		["workflows.bindConnectTrigger", ID],
		["workflows.connectBindings", ID],
		["workflows.delete", ID],
		["workflows.get", ID],
		["workflows.removeConnectBinding", ID],
		["workflows.resume", ["runId"]],
		["workflows.run", ID],
		["workflows.runGet", ["runId"]],
		["workflows.templateGet", ID],
		["workflows.templateInstall", ["templateId"]],
		["workflows.versionCreate", ID],
		["workflows.versionGet", ["id", "versionId"]],
		["workflows.versionRestore", ["id", "versionId"]],
		["workflows.versionsList", ID],
		["workflows.webhook", ID],
		["approvals.approve", ID],
		["approvals.reject", ID],
		["notifications.ack", ID],
		["notifications.archive", ID],
		["notifications.markRead", ID],
		["notifications.unarchive", ID],
		["meetings.delete", ID],
		["meetings.finalize", ID],
		["meetings.open", ID],
		["meetings.openNotes", ["spaceId", "docId"]],
		["meetings.rename", ID],
		["meetings.setIcon", ID],
		["meetings.transcript", ID],
	]);

const PATH_CHARACTERS: ReadonlySet<string> = new Set([
	"/",
	"\\",
	"?",
	"#",
	"%",
]);
const SPACE_CODE = 0x20;
const DELETE_CODE = 0x7f;

const argRecordSchema = z.record(z.string(), z.unknown());

/**
 * True when an id can sit in a Core path as one segment for every HTTP client:
 * no path, query, fragment or escape character, no dot segment, and no space or
 * control character (URL parsers drop tab, CR and LF, so `.<TAB>.` reads `..`).
 */
export function isSafePathId(id: string): boolean {
	if (id === "" || id === "." || id === "..") {
		return false;
	}
	for (const character of id) {
		const code = character.codePointAt(0) ?? 0;
		if (
			code <= SPACE_CODE ||
			code === DELETE_CODE ||
			PATH_CHARACTERS.has(character)
		) {
			return false;
		}
	}
	return true;
}

/**
 * Refuse a call whose listed id is not a safe path segment. A key that is
 * missing, empty or not a string is left to `dispatchRpc`, which answers with
 * the method's own shape error.
 */
export function assertFramePathIds(
	method: string,
	args: readonly unknown[]
): void {
	const keys = FRAME_PATH_ID_KEYS.get(method);
	if (!keys) {
		return;
	}
	const parsed = argRecordSchema.safeParse(args[0]);
	if (!parsed.success) {
		return;
	}
	for (const key of keys) {
		const value = parsed.data[key];
		if (typeof value === "string" && value !== "" && !isSafePathId(value)) {
			throw new CodedRpcError(
				"invalid_args",
				`${method} requires ${key === "id" ? "an id" : key} without path characters`
			);
		}
	}
}

/**
 * `dispatchRpc` for a call that came from an app frame. The grant is checked
 * first, as `dispatchRpc` does, so an app without the grant learns nothing new.
 */
export async function dispatchFrameRpc(
	method: string,
	args: unknown[],
	granted: ReadonlySet<Capability>,
	services: HostServices,
	signal?: AbortSignal
) {
	assertGranted(method, granted);
	assertFramePathIds(method, args);
	return await dispatchRpc(method, args, granted, services, signal);
}
