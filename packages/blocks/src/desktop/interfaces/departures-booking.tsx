import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import type {
	InterfaceAgent,
	InterfaceGroup,
	InterfacePort,
} from "@ryuhq/protocol/interfaces";
import {
	type FormEvent,
	type KeyboardEvent,
	type ReactNode,
	type Ref,
	useId,
	useState,
} from "react";

const MAX_PROMPT_LENGTH = 8000;
const NO_TERMINAL = "";

export type BookingInput = Parameters<InterfacePort["startThread"]>[0];

/**
 * Book a flight: pick the gate (agent) and, optionally, the terminal (team or
 * project), then write the first message. Submitting is the explicit user
 * action that lets the host send right away (`InterfacePort.startThread`).
 */
export function BookingForm({
	agents,
	defaultAgentId,
	fieldRef,
	groups,
	onSubmit,
	renderGate,
}: {
	agents: readonly InterfaceAgent[];
	defaultAgentId?: string | null;
	fieldRef?: Ref<HTMLTextAreaElement>;
	groups: readonly InterfaceGroup[];
	onSubmit: (input: BookingInput) => void;
	/** Shown under the form for the gate picked now, e.g. its recent flights. */
	renderGate?: (agentId: string | undefined) => ReactNode;
}) {
	const tl = useLiteralMessages();
	const gateId = useId();
	const terminalId = useId();
	const messageId = useId();
	const [prompt, setPrompt] = useState("");
	const [pickedAgentId, setPickedAgentId] = useState<string>();
	const [terminal, setTerminal] = useState(NO_TERMINAL);
	// Resolve the gate on every render, so a pick the agents no longer offer
	// can never send to a hidden agent: what the picker shows is what is sent.
	const agentId =
		pickedAgentId && agents.some((agent) => agent.id === pickedAgentId)
			? pickedAgentId
			: (agents.find((agent) => agent.id === defaultAgentId)?.id ??
				agents[0]?.id);
	const agentName = agents.find((agent) => agent.id === agentId)?.name;
	const group = groups.find((candidate) => candidate.id === terminal);
	const trimmed = prompt.trim();

	const submit = () => {
		if (!trimmed) {
			return;
		}
		onSubmit({
			agentId,
			projectId: group?.kind === "project" ? group.id : undefined,
			prompt: trimmed,
			teamId: group?.kind === "team" ? group.id : undefined,
		});
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

	const label = "font-medium text-muted-foreground text-xs";
	return (
		<>
			<form className="flex flex-col gap-3 px-4 py-4" onSubmit={onFormSubmit}>
				{agents.length > 0 || groups.length > 0 ? (
					<div className="grid grid-cols-2 gap-2">
						{agents.length > 0 ? (
							<div className="flex min-w-0 flex-col gap-1.5">
								<label className={label} htmlFor={gateId}>
									Gate
								</label>
								<NativeSelect
									className="w-full"
									id={gateId}
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
							</div>
						) : null}
						{groups.length > 0 ? (
							<div className="flex min-w-0 flex-col gap-1.5">
								<label className={label} htmlFor={terminalId}>
									Terminal
								</label>
								<NativeSelect
									className="w-full"
									id={terminalId}
									onChange={(event) => setTerminal(event.target.value)}
									size="sm"
									value={terminal}
								>
									<NativeSelectOption value={NO_TERMINAL}>
										None
									</NativeSelectOption>
									{groups.map((candidate) => (
										<NativeSelectOption key={candidate.id} value={candidate.id}>
											{candidate.name}
										</NativeSelectOption>
									))}
								</NativeSelect>
							</div>
						) : null}
					</div>
				) : null}
				<div className="flex flex-col gap-1.5">
					<label className={label} htmlFor={messageId}>
						Message
					</label>
					<Textarea
						className="min-h-20 resize-none"
						id={messageId}
						maxLength={MAX_PROMPT_LENGTH}
						onChange={(event) => setPrompt(event.target.value)}
						onKeyDown={onKeyDown}
						placeholder={
							agentName
								? tl("What should {agentName} work on?", { agentName })
								: "What needs doing?"
						}
						ref={fieldRef}
						value={prompt}
					/>
				</div>
				<div className="flex items-center justify-between gap-3">
					<p className="text-muted-foreground text-xs">
						Enter to book, Shift+Enter for a new line
					</p>
					<Button
						aria-disabled={!trimmed}
						disabled={!trimmed}
						size="sm"
						type="submit"
					>
						Book
					</Button>
				</div>
			</form>
			{renderGate?.(agentId)}
		</>
	);
}
