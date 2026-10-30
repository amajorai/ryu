import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import type { ApiTarget } from "@ryuhq/core-client/client.ts";
import {
	type BackupDestination,
	type BackupOverview,
	testBackupDestination,
} from "@/src/lib/api/backups.ts";
import type { BackupAct } from "./BackupSettings-shared.ts";
import { SettingsCard } from "./shared/settings-items.tsx";

export function BackupDestinationList({
	overview,
	busy,
	act,
	targetRef,
	setEditing,
	setDialog,
	setRemove,
}: {
	overview: BackupOverview;
	busy: boolean;
	act: BackupAct;
	targetRef: { current: ApiTarget };
	setEditing: (destination: BackupDestination | undefined) => void;
	setDialog: (open: boolean) => void;
	setRemove: (destination: BackupDestination | null) => void;
}) {
	const tl = useLiteralMessages();
	return overview.destinations.length === 0 ? (
		<SettingsCard>
			<p className="text-sm">No S3 destinations yet</p>
			<p className="mt-1 text-muted-foreground text-sm">
				Connect a bucket to back up this node, individual Spaces, and approved
				apps.
			</p>
		</SettingsCard>
	) : (
		overview.destinations.map((destination) => (
			<SettingsCard key={destination.id}>
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div className="min-w-0">
						<p className="font-medium text-sm">{destination.name}</p>
						<p className="mt-1 break-all text-muted-foreground text-xs">
							{destination.bucket}
							{destination.prefix ? ` / ${destination.prefix}` : ""} ·{" "}
							{destination.region}
						</p>
						<p className="mt-1 text-muted-foreground text-xs">
							{destination.allowedApps.length
								? tl(
										"{count, plural, one {# approved app} other {# approved apps}}",
										{ count: destination.allowedApps.length }
									)
								: "No app access"}
						</p>
					</div>
					<div className="flex gap-1">
						<Button
							disabled={busy}
							onClick={() => {
								act(
									() =>
										testBackupDestination(targetRef.current, destination.id),
									"Connection verified: read, write, list and delete passed."
								).catch(() => undefined);
							}}
							size="sm"
							variant="ghost"
						>
							Test
						</Button>
						<Button
							disabled={busy}
							onClick={() => {
								setEditing(destination);
								setDialog(true);
							}}
							size="sm"
							variant="ghost"
						>
							Edit
						</Button>
						<Button
							disabled={busy}
							onClick={() => setRemove(destination)}
							size="sm"
							variant="ghost"
						>
							Remove
						</Button>
					</div>
				</div>
			</SettingsCard>
		))
	);
}
