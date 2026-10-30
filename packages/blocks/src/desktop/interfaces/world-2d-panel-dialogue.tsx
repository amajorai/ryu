import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceAgent,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { threadStatus } from "@ryuhq/protocol/interfaces";
import { type ReactNode, useContext, useId } from "react";
import { compactAge } from "./interface-renderer.ts";
import { frameStyle, SV_TEXT } from "./world-2d-frame.ts";
import { QuestMark, WorkingDots } from "./world-2d-hud.tsx";
import {
	needsYou,
	type VillagerStatus,
	villagerStatusLabel,
} from "./world-2d-model.ts";
import { SV_UI } from "./world-2d-palette.ts";
import {
	villagerLine,
	World2dActed,
	World2dActLines,
} from "./world-2d-panel-lines.ts";
import { UI_TYPE } from "./world-2d-panel-type.ts";
import { PixelPortrait } from "./world-2d-portrait.tsx";

/**
 * The pointing glove Stardew shows beside the current choice: the hovered
 * or focused one, and the first one while the list is at rest.
 */
function ChoiceGlove() {
	return (
		<span aria-hidden="true" className="flex w-[18px] shrink-0 justify-center">
			<svg
				className="invisible group-hover:visible group-focus-visible:visible [ul:not(:hover):not(:focus-within)>li:first-child_&]:visible"
				height="14"
				shapeRendering="crispEdges"
				viewBox="0 0 9 7"
				width="18"
			>
				<path
					d="M0 1h5v-1h2v1h1v1h1v3h-1v1h-1v1h-5v-1h-1v-1h-1z"
					fill={SV_UI.woodDark}
				/>
				<path d="M1 2h5v-1h1v1h1v3h-1v1h-4v-1h-2z" fill={SV_UI.plankInk} />
				<path d="M3 4h4v1h-4z" fill={SV_UI.inkShadow} />
			</svg>
		</span>
	);
}

/** A status mark for a villager or a conversation (nothing when quiet). */
function StatusMark({ status }: { status: VillagerStatus }) {
	let glyph: ReactNode = null;
	if (status === "attention" || status === "your-turn") {
		glyph = <QuestMark size={12} tone={status} />;
	} else if (status === "working") {
		glyph = <WorkingDots />;
	}
	if (glyph === null) {
		return null;
	}
	// A cap-height box, like the clock's tally rows, so the glyph centers on
	// the label instead of sitting on its baseline.
	return (
		<span className="flex h-3 w-4 shrink-0 items-center justify-center">
			{glyph}
		</span>
	);
}

/** The villager's framed portrait over a flat name plate. */
function PortraitCard({
	agent,
	lookIndex,
	small,
}: {
	agent: InterfaceAgent;
	lookIndex: number;
	small: boolean;
}) {
	return (
		<figure className="flex shrink-0 flex-col items-stretch gap-2 self-stretch">
			<div
				className="flex items-end justify-center overflow-hidden"
				style={frameStyle("slot", 2)}
			>
				{/* A narrow panel (or an open thread) gets the 2x bust. */}
				<PixelPortrait
					agentId={agent.id}
					className={cn("-mb-[4px]", small ? null : "@sm:hidden")}
					crop="bust"
					lookIndex={lookIndex}
					scale={2}
					working={agent.status === "working"}
				/>
				{small ? null : (
					<PixelPortrait
						agentId={agent.id}
						className="-mb-[4px] @sm:block hidden"
						crop="bust"
						lookIndex={lookIndex}
						scale={3}
						working={agent.status === "working"}
					/>
				)}
			</div>
			<figcaption
				className={cn(
					"mt-auto max-w-[148px] truncate border-(--sv-slot-shade) border-t-2 pt-2 text-center text-[16px] leading-5",
					UI_TYPE
				)}
			>
				{agent.name}
			</figcaption>
		</figure>
	);
}

/**
 * The dialogue box: the villager's line beside the portrait, their role
 * under it, and where they stand with you on the bottom rule. With a thread
 * open, the line and the status speak about that thread and the portrait
 * shrinks to leave the room to the chat below.
 */
export function DialogueBox({
	agent,
	compact,
	lookIndex,
	openThread,
	status,
	threads,
}: {
	agent: InterfaceAgent;
	/** A thread is open below: keep the box short. */
	compact: boolean;
	lookIndex: number;
	openThread: InterfaceThread | null;
	status: VillagerStatus;
	threads: readonly InterfaceThread[];
}) {
	const tl = useLiteralMessages();
	const shown: VillagerStatus = openThread ? threadStatus(openThread) : status;
	const actLines = useContext(World2dActLines);
	const actLine = openThread ? null : actLines?.get(agent.id);
	const alert = needsYou(shown);
	let label = "First visit";
	if (openThread || threads.length > 0 || status !== "idle") {
		label = villagerStatusLabel(shown);
	}
	return (
		<section
			aria-label={tl("{name} says", { name: agent.name })}
			className="flex shrink-0 items-stretch gap-4 p-1"
			style={{ ...frameStyle("wood"), ...SV_TEXT }}
		>
			<div className="flex min-w-0 flex-1 flex-col gap-2">
				<p className={cn("text-[16px] leading-6", UI_TYPE)}>
					{actLine ?? villagerLine(agent, threads, status, compact, openThread)}
				</p>
				{agent.description ? (
					<p
						className={cn(
							"text-(--sv-ink-soft) text-[16px] leading-6",
							UI_TYPE
						)}
					>
						<span className="sr-only">Role: </span>
						{agent.description}
					</p>
				) : null}
				<p
					className={cn(
						"mt-auto flex flex-wrap items-center gap-x-2 border-(--sv-ink-shadow) border-t-2 pt-2 text-[16px] leading-5",
						UI_TYPE
					)}
				>
					<StatusMark status={shown} />
					<span className={alert ? undefined : "text-(--sv-ink-soft)"}>
						{label}
					</span>
				</p>
			</div>
			<PortraitCard agent={agent} lookIndex={lookIndex} small={compact} />
		</section>
	);
}

/**
 * Past conversations as Stardew dialogue choices: the parchment fills the
 * column down to the reply box (its rows scroll past that). The glove
 * and the highlight mark the current choice:
 * the hovered or focused row, or the latest one while the list is at rest.
 */
export function DialogueChoices({
	onOpen,
	threads,
}: {
	onOpen: (threadId: string) => void;
	threads: InterfaceThread[];
}) {
	const acted = useContext(World2dActed);
	const headingId = useId();
	return (
		<section
			aria-labelledby={headingId}
			className="flex min-h-[132px] flex-1 flex-col gap-2 p-1"
			style={{ ...frameStyle("wood"), ...SV_TEXT }}
		>
			<h3
				className={cn(
					"flex items-baseline justify-between text-[16px] leading-none",
					UI_TYPE
				)}
				id={headingId}
			>
				Past conversations
				{threads.length > 0 ? (
					<span className="text-(--sv-ink-soft) tabular-nums">
						{threads.length}
					</span>
				) : null}
			</h3>
			{threads.length === 0 ? (
				<p
					className={cn(
						"border-(--sv-ink-shadow) border-t-2 pt-2 text-(--sv-ink-soft) text-[16px] leading-6",
						UI_TYPE
					)}
				>
					Nothing yet. Say something below to start your first conversation.
				</p>
			) : (
				<ul className="-mx-1 flex min-h-0 flex-1 flex-col overflow-y-auto border-(--sv-ink-shadow) border-t-2 px-1 pt-1 [scrollbar-color:var(--sv-slot-shade)_transparent] [scrollbar-width:thin]">
					{threads.map((thread) => {
						const status = threadStatus(thread);
						// With acts a thread's legacy status and age would contradict them.
						const marked = !acted && status !== "quiet" && status !== "waiting";
						return (
							<li key={thread.id}>
								<button
									className={cn(
										"group flex h-9 w-full items-center gap-2 border-2 border-transparent pr-2 text-left text-[16px] leading-none outline-none hover:border-(--sv-key-shade) hover:bg-(--sv-parchment-deep) focus-visible:border-(--sv-wood-dark) focus-visible:bg-(--sv-parchment-deep) [ul:not(:hover):not(:focus-within)>li:first-child_&]:border-(--sv-key-shade) [ul:not(:hover):not(:focus-within)>li:first-child_&]:bg-(--sv-parchment-deep)",
										UI_TYPE
									)}
									onClick={() => onOpen(thread.id)}
									type="button"
								>
									<ChoiceGlove />
									<span className="min-w-0 flex-1 truncate">
										{thread.title || "Untitled"}
									</span>
									<span className="flex w-4 shrink-0 justify-center">
										{marked ? (
											<>
												<StatusMark status={status} />
												<span className="sr-only">
													{`, ${villagerStatusLabel(status)}`}
												</span>
											</>
										) : null}
									</span>
									{acted ? null : (
										<span className="w-8 shrink-0 text-right text-(--sv-ink-soft) text-[16px] tabular-nums">
											{compactAge(thread.updatedAt)}
										</span>
									)}
								</button>
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}
