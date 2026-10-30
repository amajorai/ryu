import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import {
	type ComponentProps,
	type KeyboardEvent,
	useId,
	useState,
} from "react";
import { frameStyle, SV_PLANK_TEXT, SV_TEXT } from "./world-2d-frame.ts";
import { PLANK_BUTTON, UI_FONT } from "./world-agent-panel-styles.ts";

const MAX_PROMPT_LENGTH = 8000;

/** The reply box the player types into to start a conversation. */
export function ReplyBox({
	agent,
	onSubmit,
}: {
	agent: InterfaceAgent;
	onSubmit: (prompt: string) => void;
}) {
	const tl = useLiteralMessages();
	const fieldId = useId();
	const hintId = useId();
	const [prompt, setPrompt] = useState("");
	const trimmed = prompt.trim();

	const submit = () => {
		if (!trimmed) {
			return;
		}
		onSubmit(trimmed);
		setPrompt("");
	};
	const onFormSubmit: ComponentProps<"form">["onSubmit"] = (event) => {
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
			className="flex shrink-0 flex-col gap-2 p-1.5"
			onSubmit={onFormSubmit}
			style={{ ...frameStyle("wood"), ...SV_TEXT }}
		>
			<label
				className={cn("text-[13px] leading-none", UI_FONT)}
				htmlFor={fieldId}
			>
				<span className="sr-only">
					{tl("Say something to {name}", { name: agent.name })}
				</span>
				<span aria-hidden="true">Your reply</span>
			</label>
			<textarea
				aria-describedby={hintId}
				className="min-h-[68px] resize-none border-2 border-[#c99a5a] bg-[#fff3cf] px-2.5 py-2 font-sans font-semibold text-[#3d1f0d] text-[15px] leading-snug shadow-[inset_2px_2px_0_#e9c98d] outline-none placeholder:text-[#a87c4c] focus-visible:border-[#5b2a0b]"
				id={fieldId}
				maxLength={MAX_PROMPT_LENGTH}
				onChange={(event) => setPrompt(event.target.value)}
				onKeyDown={onKeyDown}
				placeholder={tl("Say something to {name}…", { name: agent.name })}
				value={prompt}
			/>
			<div className="flex items-center justify-between gap-2">
				<p
					className="font-sans font-semibold text-[#7a4a24] text-[11px] leading-tight"
					id={hintId}
				>
					Enter to say it · Shift+Enter for a new line
				</p>
				<button
					className={cn(
						PLANK_BUTTON,
						"disabled:pointer-events-none disabled:opacity-50"
					)}
					disabled={!trimmed}
					style={{ ...frameStyle("plank", 2), ...SV_PLANK_TEXT }}
					type="submit"
				>
					Say it
				</button>
			</div>
		</form>
	);
}
