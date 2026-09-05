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

import { Button } from "@ryu/ui/components/button";
import { ExpandableQRCode } from "@ryu/ui/components/qr-code";
import { Spinner } from "@ryu/ui/components/spinner";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

/**
 * How often to ask the node whether Telegram is done. The user has to switch
 * apps, read a dialog and confirm, so sub-second polling buys nothing and the
 * node forwards each poll to the manager (which rate-limits per nonce).
 */
const POLL_MS = 3000;
/**
 * How many polls in a row may fail before we say so. One flaky request during a
 * 10-minute wait is not worth tearing the flow down, but a node that has gone
 * away must not hide behind the countdown and then surface as "expired".
 */
const MAX_POLL_FAILURES = 4;
/** Countdown tick. Independent of the poll so the timer reads smoothly. */
const TICK_MS = 1000;
const SECONDS_PER_MINUTE = 60;
const QR_SIZE = 168;

type Phase =
	| "idle"
	| "starting"
	| "waiting"
	/** Telegram made a bot; the node is holding its token until the user says it is
	 *  theirs. See `confirming` below for why this step is not skippable. */
	| "confirming"
	| "completing"
	| "expired"
	| "failed";

/** The new bot, as the node describes it while asking whether to keep it. */
interface CreatedBot {
	botId: number;
	botUsername: string;
	ownerTelegramUserId: number | null;
}

/** `4:07` — a countdown the user can read against Telegram's 10-minute window. */
function formatRemaining(ms: number): string {
	const total = Math.max(0, Math.ceil(ms / TICK_MS));
	const minutes = Math.floor(total / SECONDS_PER_MINUTE);
	const seconds = total % SECONDS_PER_MINUTE;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

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
				.catch((error: unknown) => {
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
		return (
			<div className="space-y-3">
				<p className="text-muted-foreground text-xs">
					Open this in Telegram and tap the button it sends — Telegram creates a
					bot you own, and Ryu never sees your Telegram login or @BotFather.
				</p>
				<div className="flex flex-col items-center gap-3">
					<ExpandableQRCode size={QR_SIZE} value={pairing.deep_link} />
					<a
						className="break-all text-center text-sm underline hover:text-foreground"
						href={pairing.deep_link}
						rel="noopener noreferrer"
						target="_blank"
					>
						{pairing.deep_link}
					</a>
				</div>
				<div className="flex items-center justify-between gap-2">
					<p className="flex items-center gap-2 text-muted-foreground text-xs">
						<Spinner className="size-3" />
						Waiting for Telegram — expires in {formatRemaining(remainingMs)}
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
			<div className="space-y-3">
				<p className="text-xs">
					Telegram created{" "}
					<span className="font-medium">@{created.botUsername}</span>
					{created.ownerTelegramUserId === null
						? null
						: ` for Telegram account ${created.ownerTelegramUserId}`}
					.
				</p>
				{/* The one question only the person sitting here can answer. The setup
				    link is public — anyone who saw the QR could have opened it first —
				    so the handle above is what proves this is the bot they just made. */}
				<p className="text-muted-foreground text-xs">
					Connect it only if that is the bot you just created. If it isn't,
					discard it: nothing has been saved yet, and discarding revokes the
					token Ryu was handed.
				</p>
				{/* The Enabled switch is honoured rather than forced on — same as the
				    paste-a-token path — so say what that means here, where "Connect"
				    would otherwise read as a promise the switch overrides. */}
				{form.enabled === false ? (
					<p className="text-muted-foreground text-xs">
						Enabled is off in the form above, so it will be saved switched off
						and won't answer until you turn it on.
					</p>
				) : null}
				{failure ? (
					<p className="text-destructive text-xs">{failure.message}</p>
				) : null}
				<div className="flex gap-2">
					<Button
						aria-label={`Connect @${created.botUsername}`}
						className="whitespace-nowrap"
						onClick={() => {
							accept().catch(() => undefined);
						}}
						size="sm"
					>
						Connect @{created.botUsername}
					</Button>
					<Button onClick={refuse} size="sm" variant="ghost">
						Not mine — discard
					</Button>
				</div>
			</div>
		);
	}

	if (phase === "completing") {
		return (
			<p className="flex items-center gap-2 text-muted-foreground text-xs">
				<Spinner className="size-3" />
				Bot created — saving it now.
			</p>
		);
	}

	if (phase === "expired") {
		return (
			<div className="space-y-3">
				<p className="text-destructive text-xs">
					{failure?.kind === "expired"
						? failure.message
						: "That link expired before the bot was created. Nothing was saved."}
				</p>
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
			<div className="space-y-3">
				<p className="text-destructive text-xs">{failure.message}</p>
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
		<div className="space-y-3">
			<p className="text-muted-foreground text-xs">
				Telegram creates a bot you own and hands Ryu its token — you never visit
				@BotFather, and Ryu never sees your Telegram login.
			</p>
			<Button
				disabled={nameMissing || openingTargetMissing}
				loading={phase === "starting"}
				onClick={() => {
					start().catch(() => undefined);
				}}
				size="sm"
				variant="ghost"
			>
				Create a bot for me
			</Button>
			{nameMissing ? (
				<p className="text-muted-foreground text-xs">
					Give this bot a name above first — it's used as the suggested name in
					Telegram.
				</p>
			) : null}
			{openingTargetMissing ? (
				<p className="text-muted-foreground text-xs">
					Choose the approved chat for Ryu's welcome first.
				</p>
			) : null}
		</div>
	);
}
