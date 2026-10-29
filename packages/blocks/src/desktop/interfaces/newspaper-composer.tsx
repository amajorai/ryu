import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import {
	type FormEvent,
	type KeyboardEvent,
	type Ref,
	useId,
	useState,
} from "react";
import { BoxHead } from "./newspaper-parts.tsx";

const MAX_STORY_LENGTH = 8000;

/**
 * "Submit a story": the paper's one way to start a thread. Filing is the
 * explicit user action that lets the host send the text immediately.
 */
export function NewspaperComposer({
	agents,
	id,
	inputRef,
	onSubmit,
}: {
	agents: InterfaceAgent[];
	id: string;
	inputRef: Ref<HTMLTextAreaElement>;
	onSubmit: (input: { agentId?: string; prompt: string }) => void;
}) {
	const tl = useLiteralMessages();
	const fieldId = useId();
	const headingId = useId();
	const hintId = useId();
	const [prompt, setPrompt] = useState("");
	const [pickedAgentId, setPickedAgentId] = useState<string>();
	// Resolve on every render so a pick that left the roster can never send
	// to a hidden agent: what the picker shows is what gets sent.
	const agentId =
		pickedAgentId && agents.some((agent) => agent.id === pickedAgentId)
			? pickedAgentId
			: agents[0]?.id;
	const trimmed = prompt.trim();

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

	return (
		<section aria-labelledby={headingId} id={id}>
			<BoxHead id={headingId}>Submit a story</BoxHead>
			<form className="flex flex-col gap-3" onSubmit={onFormSubmit}>
				<label className="sr-only" htmlFor={fieldId}>
					Story assignment
				</label>
				<Textarea
					aria-describedby={hintId}
					className="min-h-24"
					id={fieldId}
					maxLength={MAX_STORY_LENGTH}
					onChange={(event) => setPrompt(event.target.value)}
					onKeyDown={onKeyDown}
					placeholder="What should the agent look into?"
					ref={inputRef}
					value={prompt}
				/>
				<p className="text-muted-foreground text-xs leading-4" id={hintId}>
					Filing sends it right away. Shift+Enter adds a line.
				</p>
				<div className="flex items-center gap-2">
					{agents.length > 1 ? (
						<NativeSelect
							aria-label="Assign to"
							className="min-w-0 flex-1"
							onChange={(event) => setPickedAgentId(event.target.value)}
							size="sm"
							value={agentId}
						>
							{agents.map((agent) => (
								<NativeSelectOption key={agent.id} value={agent.id}>
									{agent.name}
								</NativeSelectOption>
							))}
						</NativeSelect>
					) : (
						<span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
							{agents[0]
								? tl("Assigned to {name}", { name: agents[0].name })
								: null}
						</span>
					)}
					<Button disabled={!trimmed} size="sm" type="submit">
						File story
					</Button>
				</div>
			</form>
		</section>
	);
}
