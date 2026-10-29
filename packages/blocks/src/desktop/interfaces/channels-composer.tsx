import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { Kbd, KbdGroup } from "@ryu/ui/components/kbd.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { ChevronDown, SendHorizontal } from "lucide-react";
import {
	type FormEvent,
	type KeyboardEvent,
	type ReactNode,
	useId,
	useState,
} from "react";
import { ChannelsAvatar } from "./channels-avatar.tsx";

const MAX_PROMPT_LENGTH = 8000;

/**
 * The channel's message box. Submitting is the explicit user action that lets the
 * host send immediately (`InterfacePort.startThread`), so every message here
 * starts a new thread in the channel.
 */
export function ChannelsComposer({
	agents,
	defaultAgentId,
	label,
	onSubmit,
	placeholder,
	recipient,
}: {
	/**
	 * Offer a recipient picker when more than one agent can receive the
	 * prompt, in the order given (the channel's members first).
	 */
	agents?: InterfaceAgent[];
	defaultAgentId?: string;
	/** Accessible name for the text field. */
	label: string;
	onSubmit: (input: { agentId?: string; prompt: string }) => void;
	placeholder: string;
	/**
	 * Who receives the message when there is nothing to pick (a DM or a
	 * team channel): shown as static text where the picker would be, so the
	 * composer keeps the same height and send position in every channel.
	 */
	recipient?: ReactNode;
}) {
	const hintId = useId();
	const [prompt, setPrompt] = useState("");
	const [pickedAgentId, setPickedAgentId] = useState<string>();
	// Resolve the recipient on every render, so a pick the current agents no
	// longer offer (or a changed default) can never send to a hidden agent:
	// what the picker shows is always what gets sent.
	const agentId =
		pickedAgentId && agents?.some((agent) => agent.id === pickedAgentId)
			? pickedAgentId
			: (defaultAgentId ?? agents?.[0]?.id);
	const trimmed = prompt.trim();
	const hasPicker = Boolean(agents && agents.length > 1);

	const submit = () => {
		if (!trimmed) {
			return;
		}
		onSubmit({ agentId, prompt: trimmed });
		setPrompt("");
	};
	const onFormSubmit = (event: FormEvent) => {
		event.preventDefault();
		submit();
	};
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (
			event.key === "Enter" &&
			!event.shiftKey &&
			!event.nativeEvent.isComposing
		) {
			event.preventDefault();
			submit();
		}
	};

	const hint = (
		<>
			<KbdGroup aria-hidden="true">
				<Kbd className="h-5 min-w-5 px-1 text-foreground/80 text-xs">⇧</Kbd>
				<Kbd className="h-5 min-w-5 px-1 text-foreground/80 text-xs">↵</Kbd>
			</KbdGroup>
			<span className="sr-only">Shift Return</span>
			<span className="truncate">adds a new line</span>
		</>
	);
	const sendButton = (
		<Button
			aria-label="Send now"
			className={cn("shrink-0", !trimmed && "disabled:opacity-100")}
			disabled={!trimmed}
			size="icon-sm"
			title="Send now"
			type="submit"
			variant={trimmed ? "default" : "ghost-muted"}
		>
			<SendHorizontal aria-hidden="true" />
		</Button>
	);

	return (
		<form
			className="group/composer flex flex-col rounded-lg border border-input bg-background transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30 dark:bg-input/30"
			onSubmit={onFormSubmit}
		>
			<textarea
				aria-describedby={hintId}
				aria-label={label}
				className="field-sizing-content max-h-60 min-h-11 w-full min-w-0 flex-1 resize-none bg-transparent px-3.5 pt-3 pb-1 text-foreground text-sm leading-6 outline-hidden placeholder:text-foreground/50"
				maxLength={MAX_PROMPT_LENGTH}
				onChange={(event) => setPrompt(event.target.value)}
				onKeyDown={onKeyDown}
				placeholder={placeholder}
				rows={1}
				value={prompt}
			/>
			{/* The toolbar row is always there, so the field never changes
			    height or moves the send button from channel to channel. */}
			<div className="flex min-h-11 items-center gap-2 py-1.5 pr-1.5 pl-2">
				{hasPicker && agents ? (
					<RecipientPicker
						agentId={agentId}
						agents={agents}
						onPick={setPickedAgentId}
					/>
				) : (
					<div className="flex h-8 min-w-0 shrink items-center gap-1.5 px-2 font-medium text-foreground/70 text-xs">
						{recipient}
					</div>
				)}
				{/* The hint only matters while there is a draft, and stays the
				    quietest thing in the row. */}
				<p
					className={cn(
						"flex min-w-0 flex-1 items-center gap-1.5 truncate text-foreground/65 text-xs transition-opacity motion-reduce:transition-none",
						trimmed ? "opacity-100" : "opacity-0"
					)}
					id={hintId}
				>
					{hint}
				</p>
				{sendButton}
			</div>
		</form>
	);
}

/**
 * The recipient reads like an @-mention target rather than a form field:
 * a borderless ghost control with the chosen agent's face that opens a
 * themed menu of agents (members first), the chosen one checked.
 */
function RecipientPicker({
	agentId,
	agents,
	onPick,
}: {
	agentId: string | undefined;
	agents: InterfaceAgent[];
	onPick: (agentId: string) => void;
}) {
	const chosen = agents.find((agent) => agent.id === agentId) ?? agents[0];
	const tl = useLiteralMessages();
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						aria-label={
							chosen ? tl("Send to @{name}", { name: chosen.name }) : "Send to"
						}
						className="h-8 shrink-0 gap-1.5 px-2 font-medium text-foreground/70 text-xs hover:text-foreground"
						title="Choose who this message goes to"
						type="button"
						variant="ghost"
					/>
				}
			>
				{chosen ? (
					<ChannelsAvatar agent={chosen} name={chosen.name} size={16} />
				) : null}
				<span className="truncate">@{chosen?.name ?? "agent"}</span>
				<ChevronDown aria-hidden="true" className="size-3.5" />
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="start"
				className="max-h-72 w-52 rounded-xl border-border bg-popover p-1 shadow-md backdrop-blur-none"
				drawerLabel="Send to"
			>
				<DropdownMenuRadioGroup
					onValueChange={(value: unknown) => {
						if (typeof value === "string") {
							onPick(value);
						}
					}}
					value={chosen?.id}
				>
					{agents.map((agent) => (
						<DropdownMenuRadioItem closeOnClick key={agent.id} value={agent.id}>
							<ChannelsAvatar agent={agent} name={agent.name} size={16} />
							<span className="truncate">@{agent.name}</span>
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
