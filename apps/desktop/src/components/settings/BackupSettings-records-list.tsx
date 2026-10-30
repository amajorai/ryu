import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import type { BackupRecord } from "@/src/lib/api/backups.ts";
import { formatDateTime } from "@/src/lib/timezone.ts";
import { bytes, scopeLabel } from "./BackupSettings-shared.ts";
import { SettingsCard } from "./shared/settings-items.tsx";

export function BackupRecordsList({
	records,
	busy,
	running,
	setRestore,
}: {
	records: BackupRecord[];
	busy: boolean;
	running: boolean;
	setRestore: (record: BackupRecord | null) => void;
}) {
	const tl = useLiteralMessages();
	return (
		<div className="grid gap-3">
			<h3 className="font-medium text-sm">Backups in S3</h3>
			{records.length === 0 && (
				<p className="text-muted-foreground text-sm">
					No backups found for this selection.
				</p>
			)}
			{records.slice(0, 100).map((record) => (
				<SettingsCard key={record.id}>
					<div className="flex flex-wrap items-center justify-between gap-3">
						<div>
							<p className="text-sm">
								{scopeLabel(record.scope)} · {formatDateTime(record.createdAt)}
							</p>
							<p className="mt-1 text-muted-foreground text-xs">
								{tl("{size} · Encrypted", { size: bytes(record.bytes) })}
							</p>
						</div>
						<Button
							disabled={busy || running || record.scope.kind === "app"}
							onClick={() => setRestore(record)}
							size="sm"
							variant="outline"
						>
							Restore
						</Button>
					</div>
				</SettingsCard>
			))}
		</div>
	);
}
