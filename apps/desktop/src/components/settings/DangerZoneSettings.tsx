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

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useState } from "react";
import { sileo } from "sileo";
import { restartRyuCore, startRyuCore } from "@/lib/tauri-bridge.ts";
import {
	ClearCategoryDialog,
	ResetNodeDialog,
} from "@/src/components/settings/DangerZoneSettings-confirm-dialogs.tsx";
import {
	clearCategory,
	clearClientStateForFreshNode,
	type DangerCategory,
	fetchDangerCategories,
	resetFailureReason,
} from "@/src/components/settings/DangerZoneSettings-data.ts";
import {
	DeepCleanConfirmDialog,
	DeepCleanOptionsDialog,
} from "@/src/components/settings/DangerZoneSettings-deep-clean-dialogs.tsx";
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
import { toTarget } from "@/src/lib/api/client.ts";
import { resetNode } from "@/src/lib/api/data-admin.ts";
import { isLocalNode } from "@/src/store/useNodeStore.ts";

export function DangerZoneSettings() {
	const { canUseNativeShell } = useAppSurface();
	const tl = useLiteralMessages();
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
				description: resetFailureReason(e, tl),
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
						description={tl('Fully resets "{nodeName}" and restarts it', {
							nodeName,
						})}
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

			<DeepCleanOptionsDialog
				cleanDepth={cleanDepth}
				cleanProfiles={cleanProfiles}
				deepCleaning={deepCleaning}
				deepCleanOptionsOpen={deepCleanOptionsOpen}
				setCleanDepth={setCleanDepth}
				setDeepCleanOpen={setDeepCleanOpen}
				setDeepCleanOptionsOpen={setDeepCleanOptionsOpen}
				toggleCleanProfile={toggleCleanProfile}
			/>

			<DeepCleanConfirmDialog
				cleanDepth={cleanDepth}
				cleanProfiles={cleanProfiles}
				deepCleaning={deepCleaning}
				deepCleanOpen={deepCleanOpen}
				doDeepClean={doDeepClean}
				setDeepCleanOpen={setDeepCleanOpen}
			/>

			<ResetNodeDialog
				nodeName={nodeName}
				resetArmed={resetArmed}
				resetBusy={resetBusy}
				resetOpen={resetOpen}
				resetTyped={resetTyped}
				runReset={runReset}
				setResetOpen={setResetOpen}
				setResetTyped={setResetTyped}
			/>

			<ClearCategoryDialog
				active={active}
				armed={armed}
				busy={busy}
				runClear={runClear}
				setActive={setActive}
				setTyped={setTyped}
				typed={typed}
			/>
		</div>
	);
}
