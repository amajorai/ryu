// apps/desktop/src/components/channels/TelegramManagedBotPanel.tsx
//
// The zero-token half of the Telegram add-channel flow. Instead of walking the
// user through @BotFather and a copy-paste, Ryu's hosted manager bot creates a
// bot the USER owns (Bot API 9.6 "managed bots") and hands the token to this
// node, which then saves it exactly where a pasted token would have gone.
//
// Lives in its own file because the pairing flow is a small state machine with
// two timers, and AddChannelDialog is already a long form — the dialog stays the
// host and owns the submit, this owns only "get a token".
//
// Security note: the manager issues a public `nonce` AND a `claim_secret`, and
// only the secret can redeem the token. The secret stays on the node; this
// component never receives it (see lib/api/managed-bots.ts). That is why the
// nonce is safe to put in a QR code the user may hold up to a phone camera.

import { useLiteralMessages, useRichLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { ExpandableQRCode } from "@ryu/ui/components/qr-code.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ErrorLine } from "@/src/components/agents/shared/error-line.tsx";
import { InlineErrorRow } from "@/src/components/chat/InlineErrorRow.tsx";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	beginManagedBotPairing,
	cancelManagedBotPairing,
	classifyPairError,
	classifyStatusError,
	confirmManagedBot,
	getManagedBotStatus,
	type ManagedBotFailure,
	type ManagedBotPairing,
	type ManagedBotPairingRequest,
} from "@/src/lib/api/managed-bots.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import { BOT_NAME_TAGS } from "./TelegramManagedBotPanel-bot-name-tags.tsx";
import {
	type CreatedBot,
	formatRemaining,
	MAX_POLL_FAILURES,
	type Phase,
	POLL_MS,
	QR_SIZE,
	safeTelegramDeepLink,
	TICK_MS,
} from "./TelegramManagedBotPanel-pairing.ts";

export function TelegramManagedBotPanel({
	active,
	botName,
	form,
	onReady,
	onUnsupported,
}: {
	/** False whenever the dialog is closed or another platform/mode is selected —
	 *  the dialog stays mounted after Cancel, so without this the poll would keep
	 *  running in the background. */
	active: boolean;
	/** The form's Name field. Doubles as Telegram's suggested bot name and as the
	 *  gate on starting: the dialog's own submit requires a name, so pairing
	 *  before one exists would create a real bot we then refuse to save. */
	botName: string;
	/** The rest of the add-channel form. Sent when the pairing STARTS, because the
	 *  node writes the channel config itself minutes later — anything not sent now
	 *  is a user choice that quietly reverts to a server default. */
	form: Omit<ManagedBotPairingRequest, "name" | "suggested_name">;
	/** A token arrived (or the node saved the row itself, hence the optional).
	 *  The dialog completes through its normal submit path from here. */
	onReady: (token: string | undefined) => void;
	/** Managed bots are not available at all — the dialog falls back to the
	 *  manual token fields rather than leaving the user at a dead end. */
	onUnsupported: (message: string) => void;
}) {
	const tl = useLiteralMessages();
	const tlRich = useRichLiteralMessages();
	const getActiveNode = useNodeStore((s) => s.getActiveNode);
	const node = getActiveNode();
	// The store hands back a fresh object each render; the poll effect keys off
	// this, so narrow it to the two fields that actually matter.
	const target = useMemo(
		() => toTarget({ url: node.url, token: node.token, userJwt: node.userJwt }),
		[node.url, node.token]
	);

	const [phase, setPhase] = useState<Phase>("idle");
	const [pairing, setPairing] = useState<ManagedBotPairing | null>(null);
	const [created, setCreated] = useState<CreatedBot | null>(null);
	const [failure, setFailure] = useState<ManagedBotFailure | null>(null);
	const [remainingMs, setRemainingMs] = useState(0);

	// The dialog's callbacks close over its form state, so they change on every
	// keystroke. Held in refs so a rename mid-pairing cannot restart the poll.
	const onReadyRef = useRef(onReady);
	const onUnsupportedRef = useRef(onUnsupported);
	onReadyRef.current = onReady;
	onUnsupportedRef.current = onUnsupported;
	// Same reason: the form changes on every keystroke, and the pairing must not
	// restart because the user edited the system prompt.
	const formRef = useRef(form);
	formRef.current = form;

	const reset = useCallback(() => {
		setPhase("idle");
		setPairing(null);
		setCreated(null);
		setFailure(null);
		setRemainingMs(0);
	}, []);

	/**
	 * Tell the node to drop the pairing, best-effort. Worth doing on every exit and
	 * not just on "not mine": a pairing abandoned silently leaves the manager holding
	 * a claimable token for the rest of its window, and this call revokes it.
	 */
	const abandon = useCallback(
		(nonce: string) => {
			cancelManagedBotPairing(target, nonce).catch(() => undefined);
		},
		[target]
	);

	/**
	 * The pairing to abandon if the panel goes away, or null when there is nothing to
	 * abandon. Held in a ref so the teardown effect below does not re-run — and, more
	 * importantly, so it can tell "the user walked away mid-pairing" from "the token
	 * landed and the dialog closed itself". Abandoning in the second case would revoke
	 * the token of the bot we just connected.
	 */
	const abandonableRef = useRef<string | null>(null);
	abandonableRef.current =
		pairing && (phase === "waiting" || phase === "confirming")
			? pairing.nonce
			: null;

	// Leaving the panel (dialog closed, platform switched, mode switched) abandons the
	// pairing rather than letting it sit on the manager until it expires.
	useEffect(() => {
		if (!active) {
			const orphan = abandonableRef.current;
			if (orphan) {
				abandon(orphan);
			}
			reset();
		}
	}, [abandon, active, reset]);

	const start = useCallback(async () => {
		setFailure(null);
		setPhase("starting");
		try {
			const opened = await beginManagedBotPairing(target, {
				...formRef.current,
				name: botName.trim(),
				suggested_name: botName.trim(),
			});
			setPairing(opened);
			setRemainingMs(Math.max(0, Date.parse(opened.expires_at) - Date.now()));
			setPhase("waiting");
		} catch (error) {
			const classified = classifyPairError(error);
			if (classified.kind === "unsupported") {
				onUnsupportedRef.current(classified.message);
				reset();
				return;
			}
			setFailure(classified);
			setPhase("failed");
		}
	}, [target, botName, reset]);

	// Countdown. Purely cosmetic — the hard stop lives in the poll effect, so a
	// backgrounded window that never ticks still cannot poll past expiry.
	useEffect(() => {
		if (phase !== "waiting" || !pairing) {
			return;
		}
		const deadline = Date.parse(pairing.expires_at);
		const tick = window.setInterval(() => {
			setRemainingMs(Math.max(0, deadline - Date.now()));
		}, TICK_MS);
		return () => window.clearInterval(tick);
	}, [phase, pairing]);

	// Poll for completion, with a hard stop at the manager's expiry.
	useEffect(() => {
		if (phase !== "waiting" || !pairing) {
			return;
		}
		const deadline = Date.parse(pairing.expires_at);
		const nonce = pairing.nonce;
		let stopped = false;
		let consecutiveFailures = 0;
		const controller = new AbortController();
		const timer = window.setInterval(() => {
			if (stopped) {
				return;
			}
			// An unparseable expiry would otherwise poll forever; treat it as expired.
			if (!Number.isFinite(deadline) || deadline - Date.now() <= 0) {
				stopped = true;
				window.clearInterval(timer);
				controller.abort();
				setPhase("expired");
				return;
			}
			getManagedBotStatus(target, nonce, controller.signal)
				.then((status) => {
					if (stopped) {
						return;
					}
					consecutiveFailures = 0;
					if (status.status === "waiting") {
						return;
					}
					stopped = true;
					window.clearInterval(timer);
					if (status.status === "confirm") {
						// Do NOT connect it yet. Whoever opened the public deep link first
						// owns the bot Telegram made, so the only party who can tell this
						// is the right bot is the person sitting here.
						setCreated({
							botId: status.bot_id,
							botUsername: status.bot_username,
							ownerTelegramUserId: status.owner_telegram_user_id,
						});
						setPhase("confirming");
						return;
					}
					// A pairing that was already confirmed (a reload mid-flow) lands here.
					setPhase("completing");
					onReadyRef.current(status.token);
				})
				.catch((error) => {
					if (stopped || controller.signal.aborted) {
						return;
					}
					const classified = classifyStatusError(error);
					consecutiveFailures += 1;
					// Keep waiting through a flaky poll, but never silently: a definitive
					// answer stops immediately, and a run of failures is reported rather
					// than left to time out and masquerade as an expiry.
					if (
						classified.kind === "unreachable" &&
						consecutiveFailures < MAX_POLL_FAILURES
					) {
						return;
					}
					stopped = true;
					window.clearInterval(timer);
					controller.abort();
					if (classified.kind === "unsupported") {
						onUnsupportedRef.current(classified.message);
						reset();
						return;
					}
					if (classified.kind === "expired") {
						setPhase("expired");
						return;
					}
					setFailure(classified);
					setPhase("failed");
				});
		}, POLL_MS);
		return () => {
			stopped = true;
			window.clearInterval(timer);
			controller.abort();
		};
	}, [phase, pairing, target, reset]);

	/** The user says the bot is theirs: the node writes the token into a config. */
	const accept = useCallback(async () => {
		if (!pairing) {
			return;
		}
		setPhase("completing");
		try {
			const result = await confirmManagedBot(target, pairing.nonce);
			onReadyRef.current(result.status === "ready" ? result.token : undefined);
		} catch (error) {
			// The token is not lost: the node keeps holding it, so the retry is another
			// confirm and needs no second trip through Telegram.
			setFailure(classifyStatusError(error));
			setPhase("confirming");
		}
	}, [pairing, target]);

	/** The user says it is not theirs. Refusing revokes the token, so a bot created
	 *  by whoever grabbed the link is left useful to nobody. */
	const refuse = useCallback(() => {
		if (pairing) {
			abandon(pairing.nonce);
		}
		setFailure({
			kind: "expired",
			message:
				"Discarded — that bot was not connected, and Ryu revoked the token it was handed. Start over for a fresh link.",
		});
		setPhase("expired");
		setCreated(null);
	}, [abandon, pairing]);

	/** Leaving deliberately. Tell the node, so the manager stops holding a pairing
	 *  (and any token on it) for the rest of its window. */
	const cancel = useCallback(() => {
		if (pairing) {
			abandon(pairing.nonce);
		}
		reset();
	}, [abandon, pairing, reset]);

	const nameMissing = !botName.trim();
	const openingTargetMissing =
		form.proactive_opening === true && !form.proactive_target?.trim();

	if (phase === "waiting" && pairing) {
		const deepLink = safeTelegramDeepLink(pairing.deep_link);
		if (!deepLink) {
			return (
				<div className="flex flex-col gap-3">
					<InlineErrorRow message="Telegram returned an invalid pairing link. Cancel and start again." />
					<Button onClick={cancel} size="xs" variant="ghost">
						Cancel
					</Button>
				</div>
			);
		}
		return (
			<div className="flex flex-col gap-3">
				<p className="text-detail text-muted-foreground">
					Open this in Telegram and tap the button it sends.
				</p>
				<div className="flex flex-col items-center gap-3">
					<ExpandableQRCode size={QR_SIZE} value={deepLink} />
					<a
						className="break-all text-center text-sm underline hover:text-foreground"
						href={deepLink}
						rel="noopener noreferrer"
						target="_blank"
					>
						{deepLink}
					</a>
				</div>
				<div className="flex items-center justify-between gap-2">
					<p className="flex items-center gap-2 text-detail text-muted-foreground tabular-nums">
						<Spinner className="size-3.5" />
						{tl("Waiting for Telegram — expires in {remaining}", {
							remaining: formatRemaining(remainingMs),
						})}
					</p>
					<Button onClick={cancel} size="xs" variant="ghost">
						Cancel
					</Button>
				</div>
			</div>
		);
	}

	if (phase === "confirming" && created) {
		return (
			<div className="flex flex-col gap-3">
				<p className="text-sm">
					{created.ownerTelegramUserId === null
						? tlRich(
								"Telegram created <span>@{botUsername}</span>.",
								{ botUsername: created.botUsername },
								BOT_NAME_TAGS
							)
						: tlRich(
								"Telegram created <span>@{botUsername}</span> for Telegram account {ownerTelegramUserId}.",
								{
									botUsername: created.botUsername,
									ownerTelegramUserId: String(created.ownerTelegramUserId),
								},
								BOT_NAME_TAGS
							)}
				</p>
				{/* The one question only the person sitting here can answer. The setup
				    link is public — anyone who saw the QR could have opened it first —
				    so the handle above is what proves this is the bot they just made. */}
				<p className="text-detail text-muted-foreground">
					Connect it only if you just created it. Nothing has been saved yet,
					and discarding revokes its token.
				</p>
				{/* The Enabled switch is honoured rather than forced on — same as the
				    paste-a-token path — so say what that means here, where "Connect"
				    would otherwise read as a promise the switch overrides. */}
				{form.enabled === false ? (
					<p className="text-detail text-muted-foreground">
						Enabled is off above, so it will be saved switched off.
					</p>
				) : null}
				{failure ? <ErrorLine message={failure.message} /> : null}
				<div className="flex gap-2">
					<Button
						aria-label={tl("Connect @{botUsername}", {
							botUsername: created.botUsername,
						})}
						className="whitespace-nowrap"
						onClick={() => {
							accept().catch(() => undefined);
						}}
						size="sm"
						variant="mono"
					>
						{tl("Connect @{botUsername}", { botUsername: created.botUsername })}
					</Button>
					<Button onClick={refuse} size="sm" variant="ghost">
						Not mine, discard
					</Button>
				</div>
			</div>
		);
	}

	if (phase === "completing") {
		return (
			<p className="flex items-center gap-2 text-detail text-muted-foreground">
				<Spinner className="size-3.5" />
				Bot created — saving it now.
			</p>
		);
	}

	if (phase === "expired") {
		return (
			<div className="flex flex-col gap-3">
				<ErrorLine
					message={
						failure?.kind === "expired"
							? failure.message
							: "That link expired before the bot was created. Nothing was saved."
					}
				/>
				<Button
					onClick={() => {
						start().catch(() => undefined);
					}}
					size="sm"
					variant="ghost"
				>
					Start over
				</Button>
			</div>
		);
	}

	if (phase === "failed" && failure) {
		return (
			<div className="flex flex-col gap-3">
				<ErrorLine message={failure.message} />
				<Button
					onClick={() => {
						start().catch(() => undefined);
					}}
					size="sm"
					variant="ghost"
				>
					Try again
				</Button>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-3">
			<p className="text-detail text-muted-foreground">
				Telegram creates a bot you own. Ryu never sees your Telegram login.
			</p>
			<Button
				disabled={nameMissing || openingTargetMissing}
				loading={phase === "starting"}
				onClick={() => {
					start().catch(() => undefined);
				}}
				size="sm"
				variant="outline"
			>
				Create a bot for me
			</Button>
			{nameMissing ? (
				<p className="text-detail text-muted-foreground">
					Give this bot a name above first.
				</p>
			) : null}
			{openingTargetMissing ? (
				<p className="text-detail text-muted-foreground">
					Choose the approved chat for Ryu's welcome first.
				</p>
			) : null}
		</div>
	);
}
