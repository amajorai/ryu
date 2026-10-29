import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { Pencil, Plus, RotateCcw } from "lucide-react";
import type { WidgetId, WidgetSpec } from "./dashboard-model.ts";

function AddWidgetMenu({
	available,
	onAdd,
}: {
	available: readonly WidgetSpec[];
	onAdd: (id: WidgetId) => void;
}) {
	const panels = available.filter((spec) => spec.kind === "panel");
	const stats = available.filter((spec) => spec.kind === "stat");
	const groups = [
		{ items: panels, label: "Lists and charts" },
		{ items: stats, label: "Numbers" },
	].filter((group) => group.items.length > 0);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={<Button size="sm" type="button" variant="outline" />}
			>
				<Plus aria-hidden="true" data-icon="inline-start" />
				Add widget
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="end"
				className="max-h-[min(28rem,var(--available-height))] w-72"
				drawerLabel="Add widget"
			>
				{groups.length === 0 ? (
					<DropdownMenuItem disabled>
						Every widget is on the dashboard
					</DropdownMenuItem>
				) : null}
				{groups.map((group, index) => (
					<DropdownMenuGroup key={group.label}>
						{index > 0 ? <DropdownMenuSeparator /> : null}
						<DropdownMenuLabel>{group.label}</DropdownMenuLabel>
						{group.items.map((spec) => (
							<DropdownMenuItem
								key={spec.id}
								layout="detail-stack"
								onClick={() => onAdd(spec.id)}
							>
								<span className="text-foreground">{spec.title}</span>
								<span className="font-normal text-muted-foreground text-xs">
									{spec.description}
								</span>
							</DropdownMenuItem>
						))}
					</DropdownMenuGroup>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * The page bar: the dashboard's name and scope on the left; on the right,
 * Edit and New thread, or (while editing) Add widget, Reset, and Done.
 */
export function DashboardHeader({
	agentCount,
	available,
	canReset,
	editing,
	onAdd,
	onEditChange,
	onNewThread,
	onReset,
	threadCount,
}: {
	agentCount: number;
	available: readonly WidgetSpec[];
	canReset: boolean;
	editing: boolean;
	onAdd: (id: WidgetId) => void;
	onEditChange: (editing: boolean) => void;
	onNewThread: () => void;
	onReset: () => void;
	threadCount: number;
}) {
	return (
		<header className="flex h-12 shrink-0 items-center gap-3 border-border border-b @min-[640px]/dash:px-6 px-4">
			<div className="flex min-w-0 flex-1 items-baseline gap-3">
				<h1 className="shrink-0 font-semibold text-base text-foreground">
					Dashboard
				</h1>
				<p
					aria-live="polite"
					className="min-w-0 truncate text-[13px] text-muted-foreground max-sm:hidden"
				>
					{editing
						? "Drag widgets to rearrange. Changes save as you go."
						: `${threadCount} ${threadCount === 1 ? "thread" : "threads"} · ${agentCount} ${agentCount === 1 ? "agent" : "agents"}`}
				</p>
			</div>
			{editing ? (
				<div className="flex shrink-0 items-center gap-2">
					<Button
						disabled={!canReset}
						onClick={onReset}
						size="sm"
						title="Restore the default widgets and order"
						type="button"
						variant="ghost"
					>
						<RotateCcw aria-hidden="true" data-icon="inline-start" />
						<span className="max-sm:sr-only">Reset</span>
					</Button>
					<AddWidgetMenu available={available} onAdd={onAdd} />
					<Button onClick={() => onEditChange(false)} size="sm" type="button">
						Done
					</Button>
				</div>
			) : (
				<div className="flex shrink-0 items-center gap-2">
					<Button
						aria-label="Edit dashboard"
						onClick={() => onEditChange(true)}
						size="sm"
						type="button"
						variant="ghost"
					>
						<Pencil aria-hidden="true" data-icon="inline-start" />
						<span aria-hidden="true">Edit</span>
					</Button>
					<Button
						onClick={onNewThread}
						size="sm"
						type="button"
						variant="outline"
					>
						<Plus aria-hidden="true" data-icon="inline-start" />
						New thread
					</Button>
				</div>
			)}
		</header>
	);
}
