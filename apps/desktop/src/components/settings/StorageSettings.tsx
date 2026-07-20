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
} from "@ryu/ui/components/alert-dialog";
import { Button } from "@ryu/ui/components/button";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { sileo } from "sileo";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useActiveNodeGetter } from "@/src/hooks/useActiveNode.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	type DataPathInfo,
	exportDataPath,
	getDataPath,
	resetDataPath,
	switchDataPath,
	type ValidateResult,
	validateDataPath,
} from "@/src/lib/api/data-path.ts";

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

interface ProgressState {
	copied: number;
	phase: string;
	total: number;
}

export function StorageSettings() {
	const getNode = useActiveNodeGetter();
	const [info, setInfo] = useState<DataPathInfo | null>(null);
	const [picked, setPicked] = useState<PickedTarget | null>(null);
	const [busy, setBusy] = useState(false);
	const [progress, setProgress] = useState<ProgressState | null>(null);
	const [pendingRestore, setPendingRestore] = useState<string | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);

	const refresh = useCallback(() => {
		setLoadFailed(false);
		getDataPath(toTarget(getNode()))
			.then((next) => {
				setInfo(next);
				setLoadFailed(false);
			})
			.catch(() => {
				setInfo(null);
				setLoadFailed(true);
			});
	}, [getNode]);

	useEffect(() => {
		refresh();
	}, [refresh]);

	// Stream copy/extract progress from the offline subcommand.
	useEffect(() => {
		const unlisten = listen<{
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
	}, []);

	const pickFolder = useCallback(async () => {
		const selected = await open({ directory: true, multiple: false });
		if (typeof selected !== "string") {
			return;
		}
		const validation = await validateDataPath(toTarget(getNode()), selected);
		setPicked({ path: selected, validation });
	}, [getNode]);

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
			const res = await switchDataPath(toTarget(getNode()), picked.path);
			if (!res.ok) {
				throw new Error(res.error ?? "switch failed");
			}
			await relaunch();
		} catch (e) {
			setBusy(false);
			sileo.error({ title: "Could not switch folder", description: String(e) });
		}
	}, [getNode, picked]);

	const doReset = useCallback(async () => {
		setBusy(true);
		try {
			const res = await resetDataPath(toTarget(getNode()));
			if (!res.ok) {
				throw new Error(res.error ?? "reset failed");
			}
			await relaunch();
		} catch (e) {
			setBusy(false);
			sileo.error({ title: "Could not reset folder", description: String(e) });
		}
	}, [getNode]);

	const doExport = useCallback(async () => {
		const dest = await save({
			defaultPath: "ryu-data-backup.zip",
			filters: [{ name: "Zip archive", extensions: ["zip"] }],
		});
		if (!dest) {
			return;
		}
		setBusy(true);
		try {
			const res = await exportDataPath(toTarget(getNode()), dest);
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
	}, [getNode]);

	const doImport = useCallback(async () => {
		const archive = await open({
			multiple: false,
			filters: [{ name: "Zip archive", extensions: ["zip"] }],
		});
		if (typeof archive !== "string") {
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
		setPendingRestore(null);
		setBusy(true);
		setProgress({ phase: "extract", copied: 0, total: 0 });
		try {
			// Resolves only on failure — on success the app restarts.
			await invoke("import_data_folder", { archive });
		} catch (e) {
			setBusy(false);
			setProgress(null);
			sileo.error({ title: "Restore failed", description: String(e) });
		}
	}, [pendingRestore]);

	const progressPct =
		progress && progress.total > 0
			? Math.min(100, Math.round((progress.copied / progress.total) * 100))
			: null;

	let changeLocationBody: ReactNode;
	if (progress) {
		changeLocationBody = (
			<div className="flex flex-col gap-1.5">
				<div className="text-muted-foreground text-xs">
					{progress.phase === "extract" ? "Restoring" : "Copying"}…
					{progressPct === null ? "" : ` ${progressPct}%`}
				</div>
				<div className="h-2 w-full overflow-hidden rounded-full bg-muted">
					<div
						className="h-full bg-primary transition-all"
						style={{ width: `${progressPct ?? 10}%` }}
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
					<div className="text-destructive text-xs">
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
						variant="outline"
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
		changeLocationBody = (
			<Button
				className="self-start"
				disabled={busy}
				onClick={() => {
					pickFolder().catch(() => undefined);
				}}
				size="sm"
				variant="outline"
			>
				Choose folder…
			</Button>
		);
	}

	return (
		<div className="flex flex-col gap-6">
			<SettingsSection
				caption="Where Ryu stores everything on this device: chats, spaces, memory, models and downloaded engines. Relocate it to put large model files on another disk."
				title="Data folder"
			>
				{loadFailed ? (
					<div className="flex flex-col items-start gap-3 rounded-md bg-muted p-4">
						<p className="text-muted-foreground text-sm">
							We couldn't load your data folder details. Please check your
							connection and try again.
						</p>
						<Button onClick={() => refresh()} size="sm" variant="outline">
							Retry
						</Button>
					</div>
				) : (
					<SettingsGroup>
						<SettingsItem
							description={info?.current ?? "Loading…"}
							title="Current location"
						/>
						<SettingsItem
							description={
								info
									? `${humanBytes(info.size_bytes)} used · ${humanBytes(info.free_space_bytes)} free on this drive`
									: "—"
							}
							title="Size"
						/>
						{info?.is_custom ? (
							<SettingsItem
								actions={
									<Button
										disabled={busy}
										onClick={() => {
											doReset().catch(() => undefined);
										}}
										size="sm"
										variant="outline"
									>
										Reset to default
									</Button>
								}
								description={info.default}
								title="Default location"
							/>
						) : null}
					</SettingsGroup>
				)}
			</SettingsSection>

			<SettingsSection
				caption="Pick a new folder, then choose to copy your existing data over or start fresh. The app restarts to apply."
				title="Change location"
			>
				<SettingsCard className="flex flex-col gap-3">
					{changeLocationBody}
				</SettingsCard>
			</SettingsSection>

			<SettingsSection
				caption="Export a zip backup of the whole data folder, or restore from one. Restoring overwrites the current data and restarts the app."
				title="Backup &amp; restore"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Button
								disabled={busy}
								onClick={() => {
									doExport().catch(() => undefined);
								}}
								size="sm"
								variant="outline"
							>
								Export…
							</Button>
						}
						description="Save a zip of all your Ryu data."
						title="Export backup"
					/>
					<SettingsItem
						actions={
							<Button
								disabled={busy}
								onClick={() => {
									doImport().catch(() => undefined);
								}}
								size="sm"
								variant="outline"
							>
								Restore…
							</Button>
						}
						description="Replace current data with a backup zip."
						title="Restore backup"
					/>
				</SettingsGroup>
			</SettingsSection>

			<AlertDialog
				onOpenChange={(nextOpen) => {
					if (!nextOpen) {
						setPendingRestore(null);
					}
				}}
				open={pendingRestore !== null}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Restore from this backup?</AlertDialogTitle>
						<AlertDialogDescription>
							This replaces all of your current data — chats, spaces, memory,
							models and downloaded engines — with the contents of the backup,
							then restarts the app. This cannot be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					{pendingRestore ? (
						<div className="break-all rounded-md bg-muted p-3 text-sm">
							{pendingRestore}
						</div>
					) : null}
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
