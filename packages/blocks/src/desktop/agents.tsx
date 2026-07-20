"use client";

// Presentational layer of the desktop Agents page. The live app
// (`apps/desktop/src/pages/AgentsPage.tsx`) is a thin container that loads
// agents via `useAgents()` and renders this view with real handlers; the
// storyboard renders the same component with mock data and no-op handlers.
// One source of truth, so editing this block changes the real desktop too.

import {
	Add01Icon,
	BotIcon,
	Delete01Icon,
	Download01Icon,
	LockedIcon,
	MoreHorizontalIcon,
	PencilEdit01Icon,
	Upload01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
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
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Logo as RyuLogo } from "@ryu/ui/components/logo";
import { Spinner } from "@ryu/ui/components/spinner";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import type { ChangeEvent, ReactNode, RefObject } from "react";

/** A single agent row as the view needs it — the engine label is pre-resolved
 *  by the container so this layer stays presentational. */
export interface AgentRow {
	builtIn: boolean;
	/** Whether the delete action is offered (false for built-ins / the default). */
	deletable: boolean;
	/** Human engine label, already resolved from the engines list (or null). */
	engineLabel: string | null;
	/** True while an export request for this row is in flight. */
	exporting?: boolean;
	id: string;
	name: string;
	/** Injected per-agent "check for updates" control (version chip / Update
	 *  button). Rendered inline in the row; the container owns its state. */
	updateSlot?: ReactNode;
}

export interface AgentsViewProps {
	agents: AgentRow[];
	error?: string | null;
	/** Export-result dialog (driven by the container). */
	exportDialogOpen?: boolean;
	exportError?: string | null;
	exportName?: string | null;
	importError?: string | null;
	importInputRef?: RefObject<HTMLInputElement | null>;
	importing?: boolean;
	loading?: boolean;
	onDeleteAgent?: (id: string) => void;
	onDownloadExport?: () => void;
	onExportAgent?: (id: string) => void;
	onExportDialogOpenChange?: (open: boolean) => void;
	onImportClick?: () => void;
	onImportFile?: (event: ChangeEvent<HTMLInputElement>) => void;
	onNewAgent?: () => void;
	onOpenAgent?: (id: string) => void;
	/** Retry loading after a load failure (offered as a next step). */
	onReload?: () => void;
}

export function AgentsView({
	loading,
	error,
	agents,
	importing,
	importError,
	importInputRef,
	onImportFile,
	onImportClick,
	onNewAgent,
	onOpenAgent,
	onExportAgent,
	onDeleteAgent,
	exportDialogOpen,
	exportName,
	exportError,
	onExportDialogOpenChange,
	onDownloadExport,
	onReload,
}: AgentsViewProps) {
	if (loading) {
		return (
			<div className="flex h-full items-center justify-center">
				<Spinner />
			</div>
		);
	}

	if (error) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={BotIcon} />
					</EmptyMedia>
					<EmptyTitle>Could not load agents</EmptyTitle>
					<EmptyDescription>
						Something went wrong while loading your agents. Check your
						connection and try again.
					</EmptyDescription>
				</EmptyHeader>
				{onReload ? (
					<EmptyContent>
						<Button onClick={onReload} size="sm" variant="outline">
							Try again
						</Button>
					</EmptyContent>
				) : null}
			</Empty>
		);
	}

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="flex shrink-0 items-center justify-end border-b px-4 py-3">
				<div className="flex items-center gap-2">
					<input
						accept=".json"
						className="hidden"
						onChange={onImportFile}
						ref={importInputRef}
						type="file"
					/>
					<Button
						disabled={importing}
						onClick={onImportClick}
						size="sm"
						variant="ghost"
					>
						{importing ? (
							<Spinner className="size-4" />
						) : (
							<HugeiconsIcon className="size-4" icon={Upload01Icon} />
						)}
						Import
					</Button>
					<Button onClick={onNewAgent} size="sm">
						<HugeiconsIcon className="size-4" icon={Add01Icon} />
						New agent
					</Button>
				</div>
			</div>

			{importError ? (
				<div className="shrink-0 border-b bg-destructive/10 px-4 py-2 text-destructive text-sm">
					Import failed: {importError}
				</div>
			) : null}

			<div className="scroll-fade-effect-y flex-1 overflow-auto p-2">
				{agents.length === 0 ? (
					<Empty className="h-full">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<HugeiconsIcon icon={BotIcon} />
							</EmptyMedia>
							<EmptyTitle>No agents yet</EmptyTitle>
							<EmptyDescription>
								Create an agent to give it custom instructions and choose the
								model it runs on.
							</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>
							<Button onClick={onNewAgent} size="sm">
								<HugeiconsIcon className="size-4" icon={Add01Icon} />
								Create your first agent
							</Button>
						</EmptyContent>
					</Empty>
				) : (
					<div className="mx-auto flex w-full max-w-2xl flex-col gap-0.5">
						{agents.map((agent) => (
							<div
								className="group/row flex h-10 cursor-pointer items-center gap-3 rounded-md px-2 transition-colors hover:bg-muted"
								key={agent.id}
								onClick={() => onOpenAgent?.(agent.id)}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										onOpenAgent?.(agent.id);
									}
								}}
								role="button"
								tabIndex={0}
							>
								<RyuLogo
									className="shrink-0 text-foreground"
									size="20px"
									variant="outline"
								/>
								<Tooltip>
									<TooltipTrigger
										render={
											<span className="min-w-0 flex-1 truncate text-sm">
												{agent.name}
											</span>
										}
									/>
									<TooltipContent>{agent.name}</TooltipContent>
								</Tooltip>
								{agent.builtIn ? (
									<HugeiconsIcon
										className="size-3.5 shrink-0 text-muted-foreground/70 group-hover/row:hidden"
										icon={LockedIcon}
									/>
								) : null}
								{agent.engineLabel ? (
									<span className="shrink-0 text-muted-foreground/70 text-xs group-hover/row:hidden">
										{agent.engineLabel}
									</span>
								) : null}
								{agent.updateSlot}
								<DropdownMenu>
									<DropdownMenuTrigger
										className="hidden h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-accent group-hover/row:inline-flex"
										onClick={(e) => e.stopPropagation()}
									>
										{agent.exporting ? (
											<Spinner className="size-3.5" />
										) : (
											<HugeiconsIcon icon={MoreHorizontalIcon} size={14} />
										)}
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end">
										<DropdownMenuItem
											onClick={(e) => {
												e.stopPropagation();
												onOpenAgent?.(agent.id);
											}}
										>
											<HugeiconsIcon
												className="mr-2 size-3.5"
												icon={PencilEdit01Icon}
											/>
											Edit
										</DropdownMenuItem>
										<DropdownMenuItem
											onClick={(e) => {
												e.stopPropagation();
												onExportAgent?.(agent.id);
											}}
										>
											<HugeiconsIcon
												className="mr-2 size-3.5"
												icon={Download01Icon}
											/>
											Export
										</DropdownMenuItem>
										{agent.deletable ? (
											<DropdownMenuItem
												className="text-destructive"
												onClick={(e) => {
													e.stopPropagation();
													onDeleteAgent?.(agent.id);
												}}
											>
												<HugeiconsIcon
													className="mr-2 size-3.5"
													icon={Delete01Icon}
												/>
												Delete
											</DropdownMenuItem>
										) : null}
									</DropdownMenuContent>
								</DropdownMenu>
							</div>
						))}
					</div>
				)}
			</div>

			<AlertDialog
				onOpenChange={onExportDialogOpenChange}
				open={exportDialogOpen ?? false}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{exportError ? "Export failed" : `Export "${exportName}"`}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{exportError
								? "We couldn't prepare this agent for export. Please try again."
								: "Your agent is ready. Download the file to share it or bring it back later."}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						{exportError ? null : (
							<AlertDialogAction onClick={onDownloadExport}>
								Download
							</AlertDialogAction>
						)}
						<AlertDialogCancel
							onClick={() => onExportDialogOpenChange?.(false)}
						>
							{exportError ? "Dismiss" : "Close"}
						</AlertDialogCancel>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
