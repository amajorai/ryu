import {
	ArrowDown01Icon,
	Delete02Icon,
	GridViewIcon,
	KanbanIcon,
	LeftToRightListBulletIcon,
	PlusSignIcon,
	Settings02Icon,
	Table01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useState } from "react";
import type {
	DbColumn,
	DbView,
	DbViewKind,
} from "@/src/lib/realtime/yjs-database.ts";

const VIEW_KINDS: Array<{
	kind: DbViewKind;
	label: string;
	icon: IconSvgElement;
}> = [
	{ kind: "table", label: "Table", icon: Table01Icon },
	{ kind: "board", label: "Board", icon: KanbanIcon },
	{ kind: "gallery", label: "Gallery", icon: GridViewIcon },
	{ kind: "list", label: "List", icon: LeftToRightListBulletIcon },
];

const KIND_ICON = {
	table: Table01Icon,
	board: KanbanIcon,
	gallery: GridViewIcon,
	list: LeftToRightListBulletIcon,
} satisfies Record<DbViewKind, IconSvgElement>;

/**
 * The view switcher above a database: one chip per saved view, an add-view menu,
 * and a per-view settings menu (change layout, pick a board group-by column,
 * rename, delete). Views are display config only; switching never touches data.
 */
export function ViewBar({
	views,
	activeViewId,
	columns,
	readOnly,
	onSelect,
	onAddView,
	onUpdateView,
	onRemoveView,
}: {
	views: DbView[];
	activeViewId: string;
	columns: DbColumn[];
	readOnly: boolean;
	onSelect: (viewId: string) => void;
	onAddView: (kind: DbViewKind) => void;
	onUpdateView: (
		viewId: string,
		patch: { name?: string; kind?: DbViewKind; groupByColumnId?: string | null }
	) => void;
	onRemoveView: (viewId: string) => void;
}) {
	const tl = useLiteralMessages();
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState("");

	const selectColumns = columns.filter(
		(column) =>
			column.cell.variant === "select" || column.cell.variant === "multi-select"
	);

	const commitRename = (viewId: string) => {
		const next = renameValue.trim();
		if (next) {
			onUpdateView(viewId, { name: next });
		}
		setRenamingId(null);
	};

	return (
		<div className="flex h-10 shrink-0 items-center gap-1 border-border border-b px-2">
			{views.map((view) => {
				const icon = KIND_ICON[view.kind];
				const active = view.id === activeViewId;
				if (renamingId === view.id) {
					return (
						<Input
							aria-label={tl("Rename view {viewName}", { viewName: view.name })}
							autoFocus
							className="h-8 w-28"
							key={view.id}
							onBlur={() => commitRename(view.id)}
							onChange={(e) => setRenameValue(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									commitRename(view.id);
								} else if (e.key === "Escape") {
									setRenamingId(null);
								}
							}}
							value={renameValue}
						/>
					);
				}
				return (
					<div className="flex items-center" key={view.id}>
						<Button
							aria-pressed={active}
							className={cn("gap-1.5", active && "bg-muted text-foreground")}
							onClick={() => onSelect(view.id)}
							onDoubleClick={() => {
								if (!readOnly) {
									setRenameValue(view.name);
									setRenamingId(view.id);
								}
							}}
							size="sm"
							type="button"
							variant={active ? "ghost" : "ghost-muted"}
						>
							<HugeiconsIcon className="size-3.5" icon={icon} />
							{view.name}
						</Button>
						{active && !readOnly && (
							<DropdownMenu>
								<DropdownMenuTrigger
									render={
										<Button
											aria-label="View options"
											size="icon-sm"
											variant="ghost-muted"
										>
											<HugeiconsIcon
												className="size-3.5"
												icon={ArrowDown01Icon}
											/>
										</Button>
									}
								/>
								<DropdownMenuContent align="start" className="w-52">
									<DropdownMenuRadioGroup
										onValueChange={(value) => {
											const option = VIEW_KINDS.find(
												(entry) => entry.kind === value
											);
											if (option) {
												onUpdateView(view.id, { kind: option.kind });
											}
										}}
										value={view.kind}
									>
										<DropdownMenuLabel>Layout</DropdownMenuLabel>
										{VIEW_KINDS.map((option) => (
											<DropdownMenuRadioItem
												key={option.kind}
												value={option.kind}
											>
												<HugeiconsIcon className="size-4" icon={option.icon} />
												{option.label}
											</DropdownMenuRadioItem>
										))}
									</DropdownMenuRadioGroup>
									{view.kind === "board" && (
										<>
											<DropdownMenuSeparator />
											<DropdownMenuSub>
												<DropdownMenuSubTrigger>
													<HugeiconsIcon
														className="size-4"
														icon={Settings02Icon}
													/>
													Group by
												</DropdownMenuSubTrigger>
												<DropdownMenuSubContent>
													{selectColumns.length === 0 ? (
														<DropdownMenuItem disabled>
															No Select property
														</DropdownMenuItem>
													) : (
														<DropdownMenuRadioGroup
															onValueChange={(value) =>
																onUpdateView(view.id, {
																	groupByColumnId: value,
																})
															}
															value={view.groupByColumnId ?? ""}
														>
															{selectColumns.map((column) => (
																<DropdownMenuRadioItem
																	key={column.id}
																	value={column.id}
																>
																	{column.label}
																</DropdownMenuRadioItem>
															))}
														</DropdownMenuRadioGroup>
													)}
												</DropdownMenuSubContent>
											</DropdownMenuSub>
										</>
									)}
									<DropdownMenuSeparator />
									<DropdownMenuItem
										onClick={() => {
											setRenameValue(view.name);
											setRenamingId(view.id);
										}}
									>
										Rename
									</DropdownMenuItem>
									<DropdownMenuItem
										disabled={views.length <= 1}
										onClick={() => onRemoveView(view.id)}
										variant="destructive"
									>
										<HugeiconsIcon className="size-4" icon={Delete02Icon} />
										Delete view
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						)}
					</div>
				);
			})}
			{!readOnly && (
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button
								aria-label="Add view"
								size="icon-sm"
								variant="ghost-muted"
							>
								<HugeiconsIcon className="size-4" icon={PlusSignIcon} />
							</Button>
						}
					/>
					<DropdownMenuContent align="start">
						{VIEW_KINDS.map((option) => (
							<DropdownMenuItem
								key={option.kind}
								onClick={() => onAddView(option.kind)}
							>
								<HugeiconsIcon className="size-4" icon={option.icon} />
								{option.label}
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</div>
	);
}
