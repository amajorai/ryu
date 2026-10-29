import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import {
	blockerKindWord,
	type ClockOptions,
	clockLabel,
	type InterfaceBlocker,
	type InterfacePort,
	type InterfaceSnapshot,
	waitLabel,
} from "@ryuhq/protocol/interfaces";
import type { KeyboardEvent, RefObject } from "react";
import { useEffect, useRef } from "react";

const QUEUE_ITEM = "[data-ask-queue-item]";

/** Every ask-queue button on the page, in list order. */
export function queueButtons(): HTMLElement[] {
	if (typeof document === "undefined") {
		return [];
	}
	return [...document.querySelectorAll<HTMLElement>(QUEUE_ITEM)].filter(
		(element) => element.isConnected
	);
}

/**
 * Where focus goes when a card closes: the opener if it is still on the
 * page, else the queue button now in the opener's place (the next one; the
 * first when the opener was not a queue button), else the game's fallback
 * heading. Never the page body.
 */
export function resolveReturnFocus(
	opener: HTMLElement | null,
	queueIndex: number,
	fallback: RefObject<HTMLElement | null>
): HTMLElement | null {
	if (opener?.isConnected) {
		return opener;
	}
	const buttons = queueButtons();
	const next = buttons[Math.max(0, queueIndex)] ?? null;
	return next ?? fallback.current;
}

/**
 * Why a run stopped, read-only: the blocker's title ("Likely …" for an
 * inferred one), its detail (never under redaction), when it happened
 * ("~" when approximate, "time unknown" when not known) and, only when
 * known, when it clears by itself. Its one action is Open (the thread);
 * there is no Retry. When the blocker leaves the snapshot the card reads
 * "Cleared" and focus moves to Close. Same dialog, focus return and key
 * isolation as the ask card.
 */
export function BlockerCard({
	agentName,
	clock,
	fallbackFocus,
	nowMs,
	onClose,
	opener = null,
	port,
	queueIndex = -1,
	snapshot,
	threadId,
}: {
	agentName: string;
	clock?: ClockOptions;
	/** The game's focusable heading: where focus lands when nothing else is left. */
	fallbackFocus: RefObject<HTMLElement | null>;
	nowMs: number;
	onClose: () => void;
	/** The control that opened the card; focus returns to it while it exists. */
	opener?: HTMLElement | null;
	port: InterfacePort;
	/** The opener's place in the ask queue (-1 when it is not a queue button). */
	queueIndex?: number;
	snapshot: InterfaceSnapshot;
	threadId: string;
}) {
	const live =
		snapshot.threads.find((item) => item.id === threadId)?.blocker ?? null;
	const last = useRef<InterfaceBlocker | null>(live);
	if (live) {
		last.current = live;
	}
	const blocker = live ?? last.current;
	const cleared = !live;
	const redacted = snapshot.privacy === "redacted";
	const openRef = useRef<HTMLButtonElement>(null);
	const closeRef = useRef<HTMLButtonElement>(null);
	const tl = useLiteralMessages();
	useEffect(() => {
		if (cleared) {
			closeRef.current?.focus();
		}
	}, [cleared]);
	if (!blocker) {
		return null;
	}
	const age = waitLabel(blocker.at ?? null, nowMs, {
		approx: blocker.atApprox,
	});
	const when = age ? `${age} ago` : "time unknown";
	const named = redacted ? blockerKindWord(blocker.kind) : blocker.title;
	const title = blocker.source === "estimate" ? `Likely ${named}` : named;
	return (
		<Dialog
			onOpenChange={(next) => {
				if (!next) {
					onClose();
				}
			}}
			open
		>
			<DialogContent
				className="max-sm:[&[data-blocker-card]]:!inset-x-[20px] max-sm:[&[data-blocker-card]]:!bottom-[20px] max-sm:[&[data-blocker-card]]:!w-auto max-sm:[&[data-blocker-card]]:!rounded-4xl max-w-[calc(100%-2rem)] gap-3 max-sm:px-4 sm:max-w-md"
				data-blocker-card=""
				finalFocus={() =>
					resolveReturnFocus(opener, queueIndex, fallbackFocus) ?? true
				}
				initialFocus={() => openRef.current ?? closeRef.current ?? true}
				onKeyDown={(event: KeyboardEvent) => event.stopPropagation()}
				showCloseButton={false}
			>
				<p className="font-medium text-muted-foreground text-xs">
					{tl("{agentName} stopped", { agentName })}
				</p>
				<DialogTitle className="text-lg leading-snug">{title}</DialogTitle>
				<DialogDescription className="flex flex-col gap-1">
					{!redacted && blocker.detail ? <span>{blocker.detail}</span> : null}
					<span>{when}</span>
					{blocker.clearsAt ? (
						<span>
							{tl("clears {clearsTime}", {
								clearsTime: clockLabel(blocker.clearsAt, nowMs, clock),
							})}
						</span>
					) : null}
				</DialogDescription>
				{cleared ? (
					<p className="font-medium text-sm" role="status">
						Cleared
					</p>
				) : null}
				<div className="flex flex-wrap gap-2">
					<Button
						onClick={() => {
							port.openThread(threadId);
							onClose();
						}}
						ref={openRef}
						size="sm"
						variant="secondary"
					>
						Open
					</Button>
					<Button onClick={onClose} ref={closeRef} size="sm" variant="ghost">
						Close
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
