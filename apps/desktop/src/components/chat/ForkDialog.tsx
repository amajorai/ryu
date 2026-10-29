import { FolderTreeIcon, LaptopIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";

export type ForkDestination = "workspace" | "worktree";

interface ForkDestinationRowProps {
	description: string;
	destination: ForkDestination;
	disabled?: boolean;
	icon: typeof LaptopIcon;
	onSelect: (destination: ForkDestination) => void;
	title: string;
}

function ForkDestinationRow({
	description,
	destination,
	disabled = false,
	icon,
	onSelect,
	title,
}: ForkDestinationRowProps) {
	return (
		<button
			className={cn(
				"flex w-full items-center gap-4 rounded-2xl px-3 py-3.5 text-left transition-colors",
				disabled
					? "cursor-not-allowed opacity-50"
					: "hover:bg-muted/70 focus-visible:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			)}
			disabled={disabled}
			onClick={() => onSelect(destination)}
			type="button"
		>
			<HugeiconsIcon
				className="size-5 shrink-0 text-muted-foreground"
				icon={icon}
				strokeWidth={1.7}
			/>
			<span className="min-w-0 flex-1">
				<span className="text-(length:--text-comfortable) block font-medium leading-5">
					{title}
				</span>
				<span className="text-(length:--text-detail) mt-0.5 block text-muted-foreground leading-5">
					{description}
				</span>
			</span>
		</button>
	);
}

export function ForkDialog({
	onOpenChange,
	onSelect,
	open,
}: {
	onOpenChange: (open: boolean) => void;
	onSelect: (destination: ForkDestination) => void;
	open: boolean;
}) {
	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent appearance="workflow-fork" showCloseButton={false}>
				<DialogHeader purpose="workflow-fork">
					<DialogTitle typography="explanation">
						Fork chat from here
					</DialogTitle>
					<DialogDescription className="sr-only">
						Choose where to continue this fork.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-1">
					<ForkDestinationRow
						description="Fork from this message in the current workspace"
						destination="workspace"
						icon={LaptopIcon}
						onSelect={onSelect}
						title="Fork in this workspace"
					/>
					<ForkDestinationRow
						description="Fork from this message in a new worktree"
						destination="worktree"
						icon={FolderTreeIcon}
						onSelect={onSelect}
						title="Fork in a new worktree"
					/>
				</div>
			</DialogContent>
		</Dialog>
	);
}
