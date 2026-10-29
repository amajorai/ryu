import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import { CornerDownLeft, X } from "lucide-react";
import { type FormEvent, type Ref, useState } from "react";
import { parseCommand } from "./hologram-model.ts";
import { PANEL_TEXTURE } from "./hologram-palette.ts";
import {
	CornerBrackets,
	HUD_INTERACTIVE,
	HUD_LABEL,
} from "./hologram-parts.tsx";
import { agentById } from "./interface-renderer.ts";

/**
 * The command bar: type a request and press Enter to start a thread. The
 * agent is the one picked on the ring ("Message"), a leading `@handle`, or
 * the host's default agent ("Any agent"). Only text the user typed and submitted is sent.
 */
export function CommandBar({
	disabled,
	inputRef,
	onClearTarget,
	onSubmit,
	snapshot,
	targetId,
}: {
	disabled: boolean;
	inputRef: Ref<HTMLInputElement>;
	onClearTarget: () => void;
	onSubmit: (input: { agentId: string | null; prompt: string }) => void;
	snapshot: InterfaceSnapshot;
	targetId: string | null;
}) {
	const tl = useLiteralMessages();
	const [text, setText] = useState("");
	const [focused, setFocused] = useState(false);
	const parsed = parseCommand(snapshot, text);
	const agentId = parsed.agentId ?? targetId;
	const agent = agentById(snapshot, agentId);
	const canSend = !disabled && parsed.prompt.length > 0;
	/** At rest the bar shows its "/" shortcut; once in use, the send key. */
	const showSend = focused || text.length > 0;

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!canSend) {
			return;
		}
		onSubmit({ agentId: agent?.id ?? null, prompt: parsed.prompt });
		setText("");
	};

	return (
		<form
			aria-label="Command"
			className="relative flex h-12 w-full items-center gap-3 border border-(--holo-line) pr-1.5 pl-4 focus-within:border-(--holo-ink)/60"
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
					setFocused(false);
				}
			}}
			onFocus={() => setFocused(true)}
			onSubmit={submit}
			style={PANEL_TEXTURE}
		>
			<CornerBrackets />
			<span
				className={cn(
					HUD_LABEL,
					"flex shrink-0 items-center gap-1 text-(--holo-ink)"
				)}
			>
				<span className="text-(--holo-dim)">To</span>
				<span className="max-w-32 truncate">
					{agent ? agent.name : "Any agent"}
				</span>
				{targetId && !parsed.agentId ? (
					<button
						aria-label={tl("Stop targeting {name}", {
							name: agent?.name ?? tl("agent"),
						})}
						className={cn(
							"flex size-5 items-center justify-center rounded-sm text-(--holo-dim) hover:text-(--holo-text)",
							HUD_INTERACTIVE
						)}
						onClick={onClearTarget}
						type="button"
					>
						<X aria-hidden="true" className="size-3" />
					</button>
				) : null}
			</span>
			<span aria-hidden="true" className="h-5 w-px shrink-0 bg-(--holo-line)" />
			<input
				aria-label={
					agent
						? tl("Ask or command {name}", { name: agent.name })
						: "Ask or command"
				}
				autoComplete="off"
				className="h-full min-w-0 flex-1 bg-transparent text-(--holo-text) text-[14px] outline-none placeholder:text-(--holo-faint) disabled:cursor-not-allowed"
				disabled={disabled}
				onChange={(event) => setText(event.target.value)}
				placeholder="Ask or command…"
				ref={inputRef}
				spellCheck={false}
				value={text}
			/>
			{showSend ? (
				<button
					aria-label="Start thread"
					className={cn(
						"flex size-9 shrink-0 items-center justify-center rounded-sm text-(--holo-ink) disabled:text-(--holo-faint)",
						HUD_INTERACTIVE,
						"disabled:pointer-events-none"
					)}
					disabled={!canSend}
					title="Start thread (Enter)"
					type="submit"
				>
					<CornerDownLeft aria-hidden="true" className="size-4" />
				</button>
			) : (
				<kbd
					className="mr-2.5 @min-[760px]/holo:flex hidden h-5 min-w-5 shrink-0 items-center justify-center rounded-sm border border-(--holo-line) px-1 font-mono text-(--holo-dim) text-[12px]"
					title="Press / to focus"
				>
					/
				</kbd>
			)}
		</form>
	);
}
