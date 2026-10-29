import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { ChevronDown } from "lucide-react";
import {
	type FormEvent,
	type KeyboardEvent,
	type Ref,
	useId,
	useState,
} from "react";
import { StreamAvatar } from "./stream-avatar.tsx";
import { STREAM_MENU, STREAM_TEXT } from "./stream-post.tsx";
import { STREAM_FOCUS } from "./stream-rail.tsx";

const MAX_PROMPT_LENGTH = 8000;

/**
 * The "What's new?" row at the top of the feed. The name above the field
 * picks which agent the new thread goes to; Post (or Enter) sends exactly what
 * the user typed through `startThread`, the only path that sends a prompt.
 */
export function StreamComposer({
	agent,
	agents,
	fieldRef,
	onPickAgent,
	onPost,
}: {
	agent: InterfaceAgent;
	agents: InterfaceAgent[];
	fieldRef: Ref<HTMLTextAreaElement>;
	onPickAgent: (agentId: string) => void;
	onPost: (input: { agentId: string; prompt: string }) => void;
}) {
	const tl = useLiteralMessages();
	const fieldId = useId();
	const [prompt, setPrompt] = useState("");
	const trimmed = prompt.trim();

	const submit = () => {
		if (!trimmed) {
			return;
		}
		onPost({ agentId: agent.id, prompt: trimmed });
		setPrompt("");
	};
	const onSubmit = (event: FormEvent) => {
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

	return (
		<form
			aria-label="New thread"
			className="flex gap-3 border-border border-b px-6 py-4"
			onSubmit={onSubmit}
		>
			<StreamAvatar agent={agent} name={agent.name} size={36} />
			<div className="flex min-w-0 flex-1 flex-col">
				{agents.length > 1 ? (
					<DropdownMenu>
						<DropdownMenuTrigger
							aria-label={tl("To {agentName}. Choose an agent", {
								agentName: agent.name,
							})}
							className={cn(
								"-mx-1 flex w-fit items-center gap-1 rounded-md px-1 font-semibold text-foreground hover:bg-muted data-[popup-open]:bg-muted",
								STREAM_TEXT,
								STREAM_FOCUS
							)}
						>
							{agent.name}
							<ChevronDown
								aria-hidden="true"
								className="size-4 text-muted-foreground"
								strokeWidth={2}
							/>
						</DropdownMenuTrigger>
						<DropdownMenuContent
							align="start"
							className={cn("w-64", STREAM_MENU)}
							drawerLabel="Start a thread with"
						>
							<DropdownMenuRadioGroup
								onValueChange={(value: unknown) => {
									if (typeof value === "string") {
										onPickAgent(value);
									}
								}}
								value={agent.id}
							>
								<DropdownMenuLabel>Start a thread with</DropdownMenuLabel>
								{agents.map((item) => (
									<DropdownMenuRadioItem
										className="gap-2"
										closeOnClick
										key={item.id}
										value={item.id}
									>
										<StreamAvatar agent={item} name={item.name} size={20} />
										<span className="truncate">{item.name}</span>
									</DropdownMenuRadioItem>
								))}
							</DropdownMenuRadioGroup>
						</DropdownMenuContent>
					</DropdownMenu>
				) : (
					<span className={cn("font-semibold text-foreground", STREAM_TEXT)}>
						{agent.name}
					</span>
				)}
				<label className="sr-only" htmlFor={fieldId}>
					{tl("Message to {agentName}", { agentName: agent.name })}
				</label>
				<textarea
					className={cn(
						"field-sizing-content max-h-48 min-h-[21px] w-full resize-none bg-transparent text-foreground outline-none placeholder:text-muted-foreground",
						STREAM_TEXT
					)}
					id={fieldId}
					maxLength={MAX_PROMPT_LENGTH}
					onChange={(event) => setPrompt(event.target.value)}
					onKeyDown={onKeyDown}
					placeholder="What's new?"
					ref={fieldRef}
					rows={1}
					value={prompt}
				/>
			</div>
			<Button
				className="h-9 self-center rounded-xl px-4 font-semibold text-[15px]"
				disabled={!trimmed}
				type="submit"
				variant="outline"
			>
				Post
			</Button>
		</form>
	);
}
