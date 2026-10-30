import { useLiteralMessages } from "@ryu/i18n/react";
import type {
	InterfaceAgent,
	InterfacePort,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import type { ReactNode } from "react";
import { frameStyle, SV_PLANK_TEXT } from "./world-2d-frame.ts";
import { CloseButton } from "./world-2d-hud.tsx";
import type { VillagerStatus } from "./world-2d-model.ts";
import { SV_UI } from "./world-2d-palette.ts";
import { DialogueBox, DialogueChoices } from "./world-2d-panel-dialogue.tsx";
import { ReplyBox } from "./world-2d-panel-reply.tsx";
import { PLANK_BUTTON } from "./world-2d-panel-type.ts";

export {
	villagerLine,
	World2dActed,
	World2dActLines,
	world2dActLine,
} from "./world-2d-panel-lines.ts";

/**
 * The talk panel, drawn as a Stardew Valley dialogue box: wooden frames with
 * parchment insides, the villager's framed portrait over a flat name plate,
 * their line in the box with where they stand with you, past conversations
 * as dialogue choices (each marked with its status), and the reply box
 * pinned to the bottom. When a thread is open the host's real chat sits in
 * the same wood frame, in the user's own theme: only the frame is game art.
 *
 * Type: one face (the HUD's), 16px for the villager's line and 13px for
 * everything else, one weight.
 */

/** Wooden backing behind the frames: horizontal planks on the pixel grid. */
const PANEL_BACKING = {
	backgroundColor: SV_UI.wallFill,
	backgroundImage: `repeating-linear-gradient(180deg, ${SV_UI.wallPlank} 0 21px, ${SV_UI.wallGap} 21px 24px), repeating-linear-gradient(90deg, transparent 0 117px, ${SV_UI.wallDark} 117px 120px)`,
} as const;

/** A pixel back arrow for the plank button. */
function BackIcon() {
	return (
		<svg
			aria-hidden="true"
			height="12"
			shapeRendering="crispEdges"
			viewBox="0 0 4 6"
			width="8"
		>
			<path d="M3 0h1v6h-1v-1h-1v-1h-1v-2h1v-1h1z" fill={SV_UI.plankInk} />
		</svg>
	);
}

/**
 * The conversation panel the village opens when the player talks to an
 * agent. The open thread (`threadView`) is the host's own chat, shown in
 * the user's theme inside the dialogue box's wood frame.
 */
export function World2dPanel({
	activeThreadId = null,
	agent,
	lookIndex = -1,
	onClose,
	port,
	status,
	threads,
	threadView,
}: {
	/** The open thread, whose conversation the dialogue box speaks to. */
	activeThreadId?: string | null;
	agent: InterfaceAgent;
	/** The agent's place in the village (picks its portrait's outfit). */
	lookIndex?: number;
	onClose: () => void;
	port: InterfacePort;
	status: VillagerStatus;
	threads: InterfaceThread[];
	threadView: ReactNode | null;
}) {
	const tl = useLiteralMessages();
	const openThread =
		threadView === null
			? null
			: (threads.find((thread) => thread.id === activeThreadId) ?? null);
	return (
		<aside
			aria-label={tl("Talking to {name}", { name: agent.name })}
			className="@container absolute inset-0 z-[500] flex h-full w-full shrink-0 flex-col gap-2 overflow-y-auto overflow-x-hidden border-(--sv-outline) border-l-[3px] p-3 [scrollbar-color:var(--sv-slot-shade)_transparent] [scrollbar-width:thin] sm:static sm:w-[clamp(320px,40%,440px)]"
			data-testid="world-agent-panel"
			style={PANEL_BACKING}
		>
			{/* Above the frames, on the same top inset as the clock: the way
			    back to the list (with a thread open) and Stardew's red close
			    "X" just past the menu's corner. */}
			<div className="flex h-8 shrink-0 items-center justify-between gap-2">
				{threadView ? (
					<button
						aria-label="Back to conversations"
						className={PLANK_BUTTON}
						onClick={port.closeThread}
						style={{ ...frameStyle("plank", 2), ...SV_PLANK_TEXT }}
						type="button"
					>
						<BackIcon />
						Conversations
					</button>
				) : (
					<span />
				)}
				<CloseButton
					keyShortcut="Escape"
					label="Walk away"
					onClick={onClose}
					title="Walk away (Esc)"
				/>
			</div>
			<div className="flex min-h-0 flex-1 flex-col gap-3">
				<DialogueBox
					agent={agent}
					compact={threadView !== null}
					lookIndex={lookIndex}
					openThread={openThread}
					status={status}
					threads={threads}
				/>
				{threadView ? (
					<div
						className="flex min-h-[240px] flex-1 flex-col"
						style={frameStyle("wood")}
					>
						<div
							className="-m-1 flex min-h-0 flex-1 flex-col overflow-hidden border-2 border-border bg-background text-foreground focus-within:border-ring"
							data-testid="world-2d-thread"
						>
							{threadView}
						</div>
					</div>
				) : (
					<>
						<DialogueChoices onOpen={port.openThread} threads={threads} />
						<ReplyBox
							agent={agent}
							key={agent.id}
							onSubmit={(prompt) =>
								port.startThread({ agentId: agent.id, prompt })
							}
						/>
					</>
				)}
			</div>
		</aside>
	);
}
