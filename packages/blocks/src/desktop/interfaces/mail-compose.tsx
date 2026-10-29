import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceAgent,
	InterfaceGroup,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { Minus, Tag, Trash2, X } from "lucide-react";
import { motion } from "motion/react";
import {
	type FormEvent,
	type KeyboardEvent,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import { agentHandle } from "./interface-renderer.ts";
import {
	type MailStartInput,
	mailRecipientMatches,
	mailStartInput,
} from "./mail-model.ts";
import { MailIconButton } from "./mail-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

const MAX_LENGTH = 8000;

const FIELD_ROW =
	"flex min-h-10 items-center gap-2 border-border/70 border-b px-4 text-sm";
const BARE_INPUT =
	"min-w-0 flex-1 bg-transparent text-foreground text-sm outline-none placeholder:text-muted-foreground";

function RecipientChip({
	agent,
	onRemove,
}: {
	agent: InterfaceAgent;
	onRemove: () => void;
}) {
	const tl = useLiteralMessages();
	return (
		<span
			className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-border bg-background pr-1 pl-0.5 text-foreground text-sm"
			data-testid="mail-compose-recipient"
		>
			<BoardAvatar agent={agent} name={agent.name} size={20} />
			{agent.name}
			<button
				aria-label={tl("Remove {name}", { name: agent.name })}
				className="flex size-5 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
				onClick={onRemove}
				type="button"
			>
				<X aria-hidden="true" className="size-3.5" />
			</button>
		</span>
	);
}

/**
 * The To field: Gmail's recipient autocomplete over the user's agents. One
 * recipient, because a new conversation starts with one agent.
 */
function RecipientField({
	agents,
	onChange,
	onChosen,
	recipient,
	snapshot,
}: {
	agents: InterfaceAgent[];
	onChange: (agentId: string | null) => void;
	/** Called after a pick, so focus can move on to the subject. */
	onChosen: () => void;
	recipient: InterfaceAgent | null;
	snapshot: InterfaceSnapshot;
}) {
	const tl = useLiteralMessages();
	const listId = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState("");
	const [expanded, setExpanded] = useState(false);
	const [activeIndex, setActiveIndex] = useState(0);
	const matches = mailRecipientMatches(snapshot, query);
	const active = matches[Math.min(activeIndex, matches.length - 1)];

	const choose = (agent: InterfaceAgent) => {
		onChange(agent.id);
		setQuery("");
		setExpanded(false);
		onChosen();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			setExpanded(true);
			const step = event.key === "ArrowDown" ? 1 : -1;
			setActiveIndex((index) =>
				matches.length === 0
					? 0
					: (index + step + matches.length) % matches.length
			);
			return;
		}
		if ((event.key === "Enter" || event.key === "Tab") && expanded && active) {
			event.preventDefault();
			choose(active);
			return;
		}
		if (event.key === "Backspace" && !query && recipient) {
			onChange(null);
			return;
		}
		if (event.key === "Escape" && expanded) {
			event.preventDefault();
			event.stopPropagation();
			setExpanded(false);
		}
	};

	return (
		<div className={cn(FIELD_ROW, "relative")}>
			<label
				className="shrink-0 text-muted-foreground"
				htmlFor={`${listId}-to`}
			>
				To
			</label>
			{recipient ? (
				<RecipientChip
					agent={recipient}
					onRemove={() => {
						onChange(null);
						inputRef.current?.focus();
					}}
				/>
			) : null}
			<input
				aria-activedescendant={
					expanded && active ? `${listId}-${active.id}` : undefined
				}
				aria-autocomplete="list"
				aria-controls={listId}
				aria-expanded={expanded}
				autoComplete="off"
				className={cn(BARE_INPUT, "h-10")}
				id={`${listId}-to`}
				onBlur={() => setExpanded(false)}
				onChange={(event) => {
					setQuery(event.target.value);
					setActiveIndex(0);
					setExpanded(true);
				}}
				onFocus={() => setExpanded(!recipient)}
				onKeyDown={onKeyDown}
				placeholder={recipient ? "" : "Choose an agent"}
				ref={inputRef}
				role="combobox"
				value={query}
			/>
			{expanded && agents.length > 0 ? (
				<div
					className="absolute top-full right-2 left-2 z-20 mt-1 max-h-60 overflow-y-auto rounded-lg border border-border bg-popover py-1 text-popover-foreground shadow-lg"
					id={listId}
					role="listbox"
				>
					{matches.length === 0 ? (
						<div className="px-3 py-2 text-muted-foreground text-sm">
							{tl("No agent matches “{query}”", { query: query.trim() })}
						</div>
					) : (
						matches.map((agent) => (
							<div
								aria-selected={agent.id === active?.id}
								className={cn(
									"flex cursor-default items-center gap-3 px-3 py-1.5",
									agent.id === active?.id && "bg-muted"
								)}
								id={`${listId}-${agent.id}`}
								key={agent.id}
								onMouseDown={(event) => {
									event.preventDefault();
									choose(agent);
								}}
								onMouseEnter={() => setActiveIndex(matches.indexOf(agent))}
								role="option"
								tabIndex={-1}
							>
								<BoardAvatar agent={agent} name={agent.name} size={28} />
								<span className="flex min-w-0 flex-col">
									<span className="truncate text-foreground text-sm">
										{agent.name}
										<span className="ml-1.5 text-muted-foreground text-xs">
											{agentHandle(agent.name)}
										</span>
									</span>
									<span className="truncate text-muted-foreground text-xs">
										{agent.description}
									</span>
								</span>
							</div>
						))
					)}
				</div>
			) : null}
		</div>
	);
}

/**
 * Gmail's compose window, docked bottom-right. Sending is the explicit user
 * action that lets the host send at once: subject and body become the first
 * message of a new conversation with the chosen agent.
 */
export function MailCompose({
	defaultAgentId,
	label,
	onClose,
	onSend,
	snapshot,
}: {
	defaultAgentId: string | null;
	/** The label being viewed; a new conversation is filed under it. */
	label: InterfaceGroup | null;
	onClose: () => void;
	onSend: (input: MailStartInput) => void;
	snapshot: InterfaceSnapshot;
}) {
	const tl = useLiteralMessages();
	const reduceMotion = useReducedMotion();
	const titleId = useId();
	const subjectRef = useRef<HTMLInputElement>(null);
	const toRef = useRef<HTMLDivElement>(null);
	const [minimized, setMinimized] = useState(false);
	const [agentId, setAgentId] = useState<string | null>(defaultAgentId);
	const [subject, setSubject] = useState("");
	const [body, setBody] = useState("");
	const [labelId, setLabelId] = useState<string | null>(label?.id ?? null);
	const agents = snapshot.agents;
	const recipient = agents.find((agent) => agent.id === agentId) ?? null;
	const filedUnder = labelId
		? (snapshot.groups.find((group) => group.id === labelId) ?? null)
		: null;
	const needsRecipient = agents.length > 0 && !recipient;
	const input = mailStartInput(snapshot, {
		agentId: recipient?.id ?? null,
		body,
		labelId,
		subject,
	});
	const canSend = input !== null && !needsRecipient;

	// Focus the first field that still needs the user: To, else Subject.
	useEffect(() => {
		if (agents.length > 0 && !defaultAgentId) {
			toRef.current?.querySelector("input")?.focus();
		} else {
			subjectRef.current?.focus();
		}
	}, [agents.length, defaultAgentId]);

	const send = () => {
		if (input && canSend) {
			onSend(input);
		}
	};
	const onSubmit = (event: FormEvent) => {
		event.preventDefault();
		send();
	};
	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			send();
			return;
		}
		if (event.key === "Escape" && !event.defaultPrevented) {
			event.preventDefault();
			onClose();
		}
	};

	return (
		<motion.section
			animate={{ opacity: 1, y: 0 }}
			aria-labelledby={titleId}
			className={cn(
				"pointer-events-auto absolute right-4 bottom-0 z-30 flex flex-col overflow-hidden rounded-t-xl border border-border border-b-0 bg-background shadow-2xl",
				minimized
					? "w-72"
					: "h-[min(520px,calc(100%-4rem))] w-[min(540px,calc(100%-2rem))]"
			)}
			data-minimized={minimized ? "" : undefined}
			data-testid="mail-compose"
			initial={reduceMotion ? false : { opacity: 0, y: 24 }}
			onKeyDown={onKeyDown}
			transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
		>
			<header className="flex h-10 shrink-0 items-center gap-1 bg-muted pr-1 pl-4">
				<button
					className="min-w-0 flex-1 truncate text-left font-medium text-foreground text-sm outline-none focus-visible:underline"
					id={titleId}
					onClick={() => setMinimized(!minimized)}
					type="button"
				>
					{subject.trim() || "New Message"}
				</button>
				<MailIconButton
					className="size-8"
					label={minimized ? "Expand" : "Minimize"}
					onClick={() => setMinimized(!minimized)}
					side="top"
				>
					<Minus aria-hidden="true" className="size-4" />
				</MailIconButton>
				<MailIconButton
					className="size-8"
					label="Close"
					onClick={onClose}
					side="top"
				>
					<X aria-hidden="true" className="size-4" />
				</MailIconButton>
			</header>
			{minimized ? null : (
				<form className="flex min-h-0 flex-1 flex-col" onSubmit={onSubmit}>
					{agents.length > 0 ? (
						<div ref={toRef}>
							<RecipientField
								agents={agents}
								onChange={setAgentId}
								onChosen={() => subjectRef.current?.focus()}
								recipient={recipient}
								snapshot={snapshot}
							/>
						</div>
					) : null}
					<div className={FIELD_ROW}>
						<input
							aria-label="Subject"
							className={cn(BARE_INPUT, "h-10")}
							maxLength={MAX_LENGTH}
							onChange={(event) => setSubject(event.target.value)}
							placeholder="Subject"
							ref={subjectRef}
							value={subject}
						/>
					</div>
					<textarea
						aria-label="Message body"
						className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 text-foreground text-sm leading-6 outline-none placeholder:text-muted-foreground"
						maxLength={MAX_LENGTH}
						onChange={(event) => setBody(event.target.value)}
						placeholder={
							recipient
								? tl("Write to {name}", { name: recipient.name })
								: "Write the first message"
						}
						value={body}
					/>
					<footer className="flex h-14 shrink-0 items-center gap-3 px-4">
						<Button
							className="rounded-full px-6"
							disabled={!canSend}
							title={needsRecipient ? "Choose an agent in To first" : undefined}
							type="submit"
						>
							Send
						</Button>
						{filedUnder ? (
							<span
								className="inline-flex h-6 min-w-0 items-center gap-1 rounded bg-muted pr-0.5 pl-1.5 text-foreground/80 text-xs"
								data-testid="mail-compose-label"
							>
								<Tag aria-hidden="true" className="size-3 shrink-0" />
								<span className="truncate">{filedUnder.name}</span>
								<button
									aria-label={tl("Remove label {name}", {
										name: filedUnder.name,
									})}
									className="flex size-5 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
									onClick={() => setLabelId(null)}
									type="button"
								>
									<X aria-hidden="true" className="size-3" />
								</button>
							</span>
						) : null}
						<span className="ml-auto flex items-center gap-2">
							<span className="hidden text-muted-foreground text-xs sm:inline">
								Ctrl Enter to send
							</span>
							<MailIconButton
								label="Discard draft"
								onClick={onClose}
								side="top"
							>
								<Trash2 aria-hidden="true" className="size-4" />
							</MailIconButton>
						</span>
					</footer>
				</form>
			)}
		</motion.section>
	);
}
