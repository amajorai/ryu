import { Button } from "@ryu/ui/components/button.tsx";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import {
	ToggleGroup,
	ToggleGroupItem,
} from "@ryu/ui/components/toggle-group.tsx";
import type { BoardParams } from "@ryuhq/protocol/interfaces";
import { Columns3, List, SlidersHorizontal } from "lucide-react";

type GroupBy = BoardParams["groupBy"];
type View = BoardParams["view"];

const GROUP_OPTIONS: readonly { label: string; value: GroupBy }[] = [
	{ label: "Status", value: "status" },
	{ label: "Agent", value: "agent" },
	{ label: "Project", value: "project" },
];

const VIEW_OPTIONS: readonly {
	Icon: typeof List;
	label: string;
	value: View;
}[] = [
	{ Icon: List, label: "List", value: "list" },
	{ Icon: Columns3, label: "Board", value: "board" },
];

/** The popup's own surface: solid, quiet, and the same radius as the lanes. */
const POPUP =
	"w-72 gap-3 rounded-xl border-border bg-popover p-3 text-popover-foreground shadow-md backdrop-blur-none backdrop-saturate-100";

/**
 * The header's Display menu: layout (list or board) and grouping in one
 * place, the way trackers keep view options behind a single button so the
 * toolbar stays short at every width.
 */
export function BoardDisplayMenu({
	groupBy,
	onGroupByChange,
	onViewChange,
	view,
}: {
	groupBy: GroupBy;
	onGroupByChange: (groupBy: GroupBy) => void;
	onViewChange: (view: View) => void;
	view: View;
}) {
	return (
		<Popover>
			<PopoverTrigger
				render={
					<Button
						aria-label="Display"
						size="dense"
						title="Display options"
						type="button"
						variant="ghost"
					/>
				}
			>
				<SlidersHorizontal aria-hidden="true" data-icon="inline-start" />
				<span className="@max-[640px]/header:hidden">Display</span>
			</PopoverTrigger>
			<PopoverContent align="end" className={POPUP} sideOffset={6}>
				<BoardDisplayOptions
					groupBy={groupBy}
					onGroupByChange={onGroupByChange}
					onViewChange={onViewChange}
					view={view}
				/>
			</PopoverContent>
		</Popover>
	);
}

/** The Display menu's body: layout tiles over the grouping control. */
export function BoardDisplayOptions({
	groupBy,
	onGroupByChange,
	onViewChange,
	view,
}: {
	groupBy: GroupBy;
	onGroupByChange: (groupBy: GroupBy) => void;
	onViewChange: (view: View) => void;
	view: View;
}) {
	return (
		<>
			<ToggleGroup
				aria-label="Show threads as"
				className="grid w-full grid-cols-2 gap-2"
				multiple={false}
				onValueChange={(values: string[]) => {
					const option = VIEW_OPTIONS.find(
						(candidate) => candidate.value === values[0]
					);
					if (option) {
						onViewChange(option.value);
					}
				}}
				spacing={2}
				value={[view]}
				variant="outline"
			>
				{VIEW_OPTIONS.map(({ Icon, label, value }) => (
					<ToggleGroupItem
						aria-label={label}
						className="h-14 w-full flex-col gap-1 rounded-lg border-foreground/15 text-foreground/70 text-xs hover:bg-foreground/5 hover:text-foreground aria-pressed:border-foreground/40 aria-pressed:bg-foreground/5 aria-pressed:text-foreground dark:aria-pressed:bg-foreground/10"
						key={value}
						value={value}
					>
						<Icon aria-hidden="true" className="size-4" />
						{label}
					</ToggleGroupItem>
				))}
			</ToggleGroup>
			<div className="flex items-center justify-between gap-3">
				<span className="text-foreground/70 text-xs">Grouping</span>
				<ToggleGroup
					appearance="segmented"
					aria-label="Group board by"
					className="bg-foreground/5 ring-1 ring-border ring-inset"
					multiple={false}
					onValueChange={(values: string[]) => {
						const option = GROUP_OPTIONS.find(
							(candidate) => candidate.value === values[0]
						);
						if (option) {
							onGroupByChange(option.value);
						}
					}}
					spacing={0.5}
					value={[groupBy]}
				>
					{GROUP_OPTIONS.map((option) => (
						<ToggleGroupItem
							className="rounded-md px-2.5 text-foreground/70 hover:bg-transparent hover:text-foreground aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-xs aria-pressed:ring-1 aria-pressed:ring-foreground/15 aria-pressed:ring-inset dark:aria-pressed:bg-foreground/10 dark:aria-pressed:shadow-none"
							density="segmented"
							key={option.value}
							value={option.value}
						>
							{option.label}
						</ToggleGroupItem>
					))}
				</ToggleGroup>
			</div>
		</>
	);
}
