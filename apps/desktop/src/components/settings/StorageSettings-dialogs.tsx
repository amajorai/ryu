import { useLiteralMessages } from "@ryu/i18n/react";
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
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";

export function ProfileCopyDialog({
	busy,
	doProfileCopy,
	pendingProfileCopy,
	setPendingProfileCopy,
}: {
	busy: boolean;
	doProfileCopy: (toProfile: string) => Promise<void>;
	pendingProfileCopy: string | null;
	setPendingProfileCopy: (next: string | null) => void;
}) {
	const tl = useLiteralMessages();
	return (
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
						{tl("Copy this profile's data to {pendingProfileCopy}?", {
							pendingProfileCopy: pendingProfileCopy ?? "",
						})}
					</AlertDialogTitle>
					<AlertDialogDescription>
						{tl(
							"Ryu will stop, copy your chats, spaces, agents, memory and models into the {pendingProfileCopy} profile, and carry your encryption key across so the copy stays readable. This profile is left exactly as it is.",
							{ pendingProfileCopy: pendingProfileCopy ?? "" }
						)}
					</AlertDialogDescription>
					{/* The three things a user would otherwise discover the hard way,
					    stated before the irreversible step. Each corresponds to an
					    explicit exclusion or refusal in `data_path::copy_profile`. */}
					<AlertDialogDescription>
						{tl(
							"Not copied: this node's identity and sign-in, its saved node list, and the downloaded binaries, so {pendingProfileCopy} runs its own build rather than adopting this one's. If that profile already has data, the copy is refused rather than merged.",
							{ pendingProfileCopy: pendingProfileCopy ?? "" }
						)}
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
	);
}

export function ExportBackupDialog({
	closeExportDialog,
	doExport,
	exportConfirm,
	exportDialogOpen,
	exportPassphrase,
	exportPassphraseError,
	setExportConfirm,
	setExportPassphrase,
}: {
	closeExportDialog: () => void;
	doExport: () => Promise<void>;
	exportConfirm: string;
	exportDialogOpen: boolean;
	exportPassphrase: string;
	exportPassphraseError: string | null;
	setExportConfirm: (next: string) => void;
	setExportPassphrase: (next: string) => void;
}) {
	return (
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
						<Label htmlFor="storage-export-passphrase">Backup passphrase</Label>
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
	);
}

export function RestoreBackupDialog({
	pendingRestore,
	restorePassphrase,
	runImport,
	setPendingRestore,
	setRestorePassphrase,
}: {
	pendingRestore: string | null;
	restorePassphrase: string;
	runImport: () => Promise<void>;
	setPendingRestore: (next: string | null) => void;
	setRestorePassphrase: (next: string) => void;
}) {
	return (
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
						models and downloaded engines) with the contents of the backup, then
						restarts the app. This cannot be undone.
					</AlertDialogDescription>
					{/* The encryption key lives in the OS keychain, never in the zip.
					    Restoring on a different machine or OS user therefore produces
					    a node that boots and looks healthy while every message body,
					    memory entry and plugin secret is unreadable — and there is no
					    rekey path to recover it. Saying so here is the only place a
					    user can still act on it. */}
					<AlertDialogDescription>
						<span className="text-status-warning">
							Your encryption key is stored in this machine&apos;s keychain, not
							in the backup. If this zip came from another machine or another
							user account, chats, memory and plugin secrets will restore but
							stay permanently unreadable.
						</span>
					</AlertDialogDescription>
				</AlertDialogHeader>
				{pendingRestore ? (
					<div className="break-all rounded-md bg-muted p-3 text-sm">
						{pendingRestore}
					</div>
				) : null}
				<div className="grid gap-2">
					<Label htmlFor="storage-restore-passphrase">Backup passphrase</Label>
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
	);
}
