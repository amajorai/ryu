import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import {
	askKindWords,
	type ClockOptions,
	type InterfaceAsk,
	type InterfaceAskChoice,
	type InterfacePort,
	type InterfaceSnapshot,
	isSuggestion,
	riskTagLabel,
	waitLabel,
} from "@ryuhq/protocol/interfaces";
import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { isolateKeys, plainText } from "./interface-ask-card-core.ts";
import { resolveReturnFocus } from "./interface-blocker-card.tsx";

// ---------------------------------------------------------------------------
// Ask card
// ---------------------------------------------------------------------------

/** The card's expiry line: "Expires in 7m", "Expires in up to 7m". */
export function expiryText(
	ask: InterfaceAsk,
	nowMs: number,
	tl: LiteralMessage
): string | null {
	if (!ask.expiresAt) {
		return null;
	}
	const left = waitLabel(ask.since ?? ask.expiresAt, nowMs, {
		until: ask.expiresAt,
	});
	if (!left) {
		return null;
	}
	const span = left.replace(/^in /, "").replace(/^≤ ?/, "");
	return ask.expiresApprox
		? tl("Expires in up to {span}", { span })
		: tl("Expires in {span}", { span });
}

/** The card's age line: "Waited 14m", "Waited ~7m". */
export function ageText(ask: InterfaceAsk, nowMs: number): string | null {
	const age = waitLabel(ask.since, nowMs, { approx: ask.sinceApprox });
	return age ? `Waited ${age}` : null;
}

/** The card's first line: who asks, offers an answer, or suggests. */
export function askerLine(ask: InterfaceAsk, owner: string | null): string {
	const who = owner ?? "Inbox";
	if (ask.kind === "reply") {
		return `${who} has an answer ready`;
	}
	if (isSuggestion(ask)) {
		return ask.kind === "question"
			? `${who} has a question when you have time`
			: `${who} suggests`;
	}
	return `${who} asks`;
}

/** What makes an ask "changed in place" (cancels a pending confirm). */
function askShape(ask: InterfaceAsk | undefined): string {
	if (!ask) {
		return "";
	}
	return JSON.stringify([ask.text, ask.choices, ask.expiresAt]);
}

/**
 * The ask card: what is asked, why, how long it has waited and until when,
 * its target and up to 2 risk tags, then the choices. A destructive
 * choice asks "Confirm …?" first. It reads the ask from the live snapshot:
 * when the ask leaves it, the card says "No longer waiting" and only Close
 * works. Under redaction it offers Open only. Tool arguments are never
 * shown, only the host's short target.
 */
export function AskCard({
	askId,
	clock: _clock,
	fallbackFocus,
	nowMs,
	onClose,
	opener = null,
	ownerName: owner,
	port,
	queueIndex = -1,
	snapshot,
}: {
	askId: string;
	clock?: ClockOptions;
	/** The game's focusable heading: where focus lands when nothing else is left. */
	fallbackFocus: RefObject<HTMLElement | null>;
	nowMs: number;
	onClose: () => void;
	/** The control that opened the card; focus returns to it while it exists. */
	opener?: HTMLElement | null;
	ownerName: string | null;
	port: InterfacePort;
	/** The opener's place in the ask queue (-1 when it is not a queue button). */
	queueIndex?: number;
	snapshot: InterfaceSnapshot;
}) {
	const tl = useLiteralMessages();
	const live = snapshot.asks?.find((item) => item.id === askId);
	const last = useRef<InterfaceAsk | undefined>(live);
	if (live) {
		last.current = live;
	}
	const ask = live ?? last.current;
	const stale = !live;
	const staleRef = useRef(stale);
	staleRef.current = stale;
	const redacted = snapshot.privacy === "redacted";
	const [confirming, setConfirming] = useState<InterfaceAskChoice | null>(null);
	const [answering, setAnswering] = useState(false);
	const [failed, setFailed] = useState(false);
	const openRef = useRef<HTMLButtonElement>(null);
	const firstSafeRef = useRef<HTMLButtonElement>(null);
	const closeRef = useRef<HTMLButtonElement>(null);
	const cancelRef = useRef<HTMLButtonElement>(null);
	const bodyRef = useRef<HTMLDivElement>(null);
	const confirmedRef = useRef<string | null>(null);
	const promptId = useId();
	const shape = askShape(live);
	const shapeRef = useRef(shape);
	// An ask changed in place, or details just got hidden: drop the confirm
	// step so a stale destructive choice can never fire.
	useEffect(() => {
		if (shapeRef.current !== shape || redacted || stale) {
			setConfirming(null);
		}
		shapeRef.current = shape;
	}, [redacted, shape, stale]);
	useEffect(() => {
		if (stale) {
			if (answering) {
				// The ask left while we were answering it: that is success.
				onClose();
				return;
			}
			closeRef.current?.focus();
		}
	}, [answering, onClose, stale]);
	// Into the confirm step: focus Cancel. Out of it (Cancel, a stale ask,
	// an in-place change, details hidden): back to the choice that asked,
	// or Close when that choice is gone or disabled.
	useEffect(() => {
		if (confirming) {
			confirmedRef.current = confirming.id;
			cancelRef.current?.focus();
			return;
		}
		const asked = confirmedRef.current;
		if (asked === null) {
			return;
		}
		confirmedRef.current = null;
		const choice = bodyRef.current?.querySelector<HTMLButtonElement>(
			`[data-choice="${CSS.escape(asked)}"]`
		);
		if (staleRef.current) {
			// "No longer waiting": Close is the only thing left to do.
			closeRef.current?.focus();
		} else if (choice && !choice.disabled) {
			choice.focus();
		} else {
			(openRef.current ?? closeRef.current)?.focus();
		}
	}, [confirming]);
	if (!ask) {
		return null;
	}
	const canOpen = ask.threadId ? true : Boolean(port.openInbox);
	const choices = redacted || !port.answerAsk ? [] : (ask.choices ?? []);
	const firstSafe = choices.find((choice) => !choice.destructive);
	const answer = async (choice: InterfaceAskChoice) => {
		if (stale || redacted || !port.answerAsk) {
			return;
		}
		setAnswering(true);
		setFailed(false);
		try {
			await port.answerAsk(ask.id, choice.id);
			onClose();
		} catch {
			setFailed(true);
		} finally {
			setAnswering(false);
		}
	};
	const choose = (choice: InterfaceAskChoice) => {
		if (choice.destructive) {
			setConfirming(choice);
			return;
		}
		answer(choice);
	};
	const openIt = () => {
		if (ask.threadId) {
			port.openThread(ask.threadId);
		} else {
			port.openInbox?.();
		}
		onClose();
	};
	const tags = (ask.riskTags ?? []).slice(0, 2).map(riskTagLabel);
	const age = ageText(ask, nowMs);
	const expiry = expiryText(ask, nowMs, tl);
	const title = redacted ? askKindWords(ask) : plainText(ask.text);
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
				className="max-sm:[&[data-ask-card]]:!inset-x-[20px] max-sm:[&[data-ask-card]]:!bottom-[20px] max-sm:[&[data-ask-card]]:!w-auto max-sm:[&[data-ask-card]]:!rounded-4xl max-w-[calc(100%-2rem)] gap-3 max-sm:px-4 sm:max-w-md"
				data-ask-card=""
				finalFocus={() =>
					resolveReturnFocus(opener, queueIndex, fallbackFocus) ?? true
				}
				initialFocus={() =>
					openRef.current ?? firstSafeRef.current ?? closeRef.current ?? true
				}
				onKeyDown={isolateKeys}
				showCloseButton={false}
			>
				<div className="contents" ref={bodyRef}>
					<p className="font-medium text-muted-foreground text-xs">
						{askerLine(ask, owner)}
					</p>
					<DialogTitle className="text-lg leading-snug">{title}</DialogTitle>
					<DialogDescription className="flex flex-col gap-1">
						{!redacted && ask.reason ? (
							<span>{plainText(ask.reason)}</span>
						) : null}
						<span>{[age, expiry].filter(Boolean).join(" · ")}</span>
					</DialogDescription>
					{!redacted && ask.target ? (
						<p className="text-sm">
							{tl("Target: {target}", { target: ask.target })}
						</p>
					) : null}
					{tags.length > 0 ? (
						<ul aria-label="Risk" className="flex flex-wrap gap-1.5">
							{tags.map((tag) => (
								<li
									className="rounded-full bg-muted px-2 py-0.5 text-xs"
									key={tag}
								>
									{tag}
								</li>
							))}
						</ul>
					) : null}
					{redacted ? (
						<p className="text-sm">
							Details are hidden while work details are hidden. Open to answer.
						</p>
					) : null}
					{stale ? (
						<p className="font-medium text-sm" role="status">
							No longer waiting
						</p>
					) : null}
					{failed ? (
						<p className="text-destructive text-sm" role="alert">
							That answer did not go through. Open the chat to answer there.
						</p>
					) : null}
					{confirming ? (
						<div
							aria-labelledby={promptId}
							className="flex flex-wrap items-center gap-2"
							data-ask-confirm=""
							role="group"
						>
							<span className="text-sm" id={promptId}>
								{tl("Confirm {label}?", { label: confirming.label })}
							</span>
							<Button
								aria-describedby={promptId}
								disabled={stale || answering}
								onClick={() => answer(confirming)}
								size="sm"
								variant="destructive"
							>
								{tl("Confirm {label}", { label: confirming.label })}
							</Button>
							<Button
								aria-describedby={promptId}
								onClick={() => setConfirming(null)}
								ref={cancelRef}
								size="sm"
								variant="outline"
							>
								Cancel
							</Button>
						</div>
					) : null}
					<div className="flex flex-wrap gap-2">
						{choices.map((choice) => (
							<Button
								data-choice={choice.id}
								disabled={stale || answering}
								key={choice.id}
								onClick={() => choose(choice)}
								ref={choice === firstSafe ? firstSafeRef : undefined}
								size="sm"
								variant={choice.tone === "deny" ? "outline" : "default"}
							>
								{choice.label}
							</Button>
						))}
						{canOpen ? (
							<Button
								onClick={openIt}
								ref={openRef}
								size="sm"
								variant="secondary"
							>
								Open
							</Button>
						) : null}
						<Button onClick={onClose} ref={closeRef} size="sm" variant="ghost">
							Close
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
