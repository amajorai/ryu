import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { CornerDownLeft } from "lucide-react";
import type { RefObject } from "react";
import { compactAge } from "./interface-renderer.ts";
import { PersonaComposer } from "./persona-composer.tsx";
import { fullTime, type PersonaIdeaGroup } from "./persona-model.ts";
import {
	PageColumn,
	PageIntro,
	PERSONA_COLUMN,
	SectionLabel,
} from "./persona-parts.tsx";

/**
 * Ideas: prompt suggestions built from the persona's description and its
 * recent conversations. Picking one only fills the composer; the user edits
 * it and sends it, which is what starts the chat.
 */
export function PersonaIdeas({
	agent,
	draft,
	fieldRef,
	groups,
	onDraftChange,
	onPick,
	onSend,
}: {
	agent: InterfaceAgent;
	draft: string;
	fieldRef: RefObject<HTMLTextAreaElement | null>;
	groups: PersonaIdeaGroup[];
	onDraftChange: (value: string) => void;
	onPick: (prompt: string) => void;
	onSend: (prompt: string) => void;
}) {
	const picked = draft.trim();
	const tl = useLiteralMessages();
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageColumn>
				<PageIntro
					description={tl(
						"Starting points for a new chat with {name}. Pick one, edit it, then send.",
						{ name: agent.name }
					)}
					id="persona-ideas-title"
					title="Ideas"
				/>
				{groups.map((group) => (
					<section
						aria-labelledby={`persona-ideas-${group.key}`}
						key={group.key}
					>
						<SectionLabel id={`persona-ideas-${group.key}`}>
							{group.label}
						</SectionLabel>
						<ul className="-mx-3 flex flex-col">
							{group.ideas.map((idea) => {
								const selected = picked === idea.prompt;
								return (
									<li key={idea.id}>
										<button
											aria-pressed={selected}
											className={cn(
												"group/idea flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
												selected ? "bg-accent" : "hover:bg-muted"
											)}
											data-persona-idea={idea.id}
											onClick={() => onPick(idea.prompt)}
											type="button"
										>
											<span className="min-w-0 flex-1 text-sm">
												{idea.prompt}
											</span>
											<span className="relative flex h-5 min-w-4 shrink-0 items-center justify-end">
												{idea.updatedAt ? (
													<time
														className={cn(
															"text-muted-foreground text-xs tabular-nums transition-opacity",
															selected
																? "opacity-0"
																: "group-hover/idea:opacity-0 group-focus-visible/idea:opacity-0"
														)}
														dateTime={idea.updatedAt}
														title={fullTime(idea.updatedAt)}
													>
														{compactAge(idea.updatedAt)}
													</time>
												) : null}
												<CornerDownLeft
													aria-hidden="true"
													className={cn(
														"absolute right-0 size-4 text-muted-foreground transition-opacity",
														selected
															? "opacity-100"
															: "opacity-0 group-hover/idea:opacity-100 group-focus-visible/idea:opacity-100"
													)}
												/>
											</span>
										</button>
									</li>
								);
							})}
						</ul>
					</section>
				))}
			</PageColumn>
			<div className="shrink-0 border-border border-t bg-background">
				<div className={cn(PERSONA_COLUMN, "py-3")}>
					<PersonaComposer
						fieldRef={fieldRef}
						hint={
							picked
								? tl("Sending starts a new side chat with {name}.", {
										name: agent.name,
									})
								: undefined
						}
						label={tl("New chat with {name}", { name: agent.name })}
						onChange={onDraftChange}
						onSubmit={onSend}
						placeholder="Pick an idea or write your own"
						value={draft}
					/>
				</div>
			</div>
		</div>
	);
}
