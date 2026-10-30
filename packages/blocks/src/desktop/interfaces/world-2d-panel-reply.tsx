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
import { PixelKey } from "./world-2d-hud.tsx";
import { PLANK_BUTTON, UI_TYPE } from "./world-2d-panel-type.ts";

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
			className="flex shrink-0 flex-col gap-2 p-1"
			onSubmit={onFormSubmit}
			style={{ ...frameStyle("wood"), ...SV_TEXT }}
		>
			<label className="sr-only" htmlFor={fieldId}>
				{tl("Say something to {name}", { name: agent.name })}
			</label>
			<textarea
				aria-describedby={hintId}
				className={cn(
					"min-h-[72px] resize-none border-(--sv-slot-shade) border-2 bg-(--sv-parchment-field) px-3 py-2 text-(--sv-ink) text-[16px] leading-6 shadow-[inset_2px_2px_0_var(--sv-parchment-field-shade)] outline-none placeholder:text-(--sv-ink-soft)/70 focus-visible:border-(--sv-wood-dark)",
					UI_TYPE
				)}
				id={fieldId}
				maxLength={MAX_PROMPT_LENGTH}
				onChange={(event) => setPrompt(event.target.value)}
				onKeyDown={onKeyDown}
				placeholder={tl("Say something to {name}…", { name: agent.name })}
				value={prompt}
			/>
			<div className="flex min-h-8 items-center justify-between gap-2">
				<p
					className={cn(
						"flex items-center gap-1 text-(--sv-ink-soft) text-[16px] leading-none",
						UI_TYPE
					)}
					id={hintId}
				>
					<PixelKey>Enter</PixelKey> to send
				</p>
				{/* Enter sends; the button appears once there is something to say. */}
				{trimmed ? (
					<button
						className={PLANK_BUTTON}
						style={{ ...frameStyle("plank", 2), ...SV_PLANK_TEXT }}
						type="submit"
					>
						Say it
					</button>
				) : null}
			</div>
		</form>
	);
}
