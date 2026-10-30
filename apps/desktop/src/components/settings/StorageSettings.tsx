// Storage settings tab: view + relocate the Ryu data folder, and back it up /
// restore it. All path logic lives in Core (`crate::data_path`); this tab reads
// the state, validates a target, and triggers either a point-only switch (Core
// API) or a copy-migrate / import (offline `ryu-core data-path` subcommand
// orchestrated by the `migrate_data_folder` / `import_data_folder` Tauri
// commands, which restart the app to apply).

import { useLiteralMessages } from "@ryu/i18n/react";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { useCallback, useEffect, useRef, useState } from "react";
import { sileo } from "sileo";
import { getRyuStatus, startRyuCore } from "@/lib/tauri-bridge.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import {
	type DataPathInfo,
	exportDataPath,
	getDataPath,
	resetDataPath,
	switchDataPath,
	validateDataPath,
} from "@/src/lib/api/data-path.ts";
import {
	fetchParseCapability,
	type ParseCapability,
} from "@/src/lib/api/documents.ts";
import { formatBytes, NODE_UPLOAD_MAX_BYTES } from "@/src/lib/api/spaces.ts";
import { listenWhenReady } from "@/src/lib/tauri-ready.ts";
import { NodeBackupSettings } from "./BackupSettings.tsx";
import { DataFolderSection } from "./StorageSettings-data-folder-section.tsx";
import {
	ExportBackupDialog,
	ProfileCopyDialog,
	RestoreBackupDialog,
} from "./StorageSettings-dialogs.tsx";
import {
	humanBytes,
	MIN_BACKUP_PASSPHRASE_CHARS,
	type PickedTarget,
	type ProgressState,
	useSelectedNodeTarget,
} from "./StorageSettings-model.ts";
import {
	NativeStorageSections,
	renderChangeLocationBody,
} from "./StorageSettings-native-sections.tsx";

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

export function StorageSettings() {
	const { canUseNativeShell } = useAppSurface();
	const tl = useLiteralMessages();
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

	const doProfileCopy = useCallback(
		async (toProfile: string) => {
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
					title: tl("Copied to the {toProfile} profile", { toProfile }),
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
		},
		[tl]
	);

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
				description: tl("{size} written to {dest}", {
					size: humanBytes(res.bytes ?? 0),
					dest,
				}),
			});
		} catch (e) {
			sileo.error({ title: "Backup failed", description: String(e) });
		} finally {
			setBusy(false);
		}
	}, [closeExportDialog, exportPassphrase, target, tl]);

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

	const changeLocationBody = renderChangeLocationBody({
		busy,
		doMigrate,
		doSwitch,
		picked,
		progress,
		setPicked,
		tl,
	});

	return (
		<div className="flex flex-col gap-6">
			<DataFolderSection
				busy={busy}
				canUseNativeShell={canUseNativeShell}
				doReset={doReset}
				info={info}
				loadFailed={loadFailed}
				refresh={refresh}
			/>

			{canUseNativeShell ? (
				<NativeStorageSections
					busy={busy}
					changeLocationBody={changeLocationBody}
					doImport={doImport}
					pickFolder={pickFolder}
					setExportDialogOpen={setExportDialogOpen}
					setPendingProfileCopy={setPendingProfileCopy}
				/>
			) : null}

			<NodeBackupSettings />
			<UploadCeilingSection />

			<ProfileCopyDialog
				busy={busy}
				doProfileCopy={doProfileCopy}
				pendingProfileCopy={pendingProfileCopy}
				setPendingProfileCopy={setPendingProfileCopy}
			/>

			<ExportBackupDialog
				closeExportDialog={closeExportDialog}
				doExport={doExport}
				exportConfirm={exportConfirm}
				exportDialogOpen={exportDialogOpen}
				exportPassphrase={exportPassphrase}
				exportPassphraseError={exportPassphraseError}
				setExportConfirm={setExportConfirm}
				setExportPassphrase={setExportPassphrase}
			/>

			<RestoreBackupDialog
				pendingRestore={pendingRestore}
				restorePassphrase={restorePassphrase}
				runImport={runImport}
				setPendingRestore={setPendingRestore}
				setRestorePassphrase={setRestorePassphrase}
			/>
		</div>
	);
}
