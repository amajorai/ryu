import {
	PencilEdit01Icon,
	PinIcon,
	PinOffIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { KeyboardEvent } from "react";
import { AgentAvatar, engineForAgent } from "@/src/lib/agent-logos.tsx";
import type { AgentSummary } from "@/src/lib/api/agents.ts";

/** The three visual densities used by the Bot-mode pinned roster. */
export type PinnedAgentLayout = "hero" | "pair" | "grid";

/**
 * Map the number of pinned agents to the stage density.
 *
 * The first agent is a deliberate hero: the empty space gives the user's main
 * bot a recognizable home. Two agents become a balanced pair, and three or
 * more use a three-column grid so adding another pin never makes the stage
 * wider or changes the meaning of the first two states.
 */
export function pinnedAgentLayout(count: number): PinnedAgentLayout {
	if (count <= 1) {
		return "hero";
	}
	if (count === 2) {
		return "pair";
	}
	return "grid";
}

const LAYOUT_STYLES: Record<
	PinnedAgentLayout,
	{
		avatarSize: string;
		grid: string;
		name: string;
		tile: string;
	}
> = {
	hero: {
		avatarSize: "64px",
		grid: "grid-cols-1",
		name: "text-sm",
		tile: "min-h-28 flex-row gap-3 p-3",
	},
	pair: {
		avatarSize: "44px",
		grid: "grid-cols-2",
		name: "text-xs",
		tile: "min-h-24 flex-col justify-center gap-1.5 p-2",
	},
	grid: {
		avatarSize: "32px",
		grid: "grid-cols-3",
		name: "text-[11px]",
		tile: "min-h-[76px] flex-col justify-center gap-1 p-1.5",
	},
};

function openOnKeyboard(
	event: KeyboardEvent<HTMLDivElement>,
	onOpen: () => void
) {
	if (event.target !== event.currentTarget) {
		return;
	}
	if (event.key === "Enter" || event.key === " ") {
		event.preventDefault();
		onOpen();
	}
}

function PinnedAgentTile({
	agent,
	layout,
	onEdit,
	onOpen,
	onUnpin,
}: {
	agent: AgentSummary;
	layout: PinnedAgentLayout;
	onEdit: () => void;
	onOpen: () => void;
	onUnpin: () => void;
}) {
	const styles = LAYOUT_STYLES[layout];
	const hero = layout === "hero";
	const showTitle = layout !== "grid" && Boolean(agent.title);

	return (
		// biome-ignore lint/a11y/useSemanticElements: the tile contains two secondary controls, so a button would be invalidly nested.
		<div
			aria-label={`Open ${agent.name}`}
			className={cn(
				"group/pinned relative flex cursor-pointer items-center overflow-hidden rounded-xl border border-transparent bg-transparent text-left outline-hidden transition-[background-color,border-color,transform] focus-within:border-sidebar-border/70 focus-within:bg-sidebar-accent/60 hover:-translate-y-px hover:border-sidebar-border/70 hover:bg-sidebar-accent/60 focus-visible:border-sidebar-border/70 focus-visible:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring/60",
				styles.tile,
				hero && "sm:gap-4"
			)}
			data-agent-id={agent.id}
			onClick={onOpen}
			onKeyDown={(event) => openOnKeyboard(event, onOpen)}
			role="button"
			tabIndex={0}
		>
			<AgentAvatar
				avatarUrl={agent.avatarUrl}
				className={cn(
					"shrink-0 rounded-2xl object-cover",
					hero ? "rounded-2xl" : "rounded-xl"
				)}
				engine={engineForAgent(agent)}
				glyph={agent.avatarGlyph}
				size={styles.avatarSize}
			/>
			<div className={cn("min-w-0", hero ? "flex-1" : "w-full text-center")}>
				<div
					className={cn("truncate font-medium text-foreground", styles.name)}
					title={agent.name}
				>
					{agent.name}
				</div>
				{showTitle ? (
					<div className="mt-0.5 truncate text-[10px] text-muted-foreground">
						{agent.title}
					</div>
				) : null}
			</div>
			<div
				className={cn(
					"absolute top-1 right-1 flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within/pinned:opacity-100 group-hover/pinned:opacity-100",
					layout === "grid" && "top-0.5 right-0.5"
				)}
			>
				<button
					aria-label={`Edit ${agent.name}`}
					className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/60"
					onClick={(event) => {
						event.stopPropagation();
						onEdit();
					}}
					type="button"
				>
					<HugeiconsIcon icon={PencilEdit01Icon} size={12} />
				</button>
				<button
					aria-label={`Unpin ${agent.name}`}
					aria-pressed="true"
					className="flex size-6 items-center justify-center rounded-md text-primary hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/60"
					onClick={(event) => {
						event.stopPropagation();
						onUnpin();
					}}
					type="button"
				>
					<HugeiconsIcon icon={PinOffIcon} size={12} />
				</button>
			</div>
		</div>
	);
}

/**
 * The pinned-agent stage at the top of Bot mode's Agents section.
 *
 * It intentionally lives outside `SidebarMenu`: pinned agents are a visual
 * priority shelf, while the remaining agents stay ordinary accessible rows.
 */
export function PinnedAgentStage({
	agents,
	onEdit,
	onOpen,
	onUnpin,
}: {
	agents: AgentSummary[];
	onEdit: (agent: AgentSummary) => void;
	onOpen: (agent: AgentSummary) => void;
	onUnpin: (agent: AgentSummary) => void;
}) {
	if (agents.length === 0) {
		return null;
	}

	const layout = pinnedAgentLayout(agents.length);
	const styles = LAYOUT_STYLES[layout];

	return (
		<section
			aria-label="Pinned agents"
			className="space-y-1.5 px-2 pb-2"
			data-layout={layout}
			data-pinned-count={agents.length}
			data-testid="pinned-agent-stage"
		>
			<div className="flex items-center gap-1.5 px-1 text-[10px] text-muted-foreground uppercase tracking-[0.12em]">
				<HugeiconsIcon className="size-3 text-primary/80" icon={PinIcon} />
				<span>Pinned</span>
				<span className="text-muted-foreground/60 tabular-nums">
					{agents.length}
				</span>
			</div>
			<div className={cn("grid gap-1.5", styles.grid)}>
				{agents.map((agent) => (
					<PinnedAgentTile
						agent={agent}
						key={agent.id}
						layout={layout}
						onEdit={() => onEdit(agent)}
						onOpen={() => onOpen(agent)}
						onUnpin={() => onUnpin(agent)}
					/>
				))}
			</div>
		</section>
	);
}
