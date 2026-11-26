import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	type ClipboardEvent,
	type KeyboardEvent,
	type MouseEvent,
	useEffect,
	useRef,
	type WheelEvent,
} from "react";
import type { BotLaneSelection } from "./browser-bot-lanes.ts";
import {
	type BotLaneTakeover,
	type BotTakeoverAction,
	botTakeoverInputPath,
	type TakeoverInputEvent,
	TakeoverInputQueue,
	type TakeoverModifiers,
	takeoverButton,
	takeoverPagePoint,
	takeoverWheelDelta,
} from "./browser-bot-takeover.ts";

type SidecarCall = (path: string, init?: RequestInit) => Promise<Response>;

const MAX_PASTE_LENGTH = 4096;

/**
 * The request card of a takeover: what the agent asked for and the owner's
 * answers to it. The reason is the agent's own text, so it is shown as plain
 * text and is never translated or rendered as markup.
 */
export function BrowserBotTakeoverCard({
	agentId,
	busy,
	doneId,
	error,
	onAnswer,
	takeover,
}: {
	agentId: string;
	busy: boolean;
	/** The id of the Done button, where the keyboard goes when it leaves the page. */
	doneId?: string;
	error: string | null;
	onAnswer: (action: BotTakeoverAction) => void;
	takeover: BotLaneTakeover;
}) {
	const tl = useLiteralMessages();
	const active = takeover.status === "active";
	return (
		<section
			aria-label={tl("Takeover request from {agent}", { agent: agentId })}
			className="flex flex-wrap items-center gap-2 border-border border-b bg-popover px-3 py-2 text-xs"
		>
			<div className="min-w-0 flex-1">
				<p className="font-medium">
					{active
						? tl("You have control of this tab")
						: tl("{agent} asks you to take over this tab", { agent: agentId })}
				</p>
				{active ? (
					<p className="text-muted-foreground">
						{tl(
							"The agent is paused and does not see what you type. Choose Done when you have finished."
						)}
					</p>
				) : (
					<>
						<p className="text-muted-foreground">Reason from the agent</p>
						<p className="break-words" data-ryu-i18n="off" translate="no">
							{takeover.reason}
						</p>
					</>
				)}
				{error && (
					<p className="text-status-destructive" role="alert">
						{error}
					</p>
				)}
			</div>
			{active ? (
				<Button
					disabled={busy}
					id={doneId}
					onClick={() => onAnswer("done")}
					size="sm"
				>
					Done
				</Button>
			) : (
				<>
					<Button
						disabled={busy}
						onClick={() => onAnswer("decline")}
						size="sm"
						variant="ghost"
					>
						Decline
					</Button>
					<Button disabled={busy} onClick={() => onAnswer("accept")} size="sm">
						Take control
					</Button>
				</>
			)}
		</section>
	);
}

function modifiersOf(event: {
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
}): TakeoverModifiers {
	return {
		alt: event.altKey,
		ctrl: event.ctrlKey,
		meta: event.metaKey,
		shift: event.shiftKey,
	};
}

/**
 * The layer over the live picture that sends the owner's pointer, wheel, key
 * and paste input to the taken-over tab. It is mounted only while the owner
 * has control; nothing typed here is kept in the desktop.
 */
export function BrowserBotTakeoverSurface({
	base,
	call,
	frame,
	headers,
	label,
	onLeave,
	onRefused,
	selection,
}: {
	base: string;
	call: SidecarCall;
	frame: { height: number; width: number };
	headers?: Record<string, string>;
	label: string;
	/** F6 was pressed: move the keyboard out of the page (to the Done button). */
	onLeave?: () => void;
	onRefused: () => void;
	selection: BotLaneSelection;
}) {
	const surface = useRef<HTMLDivElement>(null);
	const queue = useRef<TakeoverInputQueue | null>(null);
	const frameSize = useRef(frame);
	frameSize.current = frame;

	useEffect(() => {
		const path = botTakeoverInputPath(base, selection);
		const created = new TakeoverInputQueue(
			(events) =>
				call(path, {
					body: JSON.stringify({ events }),
					headers: { ...headers, "Content-Type": "application/json" },
					method: "POST",
				}).then(() => true),
			onRefused
		);
		queue.current = created;
		surface.current?.focus();
		return () => {
			created.close();
			queue.current = null;
		};
	}, [base, call, headers, onRefused, selection]);

	const push = (event: TakeoverInputEvent) => queue.current?.push(event);

	const pointer = (event: MouseEvent | WheelEvent) => {
		const box = surface.current?.getBoundingClientRect();
		return box
			? takeoverPagePoint(
					{ x: event.clientX, y: event.clientY },
					box,
					frameSize.current
				)
			: null;
	};

	const mouse = (action: "down" | "move" | "up") => (event: MouseEvent) => {
		const point = pointer(event);
		if (!point) {
			return;
		}
		if (action === "down") {
			surface.current?.focus();
		}
		event.preventDefault();
		push({
			action,
			button: action === "move" ? "none" : takeoverButton(event.button),
			buttons: event.buttons,
			click_count:
				action === "move" ? 0 : Math.min(3, Math.max(1, event.detail)),
			modifiers: modifiersOf(event),
			type: "mouse",
			...point,
		});
	};

	const wheel = (event: WheelEvent) => {
		const point = pointer(event);
		if (point) {
			push({
				delta_x: takeoverWheelDelta(event.deltaX, event.deltaMode),
				delta_y: takeoverWheelDelta(event.deltaY, event.deltaMode),
				modifiers: modifiersOf(event),
				type: "wheel",
				...point,
			});
		}
	};

	const key = (action: "down" | "up") => (event: KeyboardEvent) => {
		if (event.nativeEvent.isComposing) {
			return;
		}
		// F6 is never sent to the page: it leaves it, so the keyboard is not trapped.
		if (event.key === "F6") {
			event.preventDefault();
			if (action === "down") {
				onLeave?.();
			}
			return;
		}
		// Paste arrives as a paste event, so the clipboard text is sent as text.
		if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		push({
			action,
			code: event.code,
			key: event.key,
			modifiers: modifiersOf(event),
			type: "key",
		});
	};

	const paste = (event: ClipboardEvent) => {
		event.preventDefault();
		const text = event.clipboardData
			.getData("text/plain")
			.slice(0, MAX_PASTE_LENGTH);
		if (text) {
			push({ text, type: "text" });
		}
	};

	return (
		<div
			aria-label={label}
			className="absolute inset-0 cursor-default outline-none ring-2 ring-primary ring-inset"
			data-testid="bot-takeover-surface"
			onContextMenu={(event) => event.preventDefault()}
			onKeyDown={key("down")}
			onKeyUp={key("up")}
			onMouseDown={mouse("down")}
			onMouseMove={mouse("move")}
			onMouseUp={mouse("up")}
			onPaste={paste}
			onWheel={wheel}
			ref={surface}
			role="application"
			// biome-ignore lint/a11y/noNoninteractiveTabindex: the taken-over page is a keyboard-driven surface (role="application").
			tabIndex={0}
		/>
	);
}
