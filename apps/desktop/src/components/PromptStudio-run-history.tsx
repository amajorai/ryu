// Prompt Studio: saved run chips with rename / duplicate / compare / delete.

import {
	Copy01Icon,
	Delete02Icon,
	Edit02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { useState } from "react";
import type { PromptRunMeta } from "@/src/lib/api/prompt-suites.ts";

export function PromptRunHistory({
	onCompare,
	onDelete,
	onDuplicate,
	onRename,
	onSelect,
	runs,
	selectedRunId,
}: {
	onCompare: (runId: string) => Promise<void>;
	onDelete: (runId: string) => Promise<void>;
	onDuplicate: (runId: string) => Promise<void>;
	onRename: (runId: string, name: string) => Promise<void>;
	onSelect: (runId: string) => Promise<void>;
	runs: PromptRunMeta[];
	selectedRunId: string | null;
}) {
	const tl = useLiteralMessages();
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editingName, setEditingName] = useState("");
	const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
	if (runs.length === 0) {
		return null;
	}
	return (
		<div className="flex flex-wrap items-center gap-1.5 rounded-lg bg-muted/20 p-2">
			<span className="type-caption mr-1 font-medium">Runs</span>
			{runs.slice(0, 8).map((run) => (
				<div className="flex items-center gap-0.5" key={run.id}>
					{editingId === run.id ? (
						<>
							<Input
								aria-label={tl("Rename {name}", { name: run.name })}
								className="w-44"
								onChange={(event) => setEditingName(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter") {
										onRename(run.id, editingName).catch(() => undefined);
										setEditingId(null);
									}
									if (event.key === "Escape") {
										setEditingId(null);
									}
								}}
								size="caption"
								value={editingName}
							/>
							<Button
								aria-label={tl("Save name for {name}", { name: run.name })}
								className="size-7"
								disabled={!editingName.trim()}
								onClick={() => {
									onRename(run.id, editingName).catch(() => undefined);
									setEditingId(null);
								}}
								size="icon-sm"
								variant="ghost"
							>
								Save
							</Button>
						</>
					) : (
						<Button
							className="max-w-56"
							onClick={() => onSelect(run.id).catch(() => undefined)}
							size="caption"
							variant={selectedRunId === run.id ? "secondary" : "ghost"}
						>
							<span className="truncate" title={run.name}>
								{run.name}
							</span>
						</Button>
					)}
					{editingId !== run.id && confirmDeleteId !== run.id ? (
						<>
							<Button
								aria-label={tl("Rename {name}", { name: run.name })}
								className="size-7"
								onClick={() => {
									setEditingId(run.id);
									setEditingName(run.name);
								}}
								size="icon-sm"
								variant="ghost"
							>
								<HugeiconsIcon className="size-3" icon={Edit02Icon} />
							</Button>
							<Button
								aria-label={tl("Duplicate {name}", { name: run.name })}
								className="size-7"
								onClick={() => onDuplicate(run.id).catch(() => undefined)}
								size="icon-sm"
								variant="ghost"
							>
								<HugeiconsIcon className="size-3" icon={Copy01Icon} />
							</Button>
							<Button
								aria-label={tl("Compare {name}", { name: run.name })}
								onClick={() => onCompare(run.id).catch(() => undefined)}
								size="micro-dense"
								variant="ghost"
							>
								Compare
							</Button>
							<Button
								aria-label={tl("Delete {name}", { name: run.name })}
								className="size-7"
								onClick={() => setConfirmDeleteId(run.id)}
								size="icon-sm"
								variant="ghost"
							>
								<HugeiconsIcon className="size-3" icon={Delete02Icon} />
							</Button>
						</>
					) : null}
					{confirmDeleteId === run.id ? (
						<>
							<span className="type-compact text-status-destructive">
								Delete?
							</span>
							<Button
								onClick={() => {
									onDelete(run.id).catch(() => undefined);
									setConfirmDeleteId(null);
								}}
								size="micro-dense"
								variant="destructive"
							>
								Delete
							</Button>
							<Button
								onClick={() => setConfirmDeleteId(null)}
								size="micro-dense"
								variant="ghost"
							>
								Cancel
							</Button>
						</>
					) : null}
				</div>
			))}
		</div>
	);
}
