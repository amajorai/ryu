import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import type { ApiTarget } from "@ryuhq/core-client/client.ts";
import {
	type BackupDestination,
	type BackupOverview,
	type BackupRecord,
	deleteBackupDestination,
	deleteBackupPolicy,
	restoreBackup,
} from "@/src/lib/api/backups.ts";
import type { BackupAct } from "./BackupSettings-shared.ts";

export function BackupConfirmDialogs({
	restore,
	setRestore,
	remove,
	setRemove,
	busy,
	act,
	targetRef,
	destinationId,
	overview,
}: {
	restore: BackupRecord | null;
	setRestore: (record: BackupRecord | null) => void;
	remove: BackupDestination | null;
	setRemove: (destination: BackupDestination | null) => void;
	busy: boolean;
	act: BackupAct;
	targetRef: { current: ApiTarget };
	destinationId: string;
	overview: BackupOverview;
}) {
	return (
		<>
			<Dialog
				onOpenChange={(open) => {
					if (!open) {
						setRestore(null);
					}
				}}
				open={Boolean(restore)}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							{restore?.scope.kind === "node"
								? "Prepare node recovery"
								: "Restore Space"}
						</DialogTitle>
						<DialogDescription>
							{restore?.scope.kind === "node"
								? "Ryu will verify and extract this backup into a new recovery folder. Your running node stays intact. The completed operation shows how to start the recovered node."
								: "Ryu will restore the backup into a new private Space and rebuild its search index. Your original Space stays intact."}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button onClick={() => setRestore(null)} variant="ghost">
							Cancel
						</Button>
						<Button
							disabled={busy}
							onClick={() => {
								if (!restore) {
									return;
								}
								const record = restore;
								setRestore(null);
								act(
									() =>
										restoreBackup(targetRef.current, {
											destinationId,
											backupId: record.id,
											idempotencyKey: crypto.randomUUID(),
										}),
									"Restore queued. Progress appears below."
								).catch(() => undefined);
							}}
						>
							Restore backup
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			<Dialog
				onOpenChange={(open) => {
					if (!open) {
						setRemove(null);
					}
				}}
				open={Boolean(remove)}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Remove destination</DialogTitle>
						<DialogDescription>
							This removes the destination and its schedules from Ryu. Backups
							already in S3 stay in the bucket.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button onClick={() => setRemove(null)} variant="ghost">
							Cancel
						</Button>
						<Button
							disabled={busy}
							onClick={() => {
								if (!remove) {
									return;
								}
								const destination = remove;
								setRemove(null);
								act(async () => {
									for (const policy of overview.policies.filter(
										(p) => p.destinationId === destination.id
									)) {
										await deleteBackupPolicy(targetRef.current, policy.id);
									}
									await deleteBackupDestination(
										targetRef.current,
										destination.id
									);
								}, "Destination removed. S3 backups were kept.").catch(
									() => undefined
								);
							}}
							variant="destructive"
						>
							Remove destination
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
