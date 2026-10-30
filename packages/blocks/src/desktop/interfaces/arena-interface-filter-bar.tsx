import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	ToggleGroup,
	ToggleGroupItem,
} from "@ryu/ui/components/toggle-group.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { STICKY_ATTRIBUTE } from "./arena-interface-navigation.ts";
import {
	ARENA_FILTER_LABELS,
	ARENA_FILTERS,
	type ArenaCardView,
	type ArenaFilter,
	type ArenaNextUp,
	isArenaFilter,
} from "./arena-model.ts";

export const FILTER_EMPTY: Record<
	ArenaFilter,
	{ description: string; title: string }
> = {
	all: { description: "Agents you create show up here.", title: "No agents." },
	idle: {
		description: "Every agent is working or waiting on you.",
		title: "No idle agents.",
	},
	"needs-you": {
		description: "No failed runs or replies are waiting on you.",
		title: "No agents need you.",
	},
	working: {
		description: "No agent has a run in progress.",
		title: "Nothing running.",
	},
};

function agentsLabel(count: number): string {
	return `${count} ${count === 1 ? "agent" : "agents"}`;
}

interface ArenaFilterBarProps {
	busyNeedingYou: ArenaCardView[];
	filter: ArenaFilter;
	filterCounts: Record<ArenaFilter, number>;
	loading: boolean;
	nextUp: ArenaNextUp | null;
	nextUpAgent: InterfaceAgent | undefined;
	openFrom: (agentId: string | null, threadId: string) => void;
	panelOpen: boolean;
	scrolled: boolean;
	setFilter: (filter: ArenaFilter) => void;
}

/** The sticky row over the wall: filter chips plus the next thread to open. */
export function ArenaFilterBar({
	busyNeedingYou,
	filter,
	filterCounts,
	loading,
	nextUp,
	nextUpAgent,
	openFrom,
	panelOpen,
	scrolled,
	setFilter,
}: ArenaFilterBarProps) {
	const tl = useLiteralMessages();
	const nextUpTitle = nextUp?.thread.title.trim() || "Untitled thread";
	const nextUpState = nextUp?.status === "attention" ? "failed" : "other";

	return (
		<div
			className={cn(
				"sticky top-0 z-20 flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 border-b bg-background px-4 py-3 transition-colors",
				scrolled ? "border-border" : "border-transparent"
			)}
			{...{ [STICKY_ATTRIBUTE]: "" }}
		>
			<ToggleGroup
				appearance="segmented"
				aria-label="Filter agents"
				disabled={loading}
				multiple={false}
				onValueChange={(values: string[]) => {
					const value = values[0];
					if (isArenaFilter(value)) {
						setFilter(value);
					}
				}}
				spacing={0}
				value={[filter]}
			>
				{ARENA_FILTERS.map((option) => {
					const label = `${ARENA_FILTER_LABELS[option]} (${agentsLabel(filterCounts[option])})`;
					return (
						<ToggleGroupItem
							aria-label={label}
							className="gap-1.5 rounded-md px-3 font-medium text-[13px] text-muted-foreground aria-pressed:text-foreground"
							density="segmented"
							key={option}
							title={label}
							value={option}
						>
							{ARENA_FILTER_LABELS[option]}
							<span
								className={cn(
									"font-normal tabular-nums",
									!loading && filterCounts[option] === 0
										? "text-muted-foreground/60"
										: "text-muted-foreground"
								)}
							>
								{loading ? "–" : filterCounts[option]}
							</span>
						</ToggleGroupItem>
					);
				})}
			</ToggleGroup>
			{nextUp && !loading && !panelOpen && busyNeedingYou.length === 0 ? (
				<Button
					aria-label={
						nextUpAgent
							? tl(
									"Next up: {title} with {name} {state, select, failed {failed} other {is your turn}}. Open it.",
									{
										name: nextUpAgent.name,
										state: nextUpState,
										title: nextUpTitle,
									}
								)
							: tl(
									"Next up: {title} {state, select, failed {failed} other {is your turn}}. Open it.",
									{ state: nextUpState, title: nextUpTitle }
								)
					}
					className="ms-auto -me-2 @3xl:inline-flex hidden min-w-0 max-w-[30rem] gap-2 px-2 font-normal"
					onClick={() => openFrom(nextUp.agentId, nextUp.thread.id)}
					size="sm"
					title={tl("Open {title}", { title: nextUpTitle })}
					type="button"
					variant="ghost"
				>
					<span className="shrink-0 text-muted-foreground">Next up</span>
					<span className="min-w-0 truncate text-foreground">
						{nextUpAgent ? (
							<>
								<span className="font-medium">{nextUpAgent.name}</span>
								<span aria-hidden="true" className="text-muted-foreground">
									{" · "}
								</span>
							</>
						) : null}
						{nextUpTitle}
					</span>
				</Button>
			) : null}
			{busyNeedingYou.length > 0 && !loading ? (
				<p className="ms-auto min-w-0 truncate text-muted-foreground text-sm max-sm:hidden">
					{tl("Also waiting on you while working: {names}", {
						names: busyNeedingYou.map((card) => card.name).join(", "),
					})}
				</p>
			) : null}
		</div>
	);
}
