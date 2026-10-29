import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { ArrowLeft, PenLine } from "lucide-react";
import { mastheadDate, NEWSPAPER_NAME } from "./newspaper-model.ts";
import { SMALL_CAPS } from "./newspaper-parts.tsx";

export interface NewspaperNavItem {
	anchor: string;
	label: string;
}

/**
 * The front page's masthead: the dateline ear, the nameplate, the
 * "Today's paper" rule bar between a hairline and a double rule, and the
 * section bar that jumps down the page.
 */
export function NewspaperMasthead({
	agentCount,
	liveCount,
	loading,
	nav,
	now,
	onJump,
	onSubmit,
	storyCount,
}: {
	agentCount: number;
	liveCount: number;
	loading: boolean;
	nav: NewspaperNavItem[];
	now: number;
	onJump: (anchor: string) => void;
	onSubmit: () => void;
	storyCount: number;
}) {
	const stories = `${storyCount} ${storyCount === 1 ? "story" : "stories"}`;
	const live =
		liveCount > 0
			? `${liveCount} of ${agentCount} agents at work`
			: `${agentCount} ${agentCount === 1 ? "agent" : "agents"}, none at work`;
	return (
		<header>
			<div className="flex h-12 items-center justify-between gap-4">
				<p className="truncate font-medium text-foreground text-xs">
					<time dateTime={new Date(now).toISOString()}>
						{mastheadDate(now)}
					</time>
				</p>
				<Button
					className="shrink-0"
					onClick={onSubmit}
					size="sm"
					type="button"
					variant="outline"
				>
					<PenLine aria-hidden="true" data-icon="inline-start" />
					Submit a story
				</Button>
			</div>
			<h1 className="pt-2 pb-4 text-center text-[2.5rem] text-foreground leading-none tracking-[-0.02em] sm:text-6xl lg:text-7xl">
				<span className="font-bold font-serif">{NEWSPAPER_NAME}</span>
			</h1>
			<div
				className={cn(
					"grid h-8 grid-cols-[1fr_auto_1fr] items-center gap-4 border-foreground border-t border-b-[3px] border-double text-foreground max-sm:grid-cols-1 max-sm:justify-items-center",
					SMALL_CAPS
				)}
			>
				<span className="truncate max-sm:hidden">{loading ? "" : stories}</span>
				<span>Today’s paper</span>
				<span className="truncate text-right max-sm:hidden">
					{loading ? "" : live}
				</span>
			</div>
			{nav.length > 0 ? (
				<nav
					aria-label="Sections"
					className="flex h-10 items-center gap-1 overflow-x-auto border-border border-b sm:justify-center"
				>
					{nav.map((item) => (
						<button
							className="h-7 shrink-0 cursor-pointer whitespace-nowrap rounded-sm px-2 font-medium text-[13px] text-foreground/80 underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
							key={item.anchor}
							onClick={() => onJump(item.anchor)}
							type="button"
						>
							{item.label}
						</button>
					))}
				</nav>
			) : null}
		</header>
	);
}

/** The article page's slim masthead: back to the front, the nameplate, the date. */
export function NewspaperArticleMasthead({
	now,
	onBack,
}: {
	now: number;
	onBack: () => void;
}) {
	return (
		<header className="grid h-12 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 border-foreground border-b-[3px] border-double px-2 sm:px-4">
			<div>
				<Button
					aria-keyshortcuts="Escape"
					onClick={onBack}
					size="sm"
					type="button"
					variant="ghost-muted"
				>
					<ArrowLeft aria-hidden="true" data-icon="inline-start" />
					<span className="max-sm:sr-only">Front page</span>
				</Button>
			</div>
			<p className="truncate font-bold font-serif text-foreground text-xl leading-none tracking-[-0.01em]">
				{NEWSPAPER_NAME}
			</p>
			<p className="truncate text-right font-medium text-muted-foreground text-xs max-sm:hidden">
				<time dateTime={new Date(now).toISOString()}>{mastheadDate(now)}</time>
			</p>
		</header>
	);
}
