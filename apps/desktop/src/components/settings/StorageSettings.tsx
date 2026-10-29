import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import previewStyles from "./settings-preview.module.css";
import type { PreviewStyle } from "./settings-preview-style.ts";
// Storage settings tab: view + relocate the Ryu data folder, and back it up /
// restore it. All path logic lives in Core (`crate::data_path`); this tab reads
// the state, validates a target, and triggers either a point-only switch (Core
// API) or a copy-migrate / import (offline `ryu-core data-path` subcommand
// orchestrated by the `migrate_data_folder` / `import_data_folder` Tauri
// commands, which restart the app to apply).

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
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { sileo } from "sileo";
import { getRyuStatus, startRyuCore } from "@/lib/tauri-bridge.ts";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { type ApiTarget, toTarget } from "@/src/lib/api/client.ts";
import {
	type DataPathInfo,
	exportDataPath,
	getDataPath,
	resetDataPath,
	switchDataPath,
	type ValidateResult,
	validateDataPath,
} from "@/src/lib/api/data-path.ts";
import {
	fetchParseCapability,
	type ParseCapability,
} from "@/src/lib/api/documents.ts";
import { formatBytes, NODE_UPLOAD_MAX_BYTES } from "@/src/lib/api/spaces.ts";
import { listenWhenReady } from "@/src/lib/tauri-ready.ts";
import { NodeBackupSettings } from "./BackupSettings.tsx";

/** Core refuses an export passphrase shorter than this (`data_path.rs`). */
const MIN_BACKUP_PASSPHRASE_CHARS = 12;

/** Profiles a copy can target.
 *
 *  Mirrors the non-release rows of `PROFILE_PORT_OFFSETS`
 *  (apps/core/src/profile.rs) — the profiles that have their own port offset, data
 *  dir and keychain slot. `release` is deliberately absent: copying INTO your
 *  primary profile is a restore, which belongs to Backup & restore where it is
 *  guarded accordingly. */
const PROFILE_COPY_TARGETS = ["dev", "canary", "nightly", "beta"] as const;

function humanBytes(n: number): string {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let v = n;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i += 1;
	}
	return `${v.toFixed(1)} ${units[i]}`;
}

interface PickedTarget {
	path: string;
	validation: ValidateResult;
}

/**
 * The selected node's authority. Every read and write on this tab is bound to
 * the node that is selected NOW, so a node switch rereads and a reply from the
 * previous node is discarded instead of being shown as this node's state.
 */
function useSelectedNodeTarget(): ApiTarget {
	const node = useActiveNode();
	return useMemo(
		() => toTarget({ url: node.url, token: node.token, userJwt: node.userJwt }),
		[node.url, node.token, node.userJwt]
	);
}

/**
 * The node's upload ceiling. Read-only, and read FROM THE NODE.
 *
 * It lives on the Storage tab because it is a fact about what this machine will
 * accept onto its own disk — the same subject as the data folder above it. It
 * used to be a card on a separate "Document parsing" tab, which also carried a
 * second copy of the `document.parse` provider picker; that picker is the node
 * dropdown's Toolkits row, the same generic surface every other swappable
 * capability (`web.extract`, `web.search`, …) is bound from, so the duplicate
 * went and this row moved here.
 *
 * ## The number this must not print
 *
 * It once printed `MAX_FILE_BYTES` (200 MiB) as "Maximum file in a Space", a
 * promise the node would not keep twice over: that constant named a route no
 * surface in this app calls, and the route could not have honoured it anyway
 * (registered with no `DefaultBodyLimit`, so axum's implicit 2 MiB cut in first —
 * and its body is base64, so the true ceiling was ~1.5 MiB of file). Every upload
 * a user can perform — chat attachment, editor paste, `ui.uploadFile` — goes to
 * `POST /api/uploads` and stops at {@link NODE_UPLOAD_MAX_BYTES}, 32 MiB.
 *
 * Core has since converged the two (`MAX_FILE_BYTES = uploads::MAX_UPLOAD_BYTES`,
 * and `/api/spaces/:id/files` now layers `SPACE_FILE_BODY_LIMIT`), so every
 * reachable route stops at the same number. That is a reason this row is no
 * longer WRONG, not a reason to hardcode it: it converged once and could diverge
 * again, and a row that reads the node cannot be wrong the next time it moves.
 * So the constant is the fallback for a failed read ONLY, and the row says so
 * when it is used.
 */
function UploadCeilingSection() {
	const target = useSelectedNodeTarget();
	const [capability, setCapability] = useState<ParseCapability | null>(null);

	useEffect(() => {
		let cancelled = false;
		setCapability(null);
		// Failure-tolerant: this probes the bound parse sidecar (2s budget, and it
		// never wakes a sleeping one), so it is allowed to come back empty without
		// taking the Storage tab down with it.
		fetchParseCapability(target)
			.then((next) => {
				if (!cancelled) {
					setCapability(next);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setCapability(null);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [target]);

	const reported = capability?.maxInputBytes ?? 0;
	const limit = reported > 0 ? reported : NODE_UPLOAD_MAX_BYTES;

	return (
		<SettingsSection
			caption="What this node accepts onto its disk. Files are kept as content-addressed blobs inside the data folder above."
			title="Upload limits"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<span className="text-foreground text-sm">
							{formatBytes(limit)}
						</span>
					}
					description={
						reported > 0
							? "Reported by this node. Chat attachments, files added to a Space and images pasted into a page all go through the same upload route, and the document parser accepts the same size, so one number governs all of them."
							: "This node did not report its limit, so this is the desktop's built-in default; the real ceiling may differ."
					}
					title="Maximum file you can upload"
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}

interface ProgressState {
	copied: number;
	phase: string;
	total: number;
}

export function StorageSettings() {
	const { canUseNativeShell } = useAppSurface();
	const target = useSelectedNodeTarget();
	// The node this tab currently speaks for. Async results captured for an
	// earlier node compare against it and are dropped once it has moved on.
	const targetRef = useRef(target);
	targetRef.current = target;
	const [info, setInfo] = useState<DataPathInfo | null>(null);
	const [picked, setPicked] = useState<PickedTarget | null>(null);
	const [busy, setBusy] = useState(false);
	const [pendingProfileCopy, setPendingProfileCopy] = useState<string | null>(
		null
	);
	const [progress, setProgress] = useState<ProgressState | null>(null);
	const [pendingRestore, setPendingRestore] = useState<string | null>(null);
	const [restorePassphrase, setRestorePassphrase] = useState("");
	const [exportDialogOpen, setExportDialogOpen] = useState(false);
	const [exportPassphrase, setExportPassphrase] = useState("");
	const [exportConfirm, setExportConfirm] = useState("");
	const [loadFailed, setLoadFailed] = useState(false);

	const refresh = useCallback(() => {
		setLoadFailed(false);
		getDataPath(target)
			.then((next) => {
				if (targetRef.current !== target) {
					return;
				}
				setInfo(next);
				setLoadFailed(false);
			})
			.catch(() => {
				if (targetRef.current !== target) {
					return;
				}
				setInfo(null);
				setLoadFailed(true);
			});
	}, [target]);

	useEffect(() => {
		// A folder picked and validated on one node is no authority to switch
		// another, and the shown location belongs to the node it was read from.
		setInfo(null);
		setPicked(null);
		refresh();
	}, [refresh]);

	// Stream copy/extract progress from the offline subcommand.
	useEffect(() => {
		if (!canUseNativeShell) {
			return;
		}
		const unlisten = listenWhenReady<{
			phase: string;
			copied_bytes: number;
			total_bytes: number;
		}>("data-folder-progress", (event) => {
			setProgress({
				phase: event.payload.phase,
				copied: event.payload.copied_bytes,
				total: event.payload.total_bytes,
			});
		});
		return () => {
			unlisten.then((fn) => fn()).catch(() => undefined);
		};
	}, [canUseNativeShell]);

	const pickFolder = useCallback(async () => {
		const selected = await open({ directory: true, multiple: false });
		if (!isNativeText(selected)) {
			return;
		}
		const validation = await validateDataPath(target, selected);
		if (targetRef.current !== target) {
			return;
		}
		setPicked({ path: selected, validation });
	}, [target]);

	const doMigrate = useCallback(async () => {
		if (!picked) {
			return;
		}
		setBusy(true);
		setProgress({
			phase: "copy",
			copied: 0,
			total: picked.validation.source_size_bytes,
		});
		try {
			// Resolves only on failure — on success the app restarts.
			await invoke("migrate_data_folder", {
				to: picked.path,
				moveSource: false,
			});
		} catch (e) {
			setBusy(false);
			setProgress(null);
			sileo.error({ title: "Relocation failed", description: String(e) });
		}
	}, [picked]);

	const doSwitch = useCallback(async () => {
		if (!picked) {
			return;
		}
		setBusy(true);
		try {
			const res = await switchDataPath(target, picked.path);
			if (!res.ok) {
				throw new Error(res.error ?? "switch failed");
			}
			await relaunch();
		} catch (e) {
			setBusy(false);
			sileo.error({ title: "Could not switch folder", description: String(e) });
		}
	}, [target, picked]);

	const doReset = useCallback(async () => {
		setBusy(true);
		try {
			const res = await resetDataPath(target);
			if (!res.ok) {
				throw new Error(res.error ?? "reset failed");
			}
			await relaunch();
		} catch (e) {
			setBusy(false);
			sileo.error({ title: "Could not reset folder", description: String(e) });
		}
	}, [target]);

	const doProfileCopy = useCallback(async (toProfile: string) => {
		setBusy(true);
		// The Tauri command stops this profile's local Core (whichever node is
		// active) and deliberately does not restart it, so restart it here when it
		// was running, whether or not the copy succeeds.
		const coreWasRunning =
			(await getRyuStatus().catch(() => "stopped")) === "running";
		try {
			// Core is stopped by the Tauri command before anything is copied (every
			// store runs in WAL mode, so a live copy captures a torn snapshot), and the
			// master key is moved BEFORE any file is written — a failure there aborts
			// with nothing copied rather than leaving unreadable ciphertext behind.
			await invoke("copy_data_folder_to_profile", { toProfile });
			sileo.success({
				title: `Copied to the ${toProfile} profile`,
				description: coreWasRunning
					? "Start Ryu on that profile to use it. This profile is unchanged; restarting local Core…"
					: "Start Ryu on that profile to use it. This profile is unchanged.",
			});
		} catch (e) {
			sileo.error({
				title: "Could not copy to that profile",
				description: String(e),
			});
		} finally {
			if (coreWasRunning) {
				await startRyuCore().catch(() => undefined);
			}
			setBusy(false);
			setPendingProfileCopy(null);
		}
	}, []);

	const exportPassphraseError = (() => {
		if ([...exportPassphrase].length < MIN_BACKUP_PASSPHRASE_CHARS) {
			return `Use at least ${MIN_BACKUP_PASSPHRASE_CHARS} characters.`;
		}
		if (exportPassphrase !== exportConfirm) {
			return "The passphrases do not match.";
		}
		return null;
	})();

	const closeExportDialog = useCallback(() => {
		setExportDialogOpen(false);
		setExportPassphrase("");
		setExportConfirm("");
	}, []);

	const doExport = useCallback(async () => {
		// The passphrase is held only for this export and cleared with the dialog.
		const passphrase = exportPassphrase;
		closeExportDialog();
		const dest = await save({
			defaultPath: "ryu-data-backup.zip",
			filters: [{ name: "Zip archive", extensions: ["zip"] }],
		});
		// The destination was chosen for the node selected when Export was
		// clicked. If another node was selected while the dialog was open, the
		// earlier one is no longer this tab's authority, so nothing is written.
		if (!dest || targetRef.current !== target) {
			return;
		}
		setBusy(true);
		try {
			const res = await exportDataPath(target, dest, passphrase);
			if (!res.ok) {
				throw new Error(res.error ?? "export failed");
			}
			sileo.success({
				title: "Backup created",
				description: `${humanBytes(res.bytes ?? 0)} written to ${dest}`,
			});
		} catch (e) {
			sileo.error({ title: "Backup failed", description: String(e) });
		} finally {
			setBusy(false);
		}
	}, [closeExportDialog, exportPassphrase, target]);

	const doImport = useCallback(async () => {
		const archive = await open({
			multiple: false,
			filters: [{ name: "Zip archive", extensions: ["zip"] }],
		});
		if (!isNativeText(archive)) {
			return;
		}
		// Confirm before wiping current data — the actual restore runs in runImport.
		setPendingRestore(archive);
	}, []);

	const runImport = useCallback(async () => {
		if (!pendingRestore) {
			return;
		}
		const archive = pendingRestore;
		const passphrase = restorePassphrase;
		setPendingRestore(null);
		setRestorePassphrase("");
		setBusy(true);
		setProgress({ phase: "extract", copied: 0, total: 0 });
		try {
			// Resolves only on failure — on success the app restarts. Backups made
			// before export encryption have no passphrase.
			await invoke(
				"import_data_folder",
				passphrase ? { archive, passphrase } : { archive }
			);
		} catch (e) {
			setBusy(false);
			setProgress(null);
			sileo.error({ title: "Restore failed", description: String(e) });
		}
	}, [pendingRestore, restorePassphrase]);

	const progressPct =
		progress && progress.total > 0
			? Math.min(100, Math.round((progress.copied / progress.total) * 100))
			: null;

	const progressStyle: PreviewStyle = {
		"--settings-preview-progress": `${progressPct ?? 10}%`,
	};
	let changeLocationBody: ReactNode;
	if (progress) {
		changeLocationBody = (
			<div className="flex flex-col gap-1.5">
				<div className="text-muted-foreground text-xs tabular-nums">
					{progress.phase === "extract" ? "Restoring" : "Copying"}…
					{progressPct === null ? "" : ` ${progressPct}%`}
				</div>
				<div className="h-2 w-full overflow-hidden rounded-full bg-muted">
					<div
						className={`h-full bg-primary transition-[width] motion-reduce:transition-none ${previewStyles.progress}`}
						style={progressStyle}
					/>
				</div>
				<div className="text-muted-foreground text-xs">
					The app will restart automatically when finished.
				</div>
			</div>
		);
	} else if (picked) {
		changeLocationBody = (
			<div className="flex flex-col gap-3">
				<div className="break-all text-sm">{picked.path}</div>
				{picked.validation.ok ? (
					<div className="text-muted-foreground text-xs">
						{humanBytes(picked.validation.source_size_bytes)} to copy ·{" "}
						{humanBytes(picked.validation.target_free_bytes)} free at target
					</div>
				) : (
					<div className="text-status-destructive text-xs">
						{picked.validation.error}
					</div>
				)}
				<div className="flex flex-wrap gap-2">
					<Button
						disabled={busy || !picked.validation.ok}
						onClick={() => {
							doMigrate().catch(() => undefined);
						}}
						size="sm"
					>
						Copy data &amp; restart
					</Button>
					<Button
						disabled={busy || !picked.validation.ok}
						onClick={() => {
							doSwitch().catch(() => undefined);
						}}
						size="sm"
						variant="ghost"
					>
						Start fresh here
					</Button>
					<Button
						disabled={busy}
						onClick={() => setPicked(null)}
						size="sm"
						variant="ghost"
					>
						Cancel
					</Button>
				</div>
			</div>
		);
	} else {
		changeLocationBody = null;
	}

	return (
		<div className="flex flex-col gap-6">
			<SettingsSection
				caption="Where Ryu stores everything on this device: chats, spaces, memory, models and downloaded engines. Relocate it to put large model files on another disk."
				title="Data folder"
			>
				{loadFailed ? (
					<SettingsCard className="flex items-center justify-between gap-3">
						<p className="text-muted-foreground text-sm">
							We couldn't load your data folder details. Please check your
							connection and try again.
						</p>
						<Button onClick={() => refresh()} size="sm" variant="outline">
							Retry
						</Button>
					</SettingsCard>
				) : (
					<SettingsGroup>
						<SettingsItem title="Current location">
							<p className="break-all pb-1 font-mono text-muted-foreground text-xs">
								{info?.current ?? "Loading…"}
							</p>
						</SettingsItem>
						<SettingsItem
							actions={
								<span className="text-muted-foreground text-sm">
									{info
										? `${humanBytes(info.size_bytes)} used · ${humanBytes(info.free_space_bytes)} free on this drive`
										: "—"}
								</span>
							}
							title="Size"
						/>
						{canUseNativeShell && info?.is_custom ? (
							<SettingsItem
								actions={
									<Button
										disabled={busy}
										onClick={() => {
											doReset().catch(() => undefined);
										}}
										size="sm"
										variant="ghost"
									>
										Reset to default
									</Button>
								}
								title="Default location"
							>
								<p className="break-all pb-1 font-mono text-muted-foreground text-xs">
									{info.default}
								</p>
							</SettingsItem>
						) : null}
					</SettingsGroup>
				)}
			</SettingsSection>

			{canUseNativeShell ? (
				<>
					<SettingsSection
						caption="Pick a new folder, then choose to copy your existing data over or start fresh. The app restarts to apply."
						title="Change location"
					>
						{changeLocationBody ? (
							<SettingsCard className="flex flex-col gap-3">
								{changeLocationBody}
							</SettingsCard>
						) : (
							<SettingsGroup>
								<SettingsItem
									actions={
										<Button
											disabled={busy}
											onClick={() => {
												pickFolder().catch(() => undefined);
											}}
											size="sm"
											variant="ghost"
										>
											Choose folder…
										</Button>
									}
									title="New location"
								/>
							</SettingsGroup>
						)}
					</SettingsSection>

					<SettingsSection
						caption="Give another profile a copy of this one's data. For example, hand canary your stable chats, spaces and agents so you can test against real state instead of rebuilding it by hand. Both profiles stay usable; nothing here changes where THIS profile reads from. A copy is refused if that profile already has data."
						title="Copy to another profile"
					>
						<SettingsGroup>
							{PROFILE_COPY_TARGETS.map((target) => (
								<SettingsItem
									actions={
										<span className="flex items-center gap-2">
											<span className="font-mono text-muted-foreground text-xs">
												~/.ryu-{target}
											</span>
											<Button
												disabled={busy}
												onClick={() => setPendingProfileCopy(target)}
												size="sm"
												variant="ghost"
											>
												Copy
											</Button>
										</span>
									}
									key={target}
									title={`Copy to ${target}`}
								/>
							))}
						</SettingsGroup>
					</SettingsSection>

					<SettingsSection
						caption="Export an encrypted backup of the whole data folder, or restore from one. The backup is locked with a passphrase you choose; without it the backup cannot be restored. Restoring overwrites the current data and restarts the app."
						title="Backup &amp; restore"
					>
						<SettingsGroup>
							<SettingsItem
								actions={
									<Button
										disabled={busy}
										onClick={() => setExportDialogOpen(true)}
										size="sm"
										variant="ghost"
									>
										Export…
									</Button>
								}
								title="Export backup"
							>
								<p className="pb-1 text-muted-foreground text-xs">
									Save a passphrase-encrypted zip of all your Ryu data.
								</p>
							</SettingsItem>
							<SettingsItem
								actions={
									<Button
										disabled={busy}
										onClick={() => {
											doImport().catch(() => undefined);
										}}
										size="sm"
										variant="ghost"
									>
										Restore…
									</Button>
								}
								title="Restore backup"
							>
								<p className="pb-1 text-muted-foreground text-xs">
									Replace current data with a backup zip.
								</p>
							</SettingsItem>
						</SettingsGroup>
					</SettingsSection>
				</>
			) : null}

			<NodeBackupSettings />
			<UploadCeilingSection />

			<AlertDialog
				onOpenChange={(nextOpen) => {
					if (!nextOpen) {
						setPendingProfileCopy(null);
					}
				}}
				open={pendingProfileCopy !== null}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							Copy this profile&apos;s data to {pendingProfileCopy}?
						</AlertDialogTitle>
						<AlertDialogDescription>
							Ryu will stop, copy your chats, spaces, agents, memory and models
							into the {pendingProfileCopy} profile, and carry your encryption
							key across so the copy stays readable. This profile is left
							exactly as it is.
						</AlertDialogDescription>
						{/* The three things a user would otherwise discover the hard way,
						    stated before the irreversible step. Each corresponds to an
						    explicit exclusion or refusal in `data_path::copy_profile`. */}
						<AlertDialogDescription>
							Not copied: this node&apos;s identity and sign-in, its saved node
							list, and the downloaded binaries, so {pendingProfileCopy} runs
							its own build rather than adopting this one&apos;s. If that
							profile already has data, the copy is refused rather than merged.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
						<AlertDialogAction
							disabled={busy}
							onClick={() => {
								if (pendingProfileCopy) {
									void doProfileCopy(pendingProfileCopy);
								}
							}}
						>
							{busy ? "Copying…" : "Copy"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			<AlertDialog
				onOpenChange={(nextOpen) => {
					if (!nextOpen) {
						closeExportDialog();
					}
				}}
				open={exportDialogOpen}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Encrypt this backup</AlertDialogTitle>
						<AlertDialogDescription>
							The backup holds all of your data, including saved credentials, so
							Ryu encrypts it with a passphrase. You need the same passphrase to
							restore it, and it cannot be recovered if you lose it.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<div className="grid gap-3">
						<div className="grid gap-2">
							<Label htmlFor="storage-export-passphrase">
								Backup passphrase
							</Label>
							<Input
								autoComplete="new-password"
								id="storage-export-passphrase"
								onChange={(event) => setExportPassphrase(event.target.value)}
								type="password"
								value={exportPassphrase}
							/>
						</div>
						<div className="grid gap-2">
							<Label htmlFor="storage-export-passphrase-confirm">
								Confirm passphrase
							</Label>
							<Input
								autoComplete="new-password"
								id="storage-export-passphrase-confirm"
								onChange={(event) => setExportConfirm(event.target.value)}
								type="password"
								value={exportConfirm}
							/>
						</div>
						{exportPassphrase && exportPassphraseError ? (
							<p className="text-muted-foreground text-xs" role="status">
								{exportPassphraseError}
							</p>
						) : null}
					</div>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							disabled={exportPassphraseError !== null}
							onClick={(e) => {
								e.preventDefault();
								doExport().catch(() => undefined);
							}}
						>
							Choose location…
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			<AlertDialog
				onOpenChange={(nextOpen) => {
					if (!nextOpen) {
						setPendingRestore(null);
						setRestorePassphrase("");
					}
				}}
				open={pendingRestore !== null}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Restore from this backup?</AlertDialogTitle>
						<AlertDialogDescription>
							This replaces all of your current data (chats, spaces, memory,
							models and downloaded engines) with the contents of the backup,
							then restarts the app. This cannot be undone.
						</AlertDialogDescription>
						{/* The encryption key lives in the OS keychain, never in the zip.
						    Restoring on a different machine or OS user therefore produces
						    a node that boots and looks healthy while every message body,
						    memory entry and plugin secret is unreadable — and there is no
						    rekey path to recover it. Saying so here is the only place a
						    user can still act on it. */}
						<AlertDialogDescription>
							<span className="text-status-warning">
								Your encryption key is stored in this machine&apos;s keychain,
								not in the backup. If this zip came from another machine or
								another user account, chats, memory and plugin secrets will
								restore but stay permanently unreadable.
							</span>
						</AlertDialogDescription>
					</AlertDialogHeader>
					{pendingRestore ? (
						<div className="break-all rounded-md bg-muted p-3 text-sm">
							{pendingRestore}
						</div>
					) : null}
					<div className="grid gap-2">
						<Label htmlFor="storage-restore-passphrase">
							Backup passphrase
						</Label>
						<Input
							autoComplete="off"
							id="storage-restore-passphrase"
							onChange={(event) => setRestorePassphrase(event.target.value)}
							type="password"
							value={restorePassphrase}
						/>
						<p className="text-muted-foreground text-xs">
							Leave empty only for a backup made before backups were encrypted.
						</p>
					</div>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={(e) => {
								// Keep the dialog controlled by state; runImport closes it.
								e.preventDefault();
								runImport().catch(() => undefined);
							}}
							variant="destructive"
						>
							Restore &amp; restart
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
