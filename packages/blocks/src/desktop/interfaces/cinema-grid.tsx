import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { MessageSquarePlus } from "lucide-react";
import type { ReactNode } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import { CINEMA_GAP, type CinemaTitle } from "./cinema-model.ts";
import { CinemaPoster } from "./cinema-poster.tsx";

export interface CinemaGridProps {
	activeThreadId: string | null;
	/** The agent a collection belongs to, for its header and New thread. */
	agent: InterfaceAgent | null;
	empty: ReactNode;
	gutter: number;
	heading: string;
	onHoverEnd: () => void;
	onHoverStart: (element: HTMLElement, title: CinemaTitle) => void;
	onNew: (agentId: string) => void;
	onSelect: (threadId: string, opener: HTMLElement) => void;
	perRow: number;
	subheading?: string;
	titles: readonly CinemaTitle[];
}

/**
 * A collection's own page ("Explore all", a nav link, or search results):
 * the heading, then every title as a grid of posters at the rows' width.
 */
export function CinemaGrid({
	activeThreadId,
	agent,
	empty,
	gutter,
	heading,
	onHoverEnd,
	onHoverStart,
	onNew,
	onSelect,
	perRow,
	subheading,
	titles,
}: CinemaGridProps) {
	const tl = useLiteralMessages();
	return (
		<section
			aria-label={heading}
			className="flex flex-col pt-24 pb-16"
			style={{ paddingInline: gutter }}
		>
			<div className="flex min-h-10 flex-wrap items-center gap-x-4 gap-y-2">
				{agent ? (
					<BoardAvatar agent={agent} name={agent.name} size={28} />
				) : null}
				<div className="flex min-w-0 flex-col">
					<h1 className="truncate text-2xl text-foreground leading-8 tracking-tight">
						<span className="font-semibold">{heading}</span>
					</h1>
					{subheading ? (
						<p className="truncate text-muted-foreground text-sm leading-5">
							{subheading}
						</p>
					) : null}
				</div>
				{agent ? (
					<Button
						className="ml-auto gap-2 rounded-sm"
						onClick={() => onNew(agent.id)}
						size="sm"
						type="button"
						variant="outline"
					>
						<MessageSquarePlus aria-hidden="true" className="size-4" />
						{tl("New thread with {name}", { name: agent.name })}
					</Button>
				) : null}
			</div>
			{titles.length > 0 ? (
				<ul
					className="mt-6 grid gap-y-10"
					style={{
						columnGap: CINEMA_GAP,
						gridTemplateColumns: `repeat(${perRow.toString()}, minmax(0, 1fr))`,
					}}
				>
					{titles.map((title) => (
						<li key={title.thread.id}>
							<CinemaPoster
								current={title.thread.id === activeThreadId}
								layout="boxart"
								onHoverEnd={onHoverEnd}
								onHoverStart={onHoverStart}
								onSelect={onSelect}
								title={title}
							/>
						</li>
					))}
				</ul>
			) : (
				<div className="mt-6">{empty}</div>
			)}
		</section>
	);
}
