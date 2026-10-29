import { Button } from "@ryu/ui/components/button.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { SendHorizontal } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useId, useState } from "react";

const MAX_PROMPT_LENGTH = 8000;

/**
 * Starts a thread from text the user typed here. Submitting is the explicit
 * user action that lets the host send immediately (`InterfacePort.startThread`).
 */
export function InterfaceComposer({
	agents,
	defaultAgentId,
	label,
	onSubmit,
	placeholder,
	submitLabel = "Send",
}: {
	/** Offer an agent picker when more than one agent can receive the prompt. */
	agents?: InterfaceAgent[];
	defaultAgentId?: string;
	/** Accessible name for the text field. */
	label: string;
	onSubmit: (input: { agentId?: string; prompt: string }) => void;
	placeholder: string;
	submitLabel?: string;
}) {
	const fieldId = useId();
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
		<form
			className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-3 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30"
			onSubmit={onFormSubmit}
		>
			<label className="sr-only" htmlFor={fieldId}>
				{label}
			</label>
			<Textarea
				className="min-h-16 resize-none border-0 bg-transparent p-1 shadow-none focus-visible:ring-0"
				id={fieldId}
				maxLength={MAX_PROMPT_LENGTH}
				onChange={(event) => setPrompt(event.target.value)}
				onKeyDown={onKeyDown}
				placeholder={placeholder}
				value={prompt}
			/>
			<div className="flex items-center justify-end gap-2">
				{agents && agents.length > 1 ? (
					<NativeSelect
						aria-label="Agent"
						className="mr-auto w-44"
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
				) : null}
				<Button disabled={!trimmed} size="sm" type="submit">
					<SendHorizontal aria-hidden="true" data-icon="inline-start" />
					{submitLabel}
				</Button>
			</div>
		</form>
	);
}
