import { useLiteralMessages } from "@ryu/i18n/react";
import { ScrollArea } from "@ryu/ui/components/scroll-area.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import { type Ref, useId } from "react";
import { InterfaceComposer } from "./interface-composer.tsx";
import {
	type PlanetSystem,
	sectionThreads,
	threadsWaitingOnYou,
} from "./planets-model.ts";
import type { PlanetsPalette } from "./planets-palette.ts";
import {
	CloseButton,
	EmptyNote,
	HEADING,
	SCROLL_FADE,
	Stat,
} from "./planets-panel-parts.tsx";
import { SunSwatch, ThreadSections } from "./planets-parts.tsx";

export function StarPane({
	activeThreadId,
	headingRef,
	now,
	onClose,
	onMessage,
	onOpen,
	palette,
	snapshot,
	system,
}: {
	activeThreadId: string | null;
	headingRef: Ref<HTMLHeadingElement>;
	now: number;
	onClose: () => void;
	onMessage: (input: { agentId?: string; prompt: string }) => void;
	onOpen: (threadId: string) => void;
	palette: PlanetsPalette;
	snapshot: InterfaceSnapshot;
	system: PlanetSystem;
}) {
	const tl = useLiteralMessages();
	const waitingId = useId();
	const orbitId = useId();
	const waiting = threadsWaitingOnYou(snapshot);
	const unassigned = sectionThreads(system.unassigned);
	const { summary } = system;
	return (
		<>
			<header className="flex shrink-0 items-start gap-3 border-border border-b p-4">
				<SunSwatch className="mt-0.5 size-11" palette={palette} />
				<div className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
					<h2
						className={cn(HEADING, "text-base")}
						ref={headingRef}
						tabIndex={-1}
					>
						You
					</h2>
					<p className="truncate text-muted-foreground text-xs">
						{tl(
							"The star of this system · {count, plural, one {{countText} planet} other {{countText} planets}}",
							{ count: summary.agents, countText: String(summary.agents) }
						)}
					</p>
				</div>
				<CloseButton label="Close panel" onClose={onClose} />
			</header>
			<ScrollArea className={SCROLL_FADE}>
				<div className="flex flex-col gap-5 p-4 pb-7">
					<dl className="grid grid-cols-3 divide-x divide-border overflow-hidden rounded-xl border border-border bg-card">
						<Stat label="Threads" value={summary.threads} />
						<Stat
							label="Waiting on you"
							tone={summary.attention > 0 ? "attention" : "your-turn"}
							value={summary.waitingOnYou}
						/>
						<Stat
							label="Working"
							tone={summary.working > 0 ? "working" : undefined}
							value={summary.working}
						/>
					</dl>
					<section aria-labelledby={waitingId} className="flex flex-col gap-2">
						<h3
							className="px-2 font-heading font-semibold text-foreground text-sm"
							id={waitingId}
						>
							Waiting on you
						</h3>
						{waiting.length === 0 ? (
							<EmptyNote>You're all caught up.</EmptyNote>
						) : (
							<ThreadSections
								activeThreadId={activeThreadId}
								now={now}
								onOpen={onOpen}
								sections={sectionThreads(waiting)}
								snapshot={snapshot}
							/>
						)}
					</section>
					{unassigned.length > 0 ? (
						<section aria-labelledby={orbitId} className="flex flex-col gap-2">
							<h3
								className="px-2 font-heading font-semibold text-foreground text-sm"
								id={orbitId}
							>
								Your own orbit
								<span className="ms-2 font-normal text-muted-foreground text-xs">
									Threads no agent is on
								</span>
							</h3>
							<ThreadSections
								activeThreadId={activeThreadId}
								now={now}
								onOpen={onOpen}
								sections={unassigned}
								snapshot={snapshot}
							/>
						</section>
					) : null}
				</div>
			</ScrollArea>
			{snapshot.agents.length > 0 ? (
				<div
					className="shrink-0 border-border border-t bg-background p-3"
					data-planets-composer=""
				>
					<InterfaceComposer
						agents={snapshot.agents}
						label="Start a thread"
						onSubmit={onMessage}
						placeholder="Ask any agent…"
						submitLabel="Send"
					/>
				</div>
			) : null}
		</>
	);
}
