import type { LiteralMessage } from "@ryu/i18n/react";
import { z } from "zod";
import { ApiError, type ApiTarget, request } from "@/src/lib/api/client.ts";

// Data layer for Settings → Danger Zone: the wire types, the Core requests, the
// deep-clean option tables and the failure copy. Split out of
// DangerZoneSettings.tsx; the component there is the only consumer.

/**
 * One deletable row, exactly as Core serves it in `GET /api/data/counts`.
 *
 * Snake_case because these are wire fields, not ours to rename: a category is
 * either compiled into Core (chats/spaces/memory — no app owns that data) or
 * declared by an app's `contributes.data_categories`, and both arrive through the
 * same descriptor so this component cannot tell, or need to tell, them apart.
 */
export interface DangerCategory {
	/** The word the user must type to arm this delete (e.g. "Meetings"). */
	confirm_word: string;
	/** Live item count, so the dialog can say "This will delete 42 monitors". */
	count: number;
	/** What exactly disappears, shown in the confirm dialog. */
	detail: string;
	/** Wire id — the `category` a clear names. */
	id: string;
	/** Plural noun for the count line and the "N deleted" toast. */
	noun: string;
	/** Owning app, or `null` for a kernel category that has none. */
	plugin: null | string;
	/** The destructive button + dialog title. */
	title: string;
}

/** The `/api/data/counts` body: descriptors, plus the legacy flat count keys. */
interface DataCountsPayload {
	categories?: DangerCategory[];
	chats?: number;
	memory?: number;
	spaces?: number;
}

/**
 * What to draw when the node's Core predates the `categories` payload.
 *
 * Only the kernel three, and deliberately: those are the categories every Core
 * that has ever shipped can clear, so listing them from an older node is safe. The
 * app-owned ones are omitted rather than guessed — an older Core cannot tell us
 * whether Monitors is enabled here, and offering a delete for data the node may
 * not hold is the failure this whole change removes.
 */
const LEGACY_KERNEL_CATEGORIES = [
	{
		id: "chats",
		title: "Delete all chats",
		noun: "chats",
		confirm_word: "Chats",
		detail:
			"Every conversation and all of its messages will be permanently deleted.",
	},
	{
		id: "spaces",
		title: "Delete all spaces",
		noun: "spaces",
		confirm_word: "Spaces",
		detail:
			"Every Space, including all of its documents and their search data, will be permanently deleted. System spaces (Artifacts, Uploads, Meetings, …) are left untouched.",
	},
	{
		id: "memory",
		title: "Clear all memory",
		noun: "memory entries",
		confirm_word: "Memory",
		detail: "Every long-term memory entry will be permanently forgotten.",
	},
] as const;

/**
 * Read the danger-zone rows for a node.
 *
 * Goes through `request` rather than the `data-admin.ts` helpers because the set
 * of categories is now open-ended — apps contribute to it — and those helpers
 * normalise the response down to five fixed numeric keys, which would drop the
 * descriptors on the floor.
 */
export async function fetchDangerCategories(
	target: ApiTarget
): Promise<DangerCategory[]> {
	const json = await request<DataCountsPayload>(
		target,
		"/api/data/counts",
		{},
		dataCountsPayloadResponseSchema
	);
	if (Array.isArray(json.categories)) {
		return json.categories;
	}
	return LEGACY_KERNEL_CATEGORIES.map((def) => ({
		...def,
		count: json[def.id] ?? 0,
		plugin: null,
	}));
}

/** Irreversibly delete every item in one category; resolves to the count removed. */
export async function clearCategory(
	target: ApiTarget,
	category: string
): Promise<number> {
	const json = await request<{ removed?: number }>(
		target,
		"/api/data/clear",
		{
			method: "POST",
			body: { category },
		},
		clearCategoryResponseSchema
	);
	return json?.removed ?? 0;
}

/** Profiles a clean can target.
 *
 *  Mirrors `PROFILE_PORT_OFFSETS` (apps/core/src/profile.rs) — each has its own
 *  data folder, gateway config and keychain slot, so cleaning one leaves the
 *  others untouched. */
export const CLEAN_PROFILES = [
	"release",
	"dev",
	"canary",
	"nightly",
	"beta",
] as const;

/** How much of each selected profile's data folder goes.
 *
 *  Mirrors `CleanDepth` (apps/core/src/data_path.rs). The labels say what
 *  SURVIVES, not just what goes: "config only" sounds thorough until you notice
 *  it is the one setting that leaves every chat, space and app in place. */
export const CLEAN_DEPTHS = [
	{
		value: "state",
		label: "Clear data, keep downloads",
		description:
			"Deletes chats, spaces, memory, installed apps and plugin state. Keeps bin/ and models/, so engines are not re-fetched.",
	},
	{
		value: "full",
		label: "Everything, including downloads",
		description:
			"Deletes the whole data folder, engines and models included. The next start re-downloads them.",
	},
	{
		value: "none",
		label: "Config only — keep all data",
		description:
			"Removes only the gateway config and the data-folder pointer. Chats, spaces, memory, apps and plugins are all left alone.",
	},
] as const;

/**
 * Drop every scrap of desktop-local state, so a wiped node comes back up looking
 * like a first launch.
 *
 * # Why this is a clear(), not a key list
 *
 * This used to be a 15-key allowlist (onboarding flags plus the `STORAGE_KEYS`
 * theme entries). That is the wrong shape for "fresh install" and it silently
 * decayed: the desktop writes localStorage from dozens of call sites — the
 * workspace folder (`ryu_workspace_folder`), pinned dock tabs
 * (`ryu_pinned_dock_tabs`), the getting-started checklist (`ryu:getting-started`),
 * the library view, the ACP config, the agent/model selection, and a long tail of
 * unprefixed per-setting keys (`theme`, `colorTheme`, `auto-updates`,
 * `context.*`, `agent-*`, …). None of those were in the list, so after a wipe the
 * app reopened its old tabs and workspace against a node that no longer had any
 * of the underlying records. That is the "I deep cleaned and Home / my Spaces /
 * my canvas are all still there" report: the data WAS gone server-side, the shell
 * was replaying stale client state on top of it.
 *
 * An allowlist can only ever be as current as the last person who remembered to
 * append to it, and every miss looks like "the wipe didn't work". Nothing in
 * localStorage is authoritative — node identity and the node list live in Core's
 * data dir (`nodes.json`), not here — so clearing all of it loses no state that
 * a fresh install would have had anyway.
 */
export function clearClientStateForFreshNode(): void {
	try {
		localStorage.clear();
		sessionStorage.clear();
	} catch {
		// Storage can be unavailable (private mode / locked-down webview). The wipe
		// itself already happened server-side; failing here must not turn a
		// successful clean into an error toast.
	}
}

/**
 * Turn a failed `POST /api/node/reset` into copy that names the actual cause.
 *
 * The distinction that matters in practice is 404: `/api/node/reset` is newer than
 * some shipped Cores, so a node running an older build has no such route and the
 * reset can never succeed until Core is updated. Blaming "shared node" for that
 * (the previous catch-all) sent people looking in the wrong place entirely.
 */
export function resetFailureReason<TError>(
	e: TError,
	tl: LiteralMessage
): string {
	if (!(e instanceof ApiError)) {
		return "Could not reach this node. Check that Core is running and try again.";
	}
	if (e.status === 404) {
		return "This node's Core is too old to support resetting. It has no /api/node/reset route. Update Core on this node, then try again.";
	}
	if (e.status === 403) {
		return (
			e.serverMessage ??
			"Resetting is not allowed on a shared (org-bound) node, because it would wipe every user's data."
		);
	}
	if (e.status === 400) {
		return "The confirmation did not match this node's name.";
	}
	return (
		e.serverMessage ??
		tl("Core returned {status}.", { status: String(e.status) })
	);
}

const dataCountsPayloadResponseSchema: z.ZodType<DataCountsPayload> =
	retainValidatedResponse(
		z
			.object({
				categories: z
					.array(
						z
							.object({
								confirm_word: z.string(),
								count: z.number(),
								detail: z.string(),
								id: z.string(),
								noun: z.string(),
								plugin: z.union([z.null(), z.string()]),
								title: z.string(),
							})
							.passthrough()
					)
					.optional(),
				chats: z.number().optional(),
				memory: z.number().optional(),
				spaces: z.number().optional(),
			})
			.passthrough()
	);
const clearCategoryResponseSchema: z.ZodType<{ removed?: number }> =
	retainValidatedResponse(
		z.object({ removed: z.number().optional() }).passthrough()
	);

function retainValidatedResponse<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>((value) => fields.safeParse(value).success);
}
