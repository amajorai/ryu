import { Button } from "@ryu/ui/components/button";
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
} from "@ryu/ui/components/dropdown-menu";
import { Input } from "@ryu/ui/components/input";
import { cn } from "@ryu/ui/lib/utils";
import {
	ChevronDown,
	KanbanSquare,
	LayoutGrid,
	List,
	Plus,
	Settings2,
	Table as TableIcon,
	Trash2,
} from "lucide-react";
import { type ComponentType, useState } from "react";
import type {
	DbColumn,
	DbView,
	DbViewKind,
} from "@/src/lib/realtime/yjs-database.ts";

const VIEW_KINDS: Array<{
	kind: DbViewKind;
	label: string;
	icon: ComponentType<{ className?: string }>;
}> = [
	{ kind: "table", label: "Table", icon: TableIcon },
	{ kind: "board", label: "Board", icon: KanbanSquare },
	{ kind: "gallery", label: "Gallery", icon: LayoutGrid },
	{ kind: "list", label: "List", icon: List },
];

const KIND_ICON: Record<DbViewKind, ComponentType<{ className?: string }>> = {
	table: TableIcon,
	board: KanbanSquare,
	gallery: LayoutGrid,
	list: List,
};

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
		<div className="flex shrink-0 items-center gap-1 border-b px-2">
			{views.map((view) => {
				const Icon = KIND_ICON[view.kind];
				const active = view.id === activeViewId;
				if (renamingId === view.id) {
					return (
						<Input
							autoFocus
							className="my-1 h-7 w-28"
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
						<button
							className={cn(
								"flex items-center gap-1.5 rounded-md px-2 py-1.5 font-medium text-sm transition-colors",
								active
									? "text-foreground"
									: "text-muted-foreground hover:text-foreground"
							)}
							onClick={() => onSelect(view.id)}
							onDoubleClick={() => {
								if (!readOnly) {
									setRenameValue(view.name);
									setRenamingId(view.id);
								}
							}}
							type="button"
						>
							<Icon className="size-3.5" />
							{view.name}
						</button>
						{active && !readOnly && (
							<DropdownMenu>
								<DropdownMenuTrigger
									render={
										<Button
											aria-label="View options"
											className="size-6 text-muted-foreground"
											size="icon"
											variant="ghost"
										>
											<ChevronDown className="size-3.5" />
										</Button>
									}
								/>
								<DropdownMenuContent align="start" className="w-52">
									<DropdownMenuLabel>Layout</DropdownMenuLabel>
									<DropdownMenuRadioGroup
										onValueChange={(value) =>
											onUpdateView(view.id, { kind: value as DbViewKind })
										}
										value={view.kind}
									>
										{VIEW_KINDS.map((option) => (
											<DropdownMenuRadioItem
												key={option.kind}
												value={option.kind}
											>
												<option.icon className="size-3.5" />
												{option.label}
											</DropdownMenuRadioItem>
										))}
									</DropdownMenuRadioGroup>
									{(view.kind === "board" || view.kind === "gallery") && (
										<>
											<DropdownMenuSeparator />
											<DropdownMenuSub>
												<DropdownMenuSubTrigger>
													<Settings2 className="size-3.5" />
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
										<Trash2 className="size-3.5" />
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
								className="size-7 text-muted-foreground"
								size="icon"
								variant="ghost"
							>
								<Plus className="size-4" />
							</Button>
						}
					/>
					<DropdownMenuContent align="start">
						{VIEW_KINDS.map((option) => (
							<DropdownMenuItem
								key={option.kind}
								onClick={() => onAddView(option.kind)}
							>
								<option.icon className="size-3.5" />
								{option.label}
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</div>
	);
}
