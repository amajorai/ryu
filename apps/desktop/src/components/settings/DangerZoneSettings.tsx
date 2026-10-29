import { z } from "zod";
// Settings → Danger Zone. Irreversible bulk "delete all X" actions for the user
// data Core holds on this node. Purely a visual layer — every delete is performed
// by Core (`/api/data/clear`, see apps/core/src/server/data_admin.rs). Each action
// is guarded by a type-to-confirm dialog and shows a live item count first.
//
// WHICH rows exist is Core's answer, not ours. This file used to carry a
// `CATEGORIES` array holding the id, title, noun, confirm word and copy of all
// five categories — a second hardcoded list that had to be edited in lockstep with
// Core's `DataCategory` enum, and that named apps (Monitors, Meetings) from the
// closed desktop source. An app now declares its own category in its manifest
// (`contributes.data_categories`) and Core serves the enabled ones with their live
// counts, so a row appears and disappears with its app and the copy lives with the
// team that owns the data.

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useState } from "react";
import { sileo } from "sileo";
import { restartRyuCore, startRyuCore } from "@/lib/tauri-bridge.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import {
	useActiveNode,
	useActiveNodeGetter,
} from "@/src/hooks/useActiveNode.ts";
import {
	ApiError,
	type ApiTarget,
	request,
	toTarget,
} from "@/src/lib/api/client.ts";
import { resetNode } from "@/src/lib/api/data-admin.ts";
import { isLocalNode } from "@/src/store/useNodeStore.ts";

/**
 * One deletable row, exactly as Core serves it in `GET /api/data/counts`.
 *
 * Snake_case because these are wire fields, not ours to rename: a category is
 * either compiled into Core (chats/spaces/memory — no app owns that data) or
 * declared by an app's `contributes.data_categories`, and both arrive through the
 * same descriptor so this component cannot tell, or need to tell, them apart.
 */
interface DangerCategory {
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
async function fetchDangerCategories(
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
async function clearCategory(
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
const CLEAN_PROFILES = ["release", "dev", "canary", "nightly", "beta"] as const;

/** How much of each selected profile's data folder goes.
 *
 *  Mirrors `CleanDepth` (apps/core/src/data_path.rs). The labels say what
 *  SURVIVES, not just what goes: "config only" sounds thorough until you notice
 *  it is the one setting that leaves every chat, space and app in place. */
const CLEAN_DEPTHS = [
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
function clearClientStateForFreshNode(): void {
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
function resetFailureReason<TError>(e: TError): string {
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
	return e.serverMessage ?? `Core returned ${e.status}.`;
}

export function DangerZoneSettings() {
	const { canUseNativeShell } = useAppSurface();
	const getNode = useActiveNodeGetter();
	const queryClient = useQueryClient();
	const [active, setActive] = useState<DangerCategory | null>(null);
	const [typed, setTyped] = useState("");
	const [busy, setBusy] = useState(false);

	// Reset node: a full wipe of this node (own type-to-confirm on the node name,
	// separate from the per-category deletes above).
	const nodeName = getNode().name;
	/** Options sheet (what to remove) — step 1. */
	const [deepCleanOptionsOpen, setDeepCleanOptionsOpen] = useState(false);
	/** Type-to-confirm on the chosen scope — step 2. */
	const [deepCleanOpen, setDeepCleanOpen] = useState(false);
	const [deepCleaning, setDeepCleaning] = useState(false);
	// The same two axes `bun run wipe` exposes: WHICH profile, and HOW MUCH of it.
	// Profiles are a SET: cleaning dev and canary together is the common case when
	// resetting a dev machine, and doing it one dialog at a time meant one Core
	// stop + restart per profile.
	const [cleanProfiles, setCleanProfiles] = useState<string[]>(["release"]);
	// Defaults to `state`, NOT `none`. `none` removes the gateway config and
	// nothing else, so a button labelled "Deep clean" left at its default deleted
	// no chats, no spaces, no apps and no plugins — it read as "deep clean is
	// broken" rather than as "you left the depth on config-only". `state` is what
	// the label promises while still keeping the multi-GB engine/model downloads.
	const [cleanDepth, setCleanDepth] = useState<"none" | "state" | "full">(
		"state"
	);
	const toggleCleanProfile = useCallback((profile: string, on: boolean) => {
		setCleanProfiles((prev) =>
			on ? [...new Set([...prev, profile])] : prev.filter((p) => p !== profile)
		);
	}, []);
	const doDeepClean = useCallback(async () => {
		setDeepCleaning(true);
		try {
			// One invoke per profile, sequentially: the Tauri command STOPS Core
			// before removing anything (WAL: a live copy is a torn snapshot) and each
			// call targets exactly one data dir. It does not restart Core, so the app
			// is left with none until we bring one back — hence the single restart
			// after the whole set, rather than one restart per profile.
			for (const profile of cleanProfiles) {
				await invoke("deep_clean_node", {
					depth: cleanDepth,
					profile,
				});
			}

			// Deep clean deletes the OS config dir, which holds gateway.toml AND the
			// data-path pointer. Core resolves both once at startup and caches them,
			// so a running Core would keep serving state that no longer exists on
			// disk. The same reasoning as Reset node: clear the client-side
			// onboarding flags, restart Core, reload — otherwise the app returns to a
			// node whose configuration was just removed and never re-runs setup.
			clearClientStateForFreshNode();
			sileo.success({
				title: "Deep clean complete",
				description: "Restarting to pick up the cleared configuration…",
			});
			setDeepCleanOpen(false);
			setDeepCleanOptionsOpen(false);

			// Only the LOCAL node's Core is ours to restart — a remote node runs on
			// its own host, exactly as Reset node treats it.
			if (isLocalNode(getNode())) {
				await restartRyuCore().catch(() => undefined);
			}
			window.location.reload();
		} catch (e) {
			sileo.error({
				title: "Could not deep clean",
				description: String(e),
			});
			// The failed invoke (or an earlier one in the set) has usually stopped
			// Core already, and nothing else brings it back. Start the local Core
			// again so the page stays usable for a retry; `start_ryu_core` is a
			// no-op when Core never stopped (e.g. an early "binary not found").
			if (isLocalNode(getNode())) {
				await startRyuCore().catch(() => undefined);
			}
			setDeepCleaning(false);
			setDeepCleanOpen(false);
		}
	}, [getNode, cleanProfiles, cleanDepth]);
	const [resetOpen, setResetOpen] = useState(false);
	const [resetTyped, setResetTyped] = useState("");

	// A confirmation describes ONE node: its counts and its name. If another node
	// is selected while one is open, it no longer describes the node a delete or
	// reset would reach, so it is withdrawn during that render instead of being
	// carried out on the newly selected node.
	const selectedNodeUrl = useActiveNode().url;
	const [confirmingFor, setConfirmingFor] = useState(selectedNodeUrl);
	if (confirmingFor !== selectedNodeUrl) {
		setConfirmingFor(selectedNodeUrl);
		setActive(null);
		setTyped("");
		setResetOpen(false);
		setResetTyped("");
	}
	const [resetBusy, setResetBusy] = useState(false);
	const resetArmed = resetTyped.trim().toLowerCase() === nodeName.toLowerCase();

	const runReset = async () => {
		setResetBusy(true);
		try {
			const node = getNode();
			const { restartRequired } = await resetNode(toTarget(node), nodeName);
			// Core wipe does not touch the desktop's localStorage — clear the
			// onboarding/setup flags here so the reload lands on /onboarding.
			clearClientStateForFreshNode();
			sileo.success({
				title: "Node reset",
				description: restartRequired
					? "Restarting to wipe and start fresh…"
					: "This node has been reset.",
			});
			setResetOpen(false);
			// Core exits itself after arming the wipe marker. For the local node,
			// wait for that exit and start a fresh Core so `apply_pending_reset`
			// runs; remote nodes are restarted by their own host. Always reload
			// so MemoryRouter re-reads the cleared onboarding flag.
			if (restartRequired && isLocalNode(node)) {
				await restartRyuCore().catch(() => undefined);
			}
			window.location.reload();
		} catch (e) {
			console.error("Failed to reset node", e);
			sileo.error({
				title: "Could not reset node",
				description: resetFailureReason(e),
			});
		} finally {
			setResetBusy(false);
		}
	};

	const {
		data: categories,
		isPending,
		isError,
		refetch,
	} = useQuery<DangerCategory[]>({
		queryKey: ["data-counts", getNode().url],
		queryFn: () => fetchDangerCategories(toTarget(getNode())),
	});

	const openConfirm = (def: DangerCategory) => {
		setTyped("");
		setActive(def);
	};

	const runClear = async () => {
		if (!active) {
			return;
		}
		setBusy(true);
		try {
			const removed = await clearCategory(toTarget(getNode()), active.id);
			await queryClient.invalidateQueries({ queryKey: ["data-counts"] });
			sileo.success({
				title: "Deleted",
				description: `${removed} ${active.noun} deleted.`,
			});
			setActive(null);
		} catch (e) {
			console.error("Failed to clear data category", e);
			sileo.error({
				title: "Could not delete",
				description:
					"Something went wrong while deleting. Please check your connection and try again.",
			});
		} finally {
			setBusy(false);
		}
	};

	const armed =
		active !== null &&
		typed.trim().toLowerCase() === active.confirm_word.toLowerCase();

	return (
		<div className="flex flex-col gap-6">
			<SettingsSection
				caption="Permanently delete data Ryu stores on this node. These actions cannot be undone. Export a backup from Storage first if you might want it back."
				title="Danger zone"
			>
				{isError ? (
					<div className="flex flex-col items-start gap-3 rounded-md bg-muted p-4">
						<p className="text-muted-foreground text-sm">
							We couldn't load your data. Deleting is disabled until we know
							what's here.
						</p>
						<Button
							onClick={() => {
								refetch().catch(() => undefined);
							}}
							size="sm"
							variant="ghost"
						>
							Retry
						</Button>
					</div>
				) : (
					<SettingsGroup>
						{isPending ? (
							<SettingsItem description="Loading…" title="Checking this node" />
						) : (
							(categories ?? []).map((def) => (
								<SettingsItem
									actions={
										<Button
											disabled={def.count === 0}
											onClick={() => openConfirm(def)}
											size="sm"
											variant="destructive"
										>
											{def.title}
										</Button>
									}
									description={
										def.count === 0
											? `No ${def.noun}`
											: `${formatCount(def.count) ?? "—"} ${def.noun}`
									}
									key={def.id}
									title={def.title}
								/>
							))
						)}
					</SettingsGroup>
				)}
			</SettingsSection>

			<SettingsSection
				caption="Wipe this entire node and start over: every chat, space, memory, session, download, and setting is permanently deleted and onboarding runs again. Only the node's encryption key is kept so it can boot. Useful for a completely fresh state during development."
				title="Reset node"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Button
								onClick={() => {
									setResetTyped("");
									setResetOpen(true);
								}}
								size="sm"
								variant="destructive"
							>
								Reset node
							</Button>
						}
						description={`Fully resets "${nodeName}" and restarts it`}
						title="Reset node to a fresh state"
					/>
				</SettingsGroup>
			</SettingsSection>

			{canUseNativeShell ? (
				<SettingsSection
					caption="Reset node clears this node's data folder and nothing else. The gateway config and the pointer to the data folder live OUTSIDE it and survive. This removes those too, and can also clear the data folder itself."
					title="Deep clean"
				>
					{/* One button, and every option behind it. The scope controls used to sit
					    inline as three sibling SettingsItems above the button, which read as
					    unrelated node settings rather than as arguments TO the button — so
					    people clicked "Deep clean" without ever seeing that the depth was
					    still on its config-only default and nothing they cared about was
					    being removed. */}
					<SettingsGroup>
						<SettingsItem
							actions={
								<Button
									disabled={deepCleaning}
									onClick={() => setDeepCleanOptionsOpen(true)}
									size="sm"
									variant="destructive"
								>
									{deepCleaning ? "Cleaning…" : "Deep clean…"}
								</Button>
							}
							description="Choose which profiles and how much to remove, then restart into setup"
							title="Run deep clean"
						/>
					</SettingsGroup>
				</SettingsSection>
			) : null}

			<Dialog
				onOpenChange={(open) => {
					if (!open) {
						setDeepCleanOptionsOpen(false);
					}
				}}
				open={deepCleanOptionsOpen}
			>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>Deep clean</DialogTitle>
						<DialogDescription>
							Pick what to remove. Every profile has its own data folder,
							gateway config and keychain slot, so cleaning one leaves the
							others untouched.
						</DialogDescription>
					</DialogHeader>

					<div className="flex flex-col gap-5 py-1">
						<div className="flex flex-col gap-2">
							<span className="font-medium text-sm">Profiles to clean</span>
							<div className="grid grid-cols-2 gap-2">
								{CLEAN_PROFILES.map((p) => (
									<label
										className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm"
										htmlFor={`clean-profile-${p}`}
										key={p}
									>
										<Checkbox
											checked={cleanProfiles.includes(p)}
											id={`clean-profile-${p}`}
											onCheckedChange={(checked) =>
												toggleCleanProfile(p, checked === true)
											}
										/>
										{p}
									</label>
								))}
							</div>
						</div>

						<div className="flex flex-col gap-2">
							<span className="font-medium text-sm">How much to remove</span>
							<Select<"none" | "state" | "full">
								items={CLEAN_DEPTHS.map((d) => ({
									label: d.label,
									value: d.value,
								}))}
								onValueChange={(v) => setCleanDepth(v)}
								value={cleanDepth}
							>
								<SelectTrigger className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{CLEAN_DEPTHS.map((d) => (
										<SelectItem key={d.value} value={d.value}>
											{d.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<span className="text-muted-foreground text-xs">
								{CLEAN_DEPTHS.find((d) => d.value === cleanDepth)?.description}
							</span>
						</div>
					</div>

					<DialogFooter>
						<Button
							onClick={() => setDeepCleanOptionsOpen(false)}
							variant="ghost"
						>
							Cancel
						</Button>
						<Button
							disabled={cleanProfiles.length === 0 || deepCleaning}
							onClick={() => setDeepCleanOpen(true)}
							variant="destructive"
						>
							Continue
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<AlertDialog
				onOpenChange={(open) => {
					if (!open) {
						setDeepCleanOpen(false);
					}
				}}
				open={deepCleanOpen}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Remove these folders?</AlertDialogTitle>
						<AlertDialogDescription>
							Ryu will stop, then permanently remove the
							<strong> {cleanProfiles.join(", ")} </strong>
							{cleanProfiles.length === 1 ? "profile's" : "profiles'"} gateway
							config folder (gateway.toml and the pointer to its data folder)
							{cleanDepth === "state"
								? ", and clear its data folder while keeping downloaded engines and models"
								: null}
							{cleanDepth === "full"
								? ", and delete its entire data folder including downloaded engines and models"
								: null}
							. Then it restarts and runs setup again. This cannot be undone.
						</AlertDialogDescription>
						<AlertDialogDescription>
							<span className="text-status-warning">
								{cleanDepth === "none"
									? "Chats, spaces and memory live in the data folder and are NOT touched at this setting."
									: "The encryption key is kept: it is node identity, and there is no way to re-encrypt data without it."}
							</span>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={deepCleaning}>
							Cancel
						</AlertDialogCancel>
						<AlertDialogAction
							disabled={deepCleaning}
							onClick={() => {
								void doDeepClean();
							}}
						>
							{deepCleaning ? "Cleaning…" : "Remove them"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			<AlertDialog
				onOpenChange={(open) => {
					if (!open) {
						setResetOpen(false);
					}
				}}
				open={resetOpen}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Reset this node?</AlertDialogTitle>
						<AlertDialogDescription>
							This permanently deletes ALL data on{" "}
							<span className="font-medium text-foreground">{nodeName}</span>{" "}
							(every chat, space, memory, session, download, and setting), then
							restarts it to a fresh, just-installed state. This cannot be
							undone.
						</AlertDialogDescription>
					</AlertDialogHeader>

					<div className="flex flex-col gap-1.5">
						<span className="text-muted-foreground text-xs">
							Type{" "}
							<span className="font-medium text-foreground">{nodeName}</span> to
							confirm.
						</span>
						<Input
							aria-label={`Type ${nodeName} to confirm`}
							autoComplete="off"
							onChange={(e) => setResetTyped(e.target.value)}
							placeholder={nodeName}
							value={resetTyped}
						/>
					</div>

					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							disabled={!resetArmed || resetBusy}
							onClick={(e) => {
								e.preventDefault();
								runReset().catch(() => undefined);
							}}
							variant="destructive"
						>
							{resetBusy ? "Resetting…" : "Reset node"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			<AlertDialog
				onOpenChange={(open) => {
					if (!open) {
						setActive(null);
					}
				}}
				open={active !== null}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{active?.title}?</AlertDialogTitle>
						<AlertDialogDescription>
							{active
								? `This will delete ${formatCount(active.count) ?? "—"} ${active.noun}. ${active.detail} This cannot be undone.`
								: ""}
						</AlertDialogDescription>
					</AlertDialogHeader>

					<div className="flex flex-col gap-1.5">
						<span className="text-muted-foreground text-xs">
							Type{" "}
							<span className="font-medium text-foreground">
								{active?.confirm_word}
							</span>{" "}
							to confirm.
						</span>
						<Input
							aria-label={`Type ${active?.confirm_word ?? "the confirmation word"} to confirm`}
							autoComplete="off"
							onChange={(e) => setTyped(e.target.value)}
							placeholder={active?.confirm_word}
							value={typed}
						/>
					</div>

					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							disabled={!armed || busy}
							onClick={(e) => {
								// Keep the dialog open while the request runs; close on success.
								e.preventDefault();
								runClear().catch(() => undefined);
							}}
							variant="destructive"
						>
							{busy ? "Deleting…" : "Delete"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
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
