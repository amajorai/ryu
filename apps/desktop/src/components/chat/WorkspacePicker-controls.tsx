// apps/desktop/src/components/chat/WorkspacePicker-controls.tsx
//
// Trigger rows, menus and the diff-stat chip shared by WorkspacePicker's
// project, run-location, environment and branch controls.

import {
	ComputerTerminal01Icon,
	Folder03Icon,
	Tick02Icon,
	type WorkflowCircle06Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button, ButtonLabel } from "@ryu/ui/components/button.tsx";
import { Command, CommandDialog } from "@ryu/ui/components/command.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode } from "react";
import { WORKSPACE_SELECT_TRIGGER } from "@/components/agent-elements/input/composer-select.ts";
import type { ProjectEnvironment } from "@/src/store/useWorkspaceStore.ts";

export interface LineStat {
	deletions: number;
	insertions: number;
}

/** +added / −removed line counts, replacing the old dirty dot. Renders nothing
 *  when there is no change. Exported because the pinned summary panel shows the
 *  same counts in its accordion header — it used to carry a second copy of this
 *  component, which is how the two ended up sized differently. */
export function DiffStat({ stat }: { stat: LineStat }) {
	if (stat.insertions === 0 && stat.deletions === 0) {
		return null;
	}
	return (
		<span className="type-caption flex shrink-0 items-center gap-1 font-medium font-mono tabular-nums">
			{stat.insertions > 0 && (
				<span className="text-status-success dark:text-status-success/90">
					+{formatCount(stat.insertions)}
				</span>
			)}
			{stat.deletions > 0 && (
				<span className="text-status-destructive/90 dark:text-status-destructive/90">
					−{formatCount(stat.deletions)}
				</span>
			)}
		</span>
	);
}

/** Which direct workspace menu is open. */
export type WorkspacePickerId = "folder" | "branch" | "environment" | "mode";

export function ReadonlyPickerRow({
	fullWidth = false,
	label,
	title,
}: {
	fullWidth?: boolean;
	label: string;
	title: string;
}) {
	const tl = useLiteralMessages();
	return (
		<div
			aria-label={tl("Project folder: {label}", { label })}
			className={cn(
				WORKSPACE_SELECT_TRIGGER,
				"flex cursor-default items-center text-muted-foreground",
				fullWidth && "w-full justify-start"
			)}
			data-testid="pinned-summary-folder"
			title={title}
		>
			<HugeiconsIcon className="size-3.5 shrink-0" icon={Folder03Icon} />
			<span className="min-w-0 flex-1 truncate text-left">{label}</span>
		</div>
	);
}

export function EnvironmentList({
	activeId,
	disabled,
	environments,
	onSelect,
}: {
	activeId?: string;
	disabled: boolean;
	environments: ProjectEnvironment[];
	onSelect: (environmentId: string) => void;
}) {
	return (
		<DropdownMenuGroup>
			<DropdownMenuLabel variant="worktree-heading">
				Local environment
			</DropdownMenuLabel>
			{environments.map((environment) => (
				<DropdownMenuItem
					active={activeId === environment.id}
					disabled={disabled}
					key={environment.id}
					onClick={() => onSelect(environment.id)}
				>
					<HugeiconsIcon
						className="size-4 shrink-0 text-muted-foreground"
						icon={ComputerTerminal01Icon}
					/>
					<span className="min-w-0 flex-1 truncate">{environment.name}</span>
					{activeId === environment.id ? (
						<HugeiconsIcon className="size-4" icon={Tick02Icon} />
					) : null}
				</DropdownMenuItem>
			))}
			{disabled ? (
				<p className="px-2 py-1.5 text-muted-foreground text-xs">
					This chat already has a worktree. Switch environments before the next
					worktree is created.
				</p>
			) : null}
		</DropdownMenuGroup>
	);
}

/** A workspace control that opens a command dialog rather than a menu. */
export function PickerTrigger({
	fullWidth = false,
	icon,
	label,
	onOpen,
	open,
	title,
	trailing,
}: {
	fullWidth?: boolean;
	icon: typeof WorkflowCircle06Icon;
	label: string;
	onOpen: () => void;
	open: boolean;
	title: string;
	trailing?: ReactNode;
}) {
	return (
		<Button
			appearance="composer-settings-foreground"
			aria-expanded={open}
			aria-haspopup="dialog"
			className={cn(fullWidth && "w-full justify-start")}
			onClick={onOpen}
			size="sm"
			title={title}
			type="button"
			variant="ghost"
		>
			<HugeiconsIcon className="size-3.5 shrink-0" icon={icon} />
			<ButtonLabel className="flex-1 text-left">{label}</ButtonLabel>
			{trailing}
		</Button>
	);
}

/** Command-dialog shell for the branch and run-location pickers. Filtering is
 *  manual (each body owns its query) so fixed actions stay reachable. */
export function PickerCommandDialog({
	children,
	description,
	onOpenChange,
	open,
	title,
}: {
	children: ReactNode;
	description: string;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	title: string;
}) {
	return (
		<CommandDialog
			className="sm:max-w-lg"
			description={description}
			onOpenChange={onOpenChange}
			open={open}
			title={title}
		>
			<Command shouldFilter={false}>{children}</Command>
		</CommandDialog>
	);
}

/** The environment control: a trigger over its own small menu, so a click lands
 *  on the list it names with no submenu to walk. */
export function PickerRow({
	children,
	fullWidth = false,
	icon,
	id,
	label,
	onOpenChange,
	open,
	side,
	title,
	trailing,
}: {
	children: ReactNode;
	fullWidth?: boolean;
	icon: typeof WorkflowCircle06Icon;
	id: WorkspacePickerId;
	label: string;
	onOpenChange: (id: WorkspacePickerId, next: boolean) => void;
	open: boolean;
	side: "bottom" | "top";
	title: string;
	trailing?: ReactNode;
}) {
	return (
		<DropdownMenu onOpenChange={(next) => onOpenChange(id, next)} open={open}>
			<DropdownMenuTrigger
				render={
					<Button
						appearance="composer-settings-foreground"
						className={cn(fullWidth && "w-full justify-start")}
						size="sm"
						title={title}
						type="button"
						variant="ghost"
					/>
				}
			>
				<HugeiconsIcon className="size-3.5 shrink-0" icon={icon} />
				<ButtonLabel className="flex-1 text-left">{label}</ButtonLabel>
				{trailing}
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="start"
				className="min-w-[280px]"
				side={side}
				sideOffset={6}
			>
				{children}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
