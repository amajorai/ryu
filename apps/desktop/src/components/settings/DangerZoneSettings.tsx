// Settings → Danger Zone. Irreversible bulk "delete all X" actions for the user
// data Core holds on this node: chats, spaces, long-term memory, website
// monitors, and meetings. Purely a visual layer — every delete is performed by
// Core (`/api/data/clear`, see apps/core/src/server/data_admin.rs). Each action
// is guarded by a type-to-confirm dialog and shows a live item count first.

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
import { Input } from "@ryu/ui/components/input";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { sileo } from "sileo";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useActiveNodeGetter } from "@/src/hooks/useActiveNode.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	clearDataCategory,
	type DataCategory,
	type DataCounts,
	fetchDataCounts,
} from "@/src/lib/api/data-admin.ts";

interface CategoryDef {
	/** The exact word the user must type to arm this delete (e.g. "Meetings"). */
	confirmWord: string;
	/** What exactly gets removed, shown in the dialog. */
	detail: string;
	key: DataCategory;
	/** Noun for the live count line and confirmation copy. */
	noun: string;
	/** The destructive button + dialog title. */
	title: string;
}

const CATEGORIES: CategoryDef[] = [
	{
		key: "chats",
		title: "Delete all chats",
		noun: "chats",
		confirmWord: "Chats",
		detail:
			"Every conversation and all of its messages will be permanently deleted.",
	},
	{
		key: "spaces",
		title: "Delete all spaces",
		noun: "spaces",
		confirmWord: "Spaces",
		detail:
			"Every Space, including all of its documents and their search data, will be permanently deleted. The hidden Meetings space is left untouched.",
	},
	{
		key: "memory",
		title: "Clear all memory",
		noun: "memory entries",
		confirmWord: "Memory",
		detail: "Every long-term memory entry will be permanently forgotten.",
	},
	{
		key: "monitors",
		title: "Delete all monitors",
		noun: "monitors",
		confirmWord: "Monitors",
		detail:
			"Every website monitor will be deleted and its scheduled checks will stop.",
	},
	{
		key: "meetings",
		title: "Delete all meetings",
		noun: "meetings",
		confirmWord: "Meetings",
		detail:
			"Every meeting record and its transcript will be permanently deleted.",
	},
];

export function DangerZoneSettings() {
	const getNode = useActiveNodeGetter();
	const queryClient = useQueryClient();
	const [active, setActive] = useState<CategoryDef | null>(null);
	const [typed, setTyped] = useState("");
	const [busy, setBusy] = useState(false);

	const {
		data: counts,
		isPending,
		isError,
		refetch,
	} = useQuery<DataCounts>({
		queryKey: ["data-counts", getNode().url],
		queryFn: () => fetchDataCounts(toTarget(getNode())),
	});

	const openConfirm = (def: CategoryDef) => {
		setTyped("");
		setActive(def);
	};

	const countFor = (key: DataCategory): number => counts?.[key] ?? 0;

	const runClear = async () => {
		if (!active) {
			return;
		}
		setBusy(true);
		try {
			const removed = await clearDataCategory(toTarget(getNode()), active.key);
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
		typed.trim().toLowerCase() === active.confirmWord.toLowerCase();

	return (
		<div className="flex flex-col gap-6">
			<SettingsSection
				caption="Permanently delete data Ryu stores on this node. These actions cannot be undone — export a backup from Storage first if you might want it back."
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
							variant="outline"
						>
							Retry
						</Button>
					</div>
				) : (
					<SettingsGroup>
						{CATEGORIES.map((def) => {
							const n = countFor(def.key);
							let description: string;
							if (isPending) {
								description = "Loading…";
							} else {
								description = n === 0 ? `No ${def.noun}` : `${n} ${def.noun}`;
							}
							return (
								<SettingsItem
									actions={
										<Button
											disabled={isPending || n === 0}
											onClick={() => openConfirm(def)}
											size="sm"
											variant="destructive"
										>
											{def.title}
										</Button>
									}
									description={description}
									key={def.key}
									title={def.title}
								/>
							);
						})}
					</SettingsGroup>
				)}
			</SettingsSection>

			<AlertDialog
				onOpenChange={(open) => {
					if (!open) {
						setActive(null);
					}
				}}
				open={active !== null}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{active?.title}?</AlertDialogTitle>
						<AlertDialogDescription>
							{active
								? `This will delete ${countFor(active.key)} ${active.noun}. ${active.detail} This cannot be undone.`
								: ""}
						</AlertDialogDescription>
					</AlertDialogHeader>

					<div className="flex flex-col gap-1.5">
						<span className="text-muted-foreground text-xs">
							Type{" "}
							<span className="font-medium text-foreground">
								{active?.confirmWord}
							</span>{" "}
							to confirm.
						</span>
						<Input
							autoComplete="off"
							onChange={(e) => setTyped(e.target.value)}
							placeholder={active?.confirmWord}
							value={typed}
						/>
					</div>

					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							disabled={!armed || busy}
							onClick={(e) => {
								// Keep the dialog open while the request runs; close on success.
								e.preventDefault();
								runClear().catch(() => undefined);
							}}
							variant="destructive"
						>
							{busy ? "Deleting…" : "Delete"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
