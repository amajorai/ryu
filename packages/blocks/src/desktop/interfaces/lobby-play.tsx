import { useLiteralMessages } from "@ryu/i18n/react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { ChevronDown, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
	type FormEvent,
	type KeyboardEvent,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { GAME_FOCUS, GAME_PLATE } from "./game-hud.tsx";
import type { LobbyMember } from "./lobby-model.ts";
import {
	ChunkyButton,
	DISPLAY,
	KICKER,
	LobbyHead,
	LobbyStateChip,
} from "./lobby-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

export interface LobbyStartInput {
	agentId: string;
	prompt: string;
}

const MAX_PROMPT_LENGTH = 8000;

/**
 * The bottom-right corner of the lobby: the mode card (which squad member the
 * next match goes to, with a picker) over a huge PLAY button. PLAY swaps the
 * card for a one-line brief in the same spot; submitting it is the user's
 * explicit send, so the prompt goes straight to `startThread`.
 */
export function LobbyPlay({
	acted = false,
	members,
	onPick,
	onStart,
	selected,
	squadIds,
}: {
	/** The act layer is on: the picker shows no legacy state chips. */
	acted?: boolean;
	members: LobbyMember[];
	onPick: (agentId: string) => void;
	onStart: (input: LobbyStartInput) => void;
	selected: InterfaceAgent | undefined;
	squadIds: string[];
}) {
	const tl = useLiteralMessages();
	const reduceMotion = useReducedMotion();
	const formId = useId();
	const fieldId = useId();
	const [open, setOpen] = useState(false);
	const [prompt, setPrompt] = useState("");
	const fieldRef = useRef<HTMLTextAreaElement>(null);
	const playRef = useRef<HTMLButtonElement>(null);
	const trimmed = prompt.trim();
	const briefing = open && selected !== undefined;

	useEffect(() => {
		if (open) {
			fieldRef.current?.focus();
		}
	}, [open]);

	const close = () => {
		setOpen(false);
		playRef.current?.focus();
	};
	const submit = () => {
		if (!(trimmed && selected)) {
			return;
		}
		onStart({ agentId: selected.id, prompt: trimmed });
		setPrompt("");
		setOpen(false);
	};
	const onSubmit = (event: FormEvent) => {
		event.preventDefault();
		submit();
	};
	const onFieldKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			close();
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
	const squad = squadIds
		.map((id) => members.find((member) => member.agent.id === id))
		.filter((member) => member !== undefined);
	const bench = members.filter((member) => !squadIds.includes(member.agent.id));
	const pickItem = (member: LobbyMember) => (
		<DropdownMenuRadioItem
			className="h-10 gap-2.5 rounded-none ps-2 pe-8"
			closeOnClick
			key={member.agent.id}
			value={member.agent.id}
		>
			<LobbyHead
				agent={member.agent}
				className="size-6"
				state={acted ? "ready" : member.state}
			/>
			<span className="min-w-0 flex-1 truncate font-semibold text-[13px]">
				{member.agent.name}
			</span>
			{acted ? null : <LobbyStateChip state={member.state} />}
		</DropdownMenuRadioItem>
	);
	const transition = reduceMotion
		? { duration: 0 }
		: { duration: 0.16, ease: [0.2, 0, 0, 1] as const };

	return (
		<section
			aria-label="Next match"
			className={cn(
				GAME_PLATE,
				"flex @max-3xl:w-full w-[22rem] shrink-0 flex-col gap-3 p-3"
			)}
		>
			<div className="flex items-baseline gap-3 px-1">
				<h2 className="gk-display text-[19px] leading-6">
					{briefing ? "Brief" : "Mode"}
				</h2>
				{briefing ? (
					<p className="flex items-center gap-1.5 truncate font-semibold text-(--gk-ink-muted) text-[13px] leading-5">
						<Kbd className="h-4 text-[10px]">Enter</Kbd> to drop in
						<span aria-hidden="true">·</span>
						<Kbd className="h-4 text-[10px]">Esc</Kbd> to cancel
					</p>
				) : (
					<p
						className="truncate font-semibold text-(--gk-ink-muted) text-[13px] leading-5"
						data-testid="lobby-mode"
					>
						{selected
							? tl("Solo · new thread with {name}", { name: selected.name })
							: "Solo"}
					</p>
				)}
			</div>
			<div className="relative h-16">
				<AnimatePresence initial={false} mode="popLayout">
					{briefing ? (
						<motion.div
							animate={{ opacity: 1 }}
							className="absolute inset-0"
							exit={{ opacity: 0, transition: { duration: 0 } }}
							initial={{ opacity: 0 }}
							key="brief"
							transition={transition}
						>
							<div className="relative size-full rounded-xl border-(--gk-accent) border-2 bg-background">
								<form
									aria-label={tl("Brief for {name}", { name: selected.name })}
									className="relative flex size-full items-center gap-3 ps-3 pe-2"
									id={formId}
									onSubmit={onSubmit}
								>
									<LobbyHead agent={selected} className="size-10" />
									<label className="sr-only" htmlFor={fieldId}>
										{tl("Brief for {name}", { name: selected.name })}
									</label>
									<textarea
										className="h-10 min-w-0 flex-1 resize-none bg-transparent py-2.5 text-[15px] text-foreground leading-5 outline-none placeholder:text-muted-foreground"
										id={fieldId}
										maxLength={MAX_PROMPT_LENGTH}
										onChange={(event) => setPrompt(event.target.value)}
										onKeyDown={onFieldKeyDown}
										placeholder={tl("What should {name} do?", {
											name: selected.name,
										})}
										ref={fieldRef}
										rows={1}
										value={prompt}
									/>
									<button
										aria-label="Cancel brief"
										className="flex size-8 shrink-0 items-center justify-center text-foreground/80 outline-none transition-colors hover:bg-foreground/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
										onClick={close}
										title="Cancel (Esc)"
										type="button"
									>
										<X aria-hidden="true" className="size-4" />
									</button>
								</form>
							</div>
						</motion.div>
					) : (
						<motion.div
							animate={{ opacity: 1 }}
							className="absolute inset-0"
							exit={{ opacity: 0, transition: { duration: 0 } }}
							initial={{ opacity: 0 }}
							key="mode"
							transition={transition}
						>
							<div className="flex size-full items-center rounded-xl border-(--gk-edge)/15 border-2 bg-(--gk-plate-sunk)">
								<div className="relative flex size-full items-center gap-3 px-3">
									{selected ? (
										<LobbyHead agent={selected} className="size-10" />
									) : null}
									<span
										className={cn(
											DISPLAY,
											"min-w-0 flex-1 truncate pt-0.5 text-(--gk-ink) text-[26px]"
										)}
									>
										{selected ? selected.name : "No agent"}
									</span>
									<DropdownMenu>
										<DropdownMenuTrigger
											aria-label={
												selected
													? tl("Change mode, now {name}", {
															name: selected.name,
														})
													: "Change mode"
											}
											disabled={members.length === 0}
											render={
												<button
													className={cn(
														GAME_FOCUS,
														"gk-display inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl border-(--gk-edge) border-2 bg-(--gk-plate) px-3 text-(--gk-ink) text-[14px] shadow-[0_2px_0_var(--gk-edge)] transition-colors hover:bg-(--gk-plate-sunk) active:translate-y-px disabled:opacity-50 aria-expanded:bg-(--gk-plate-sunk) motion-reduce:active:translate-y-0"
													)}
													type="button"
												/>
											}
										>
											Change
											<ChevronDown aria-hidden="true" className="size-3.5" />
										</DropdownMenuTrigger>
										<DropdownMenuContent
											align="end"
											className="max-h-96 w-72 rounded-none border-border bg-popover p-1 shadow-lg backdrop-blur-none before:hidden"
											drawerLabel="Mode"
											side="top"
										>
											<DropdownMenuRadioGroup
												onValueChange={(value: unknown) => {
													if (typeof value === "string") {
														onPick(value);
													}
												}}
												value={selected?.id ?? ""}
											>
												<DropdownMenuGroup>
													<DropdownMenuLabel
														className={cn(
															KICKER,
															"px-2 pt-2 pb-1 text-[10px] text-foreground/80"
														)}
													>
														Squad
													</DropdownMenuLabel>
													{squad.map(pickItem)}
												</DropdownMenuGroup>
												{bench.length > 0 ? (
													<>
														<DropdownMenuSeparator className="mx-0 my-1" />
														<DropdownMenuGroup>
															<DropdownMenuLabel
																className={cn(
																	KICKER,
																	"px-2 pt-2 pb-1 text-[10px] text-foreground/80"
																)}
															>
																Roster
															</DropdownMenuLabel>
															{bench.map(pickItem)}
														</DropdownMenuGroup>
													</>
												) : null}
											</DropdownMenuRadioGroup>
										</DropdownMenuContent>
									</DropdownMenu>
								</div>
							</div>
						</motion.div>
					)}
				</AnimatePresence>
			</div>
			<ChunkyButton
				aria-label={
					briefing
						? tl("Drop in: send the brief to {name}", { name: selected.name })
						: selected
							? tl("Play with {name}", { name: selected.name })
							: "Play"
				}
				className={cn(
					DISPLAY,
					"@max-3xl:h-16 h-20 rounded-2xl @max-3xl:text-[40px] text-[56px]"
				)}
				disabled={!selected || (briefing && !trimmed)}
				form={briefing ? formId : undefined}
				onClick={
					briefing
						? undefined
						: () => {
								setOpen(true);
							}
				}
				ref={playRef}
				tone="primary"
				type={briefing ? "submit" : "button"}
			>
				{briefing ? "Drop in" : "Play"}
			</ChunkyButton>
		</section>
	);
}
