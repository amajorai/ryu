import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceAgent,
	InterfacePort,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import type { ReactNode } from "react";
import { frameStyle, SV_PLANK_TEXT } from "./world-2d-frame.ts";
import { PixelKey } from "./world-2d-hud.tsx";
import { DialogueChoices } from "./world-agent-panel-choices.tsx";
import { DialogueBox } from "./world-agent-panel-dialogue.tsx";
import { CloseIcon } from "./world-agent-panel-icons.tsx";
import { ReplyBox } from "./world-agent-panel-reply.tsx";
import {
	PANEL_BACKING,
	PARCHMENT_TOKENS,
	PLANK_BUTTON,
} from "./world-agent-panel-styles.ts";
import type { WorldPalette } from "./world-themes.ts";

/**
 * The talk panel, drawn as a Stardew Valley dialogue box: wooden frames with
 * parchment insides, the villager's framed portrait with a name plate under
 * it, their line in the box, past conversations as dialogue choices, and a
 * reply box. When a thread is open the host's real chat sits in a parchment
 * well inside the same frame.
 */

/**
 * The conversation panel a world opens when the player talks to an agent.
 * `palette` is accepted for callers that theme their worlds; the dialogue
 * box keeps Stardew's wood and parchment in every theme.
 */
export function WorldAgentPanel({
	agent,
	lookIndex = -1,
	onClose,
	port,
	threads,
	threadView,
}: {
	agent: InterfaceAgent;
	/** The agent's place in the village (picks its portrait's outfit). */
	lookIndex?: number;
	onClose: () => void;
	palette?: WorldPalette;
	port: InterfacePort;
	threads: InterfaceThread[];
	threadView: ReactNode | null;
}) {
	const tl = useLiteralMessages();
	return (
		<aside
			aria-label={tl("Talking to {name}", { name: agent.name })}
			className="@container flex h-full w-[clamp(320px,40%,440px)] shrink-0 flex-col gap-2 overflow-y-auto overflow-x-hidden border-[#3f1c08] border-l-[3px] p-2.5 shadow-[-4px_0_0_rgba(63,28,8,0.35)] [scrollbar-color:#c99a5a_transparent] [scrollbar-width:thin]"
			data-testid="world-agent-panel"
			style={PANEL_BACKING}
		>
			<div className="flex shrink-0 items-center justify-end gap-2">
				{threadView ? (
					<button
						className={cn(PLANK_BUTTON, "mr-auto")}
						onClick={port.closeThread}
						style={{ ...frameStyle("plank", 2), ...SV_PLANK_TEXT }}
						type="button"
					>
						<span aria-hidden="true">◀</span>
						Back to conversations
					</button>
				) : null}
				<button
					aria-label="Walk away"
					className={PLANK_BUTTON}
					onClick={onClose}
					style={{ ...frameStyle("plank", 2), ...SV_PLANK_TEXT }}
					type="button"
				>
					<PixelKey
						aria-hidden="true"
						className="h-[18px] min-w-[18px] px-0.5 text-[10px]"
					>
						Esc
					</PixelKey>
					Walk away
					<CloseIcon />
				</button>
			</div>
			<DialogueBox
				agent={agent}
				compact={threadView !== null}
				lookIndex={lookIndex}
				threads={threads}
			/>
			{threadView ? (
				<div
					className="flex min-h-0 flex-1 flex-col"
					style={frameStyle("wood")}
				>
					<div
						className="-m-1 min-h-0 flex-1 overflow-hidden border-2 border-[#c99a5a] bg-background font-medium text-foreground shadow-[inset_2px_2px_0_#e9c98d]"
						style={PARCHMENT_TOKENS}
					>
						{threadView}
					</div>
				</div>
			) : (
				<div className="flex min-h-0 flex-1 flex-col gap-2 pt-3">
					<DialogueChoices onOpen={port.openThread} threads={threads} />
					<ReplyBox
						agent={agent}
						key={agent.id}
						onSubmit={(prompt) =>
							port.startThread({ agentId: agent.id, prompt })
						}
					/>
				</div>
			)}
		</aside>
	);
}
