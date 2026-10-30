import type { LiteralMessage } from "@ryu/i18n/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import type { ReactNode } from "react";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import {
	humanBytes,
	type PickedTarget,
	PROFILE_COPY_TARGETS,
	type ProgressState,
} from "./StorageSettings-model.ts";
import previewStyles from "./settings-preview.module.css";
import type { PreviewStyle } from "./settings-preview-style.ts";

export function renderChangeLocationBody({
	busy,
	doMigrate,
	doSwitch,
	picked,
	progress,
	setPicked,
	tl,
}: {
	busy: boolean;
	doMigrate: () => Promise<void>;
	doSwitch: () => Promise<void>;
	picked: PickedTarget | null;
	progress: ProgressState | null;
	setPicked: (next: PickedTarget | null) => void;
	tl: LiteralMessage;
}): ReactNode {
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
						{tl("{size} to copy · {free} free at target", {
							size: humanBytes(picked.validation.source_size_bytes),
							free: humanBytes(picked.validation.target_free_bytes),
						})}
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
	return changeLocationBody;
}

export function NativeStorageSections({
	busy,
	changeLocationBody,
	doImport,
	pickFolder,
	setExportDialogOpen,
	setPendingProfileCopy,
}: {
	busy: boolean;
	changeLocationBody: ReactNode;
	doImport: () => Promise<void>;
	pickFolder: () => Promise<void>;
	setExportDialogOpen: (next: boolean) => void;
	setPendingProfileCopy: (next: string | null) => void;
}) {
	const tl = useLiteralMessages();
	return (
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
							title={tl("Copy to {target}", { target })}
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
	);
}
