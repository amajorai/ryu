import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { ArrowUp } from "lucide-react";
import {
	type FormEvent,
	type KeyboardEvent,
	type ReactNode,
	type Ref,
	type RefObject,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { HubCardEmpty, HubCardFrame, useHubRows } from "./hub-card.tsx";
import { HUB_CARD_LABELS, hubAgentLive } from "./hub-model.ts";
import { HubAvatar } from "./hub-parts.tsx";

const AGENT_GRID_LIMIT = 6;
const MAX_PROMPT_LENGTH = 8000;

export function HubAgentsCard({
	agents,
	cardRef,
	index,
	onPickAgent,
	runs,
}: {
	agents: InterfaceAgent[];
	cardRef?: Ref<HTMLElement>;
	index: number;
	onPickAgent: (agentId: string) => void;
	runs: Map<string, number>;
}) {
	const tl = useLiteralMessages();
	const { footer, shown } = useHubRows(agents, AGENT_GRID_LIMIT);
	const working = agents.filter((agent) => hubAgentLive(agent, runs)).length;
	return (
		<HubCardFrame
			cardRef={cardRef}
			footer={footer}
			headline={
				agents.length > 0
					? tl("{working} of {length} working", {
							length: agents.length,
							working,
						})
					: "No agents yet"
			}
			id="agents"
			index={index}
			label={HUB_CARD_LABELS.agents}
		>
			{shown.length === 0 ? (
				<HubCardEmpty detail="Agents you create appear here." />
			) : (
				<ul className="-mx-3 grid grid-cols-3 gap-y-2 pb-1">
					{shown.map((agent) => {
						const live = hubAgentLive(agent, runs);
						const count = runs.get(agent.id) ?? 0;
						const state = live
							? `Working${count > 1 ? ` on ${count}` : ""}`
							: "Idle";
						let label = tl("Message {name}, idle", { name: agent.name });
						if (live) {
							label =
								count > 1
									? tl("Message {name}, working on {count}", {
											count,
											name: agent.name,
										})
									: tl("Message {name}, working", { name: agent.name });
						}
						return (
							<li key={agent.id}>
								<button
									aria-label={label}
									className="flex w-full flex-col items-center gap-2.5 rounded-2xl px-2 pt-4 pb-3 outline-none transition-colors duration-150 hover:bg-muted/70 focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:ring-inset active:bg-muted"
									onClick={() => onPickAgent(agent.id)}
									title={agent.description || agent.name}
									type="button"
								>
									<span
										className={cn(
											"rounded-full p-0.5 ring-2",
											live ? "ring-success" : "ring-transparent"
										)}
									>
										<HubAvatar agent={agent} className="size-16 text-[28px]" />
									</span>
									<span className="flex max-w-full flex-col items-center">
										<span className="max-w-full truncate font-medium text-[17px] text-foreground leading-6">
											{agent.name}
										</span>
										<span
											className={cn(
												"text-sm leading-5",
												live
													? "font-medium text-foreground"
													: "text-muted-foreground"
											)}
										>
											{state}
										</span>
									</span>
								</button>
							</li>
						);
					})}
				</ul>
			)}
		</HubCardFrame>
	);
}

/**
 * The start card: pick an agent, type, send. Recipients come idle-first, so
 * the default pick is an agent free to start now. Submitting is the explicit user
 * action that lets the host send the prompt immediately.
 */
export function HubComposeCard({
	agentId,
	agents,
	cardRef,
	fieldRef,
	index,
	onPickAgent,
	onSubmit,
	topic,
}: {
	agentId: string | undefined;
	agents: InterfaceAgent[];
	cardRef?: Ref<HTMLElement>;
	fieldRef: RefObject<HTMLTextAreaElement | null>;
	index: number;
	onPickAgent: (agentId: string) => void;
	onSubmit: (input: { agentId?: string; prompt: string }) => void;
	/** What the user came to ask about (a failed run), shown as the hint. */
	topic?: string;
}) {
	const tl = useLiteralMessages();
	const fieldId = useId();
	const hintId = useId();
	const [prompt, setPrompt] = useState("");
	const trimmed = prompt.trim();
	// Resolve on every render so a pick that is no longer offered never sends
	// to a hidden agent: what is highlighted is what gets sent.
	const recipient =
		agents.find((agent) => agent.id === agentId) ?? agents[0] ?? undefined;

	const submit = () => {
		if (!trimmed) {
			return;
		}
		onSubmit({ agentId: recipient?.id, prompt: trimmed });
		setPrompt("");
	};
	const onFormSubmit = (event: FormEvent) => {
		event.preventDefault();
		submit();
	};
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Escape") {
			event.currentTarget.blur();
			return;
		}
		if (
			event.key === "Enter" &&
			!event.shiftKey &&
			!event.nativeEvent.isComposing
		) {
			event.preventDefault();
			submit();
		}
	};
	const onChipKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (!recipient) {
			return;
		}
		const at = agents.indexOf(recipient);
		let next: InterfaceAgent | undefined;
		if (event.key === "ArrowRight" || event.key === "ArrowDown") {
			next = agents[(at + 1) % agents.length];
		} else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
			next = agents[(at - 1 + agents.length) % agents.length];
		}
		if (!next) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		onPickAgent(next.id);
		const target = event.currentTarget.querySelector<HTMLElement>(
			`[data-agent='${next.id}']`
		);
		target?.focus();
	};

	return (
		<HubCardFrame
			cardRef={cardRef}
			className="w-(--hub-card-wide)"
			id="compose"
			index={index}
			label={HUB_CARD_LABELS.compose}
		>
			<form
				className="flex min-h-0 flex-1 flex-col pb-2"
				onSubmit={onFormSubmit}
			>
				{agents.length > 0 ? (
					<RecipientRow onKeyDown={onChipKeyDown}>
						{agents.map((agent) => {
							const selected = agent.id === recipient?.id;
							return (
								<button
									aria-checked={selected}
									className={cn(
										"inline-flex h-11 shrink-0 items-center gap-2 rounded-full pr-4 pl-1.5 font-medium text-sm outline-none transition-colors duration-150 focus-visible:ring-3 focus-visible:ring-ring/40",
										selected
											? "bg-primary text-primary-foreground"
											: "text-foreground ring-1 ring-border ring-inset hover:bg-muted/70"
									)}
									data-agent={agent.id}
									key={agent.id}
									onClick={() => onPickAgent(agent.id)}
									role="radio"
									tabIndex={selected ? 0 : -1}
									type="button"
								>
									<HubAvatar agent={agent} className="size-8 text-sm" />
									{agent.name}
								</button>
							);
						})}
					</RecipientRow>
				) : null}
				<label className="sr-only" htmlFor={fieldId}>
					{recipient
						? tl("Message {name}", { name: recipient.name })
						: "Message"}
				</label>
				<textarea
					aria-describedby={hintId}
					className="mt-5 min-h-18 w-full flex-1 resize-none bg-transparent text-[28px] text-foreground leading-9 tracking-[-0.01em] outline-none placeholder:text-muted-foreground"
					id={fieldId}
					maxLength={MAX_PROMPT_LENGTH}
					onChange={(event) => setPrompt(event.target.value)}
					onKeyDown={onKeyDown}
					placeholder={composePlaceholder(tl, recipient, topic)}
					ref={fieldRef}
					rows={2}
					value={prompt}
				/>
				<div className="mt-auto flex shrink-0 items-center justify-between gap-3 pt-4">
					<p
						className="text-muted-foreground text-sm leading-5 max-md:sr-only"
						id={hintId}
					>
						Shift + Enter for a new line
					</p>
					<Button
						className="ml-auto h-12 gap-2 rounded-full pr-6 pl-5 font-medium text-[17px]"
						disabled={!trimmed}
						type="submit"
					>
						<ArrowUp aria-hidden="true" className="size-5" />
						Send
					</Button>
				</div>
			</form>
		</HubCardFrame>
	);
}

function composePlaceholder(
	tl: LiteralMessage,
	recipient: InterfaceAgent | undefined,
	topic: string | undefined
): string {
	if (topic) {
		return recipient
			? tl("Ask {name} about {topic}", { name: recipient.name, topic })
			: tl("Ask about {topic}", { topic });
	}
	return recipient
		? tl("What should {name} do?", { name: recipient.name })
		: "What do you need?";
}

/**
 * The recipient chips: one row that scrolls sideways when the agents do not
 * fit, fading the edge that has more behind it.
 */
function RecipientRow({
	children,
	onKeyDown,
}: {
	children: ReactNode;
	onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
	const rowRef = useRef<HTMLDivElement>(null);
	const [edges, setEdges] = useState({ end: false, start: false });
	const measure = useCallback(() => {
		const row = rowRef.current;
		if (!row) {
			return;
		}
		const start = row.scrollLeft > 1;
		const end = row.scrollLeft + row.clientWidth < row.scrollWidth - 1;
		setEdges((current) =>
			current.start === start && current.end === end ? current : { end, start }
		);
	}, []);
	useEffect(() => {
		measure();
		const row = rowRef.current;
		if (!(row && typeof ResizeObserver !== "undefined")) {
			return;
		}
		const observer = new ResizeObserver(measure);
		observer.observe(row);
		return () => observer.disconnect();
	}, [measure]);
	return (
		<div
			aria-label="Send to"
			className={cn(
				"-mx-6 flex gap-2 overflow-x-auto px-6 py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
				edges.end && "mask-r-from-[calc(100%-4rem)]",
				edges.start && "mask-l-from-[calc(100%-4rem)]"
			)}
			data-testid="hub-recipients"
			onKeyDown={onKeyDown}
			onPointerDown={(event) => event.stopPropagation()}
			onScroll={measure}
			ref={rowRef}
			role="radiogroup"
		>
			{children}
		</div>
	);
}
