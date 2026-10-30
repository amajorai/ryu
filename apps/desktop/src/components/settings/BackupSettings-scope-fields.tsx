import { Label } from "@ryu/ui/components/label.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import type { BackupOverview } from "@/src/lib/api/backups.ts";

export function BackupScopeFields({
	id,
	busy,
	overview,
	destinationId,
	setDestinationId,
	spaceId,
	selection,
	setSelection,
	spaces,
}: {
	id: string;
	busy: boolean;
	overview: BackupOverview;
	destinationId: string;
	setDestinationId: (value: string) => void;
	spaceId?: string;
	selection: string;
	setSelection: (value: string) => void;
	spaces: ReadonlyArray<{ id: string; name: string }>;
}) {
	return (
		<>
			<div className="grid gap-4 sm:grid-cols-2">
				<div className="grid gap-2">
					<Label htmlFor={`${id}-destination`}>Destination</Label>
					<NativeSelect
						disabled={busy}
						id={`${id}-destination`}
						onChange={(event) => setDestinationId(event.target.value)}
						value={destinationId}
					>
						{overview.destinations.map((d) => (
							<NativeSelectOption key={d.id} value={d.id}>
								{d.name}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</div>
				<div className="grid gap-2">
					<Label htmlFor={`${id}-scope`}>Back up</Label>
					<NativeSelect
						disabled={Boolean(spaceId) || busy}
						id={`${id}-scope`}
						onChange={(event) => setSelection(event.target.value)}
						value={selection}
					>
						{!spaceId && (
							<NativeSelectOption value="node">Entire node</NativeSelectOption>
						)}
						{spaceId && !spaces.some((s) => s.id === spaceId) && (
							<NativeSelectOption value={spaceId}>
								This Space
							</NativeSelectOption>
						)}
						{spaces.map((space) => (
							<NativeSelectOption key={space.id} value={space.id}>
								{space.name}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</div>
			</div>
			<p className="text-muted-foreground text-xs">
				{selection === "node"
					? "Includes durable node data and files. Databases are snapshotted consistently; downloaded runtimes, caches, and node access tokens are excluded."
					: "Includes pages, databases, whiteboards, app documents, and files. Restores create a new private Space."}
			</p>
		</>
	);
}
