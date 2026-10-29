import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";
// apps/desktop/src/lib/api/managed-bots.ts
//
// Typed client for the zero-token Telegram onboarding path ("managed bots",
// Bot API 9.6). Instead of sending the user to @BotFather to mint a token and
// paste it, Ryu's hosted MANAGER bot creates a bot the user owns and hands the
// token back to this node.
//
// Note the base-URL asymmetry with `channels.ts`, the sibling module that writes
// the resulting channel config: that one targets the identity/control plane
// (:3000, BACKEND_URL, Better-Auth session bearer) because a channel config is a
// "what is configured" record. THIS module targets the active Core NODE
// (ApiTarget/`request`, node bearer) because pairing is a node-local action: the
// node is what talks to the manager service, and the node is the only party that
// ever holds the pairing's `claim_secret`.
//
// That split is deliberate and load-bearing for security. The manager returns a
// public `nonce` (it goes into a QR the user may hold up to a camera) AND a
// `claim_secret` which is what actually authorizes redeeming the token. The
// secret never leaves Core — see {@link ManagedBotPairing}, which has no field
// for it. The desktop only ever sees nonce + deep link + status.

import { activityJsonValueSchema } from "@ryuhq/core-client/activity.ts";
import { z } from "zod";
import { ApiError, type ApiTarget, request } from "./client.ts";

/**
 * Cross-unit seam, and the one place this file can silently disagree with Core:
 * these are literal paths in a different language, so nothing but a matching
 * constant couples them. Core owns the definitions —
 * `apps/core/src/server/managed_bot_api.rs` keeps them as `PAIR_ROUTE` /
 * `POLL_ROUTE` / `CONFIRM_ROUTE` and asserts their exact spelling in a test, so
 * these three lines must be read against that file, not invented here.
 *
 * The poll route is `…/managed-bot/{nonce}`, NOT `…/status/{nonce}`: Core mounts a
 * single-segment `:nonce` param, and an extra segment matches no route at all —
 * which arrives as a 404 and reads to the user as an expired link.
 */
const PAIR_PATH = "/api/channels/managed-bot/pair";
const STATUS_PATH = "/api/channels/managed-bot";
const CONFIRM_SUFFIX = "/confirm";

/**
 * A freshly-opened pairing, as Core reports it to the desktop.
 *
 * Deliberately has NO `claim_secret` field, and must never gain one: the secret
 * is the credential that redeems a live bot token, and the whole point of the
 * node-side hop is that it stays on the node. The `nonce` alone is safe to
 * render (that is why it can go in a QR code).
 */
export interface ManagedBotPairing {
	/** `https://t.me/<manager>?start=mb_<nonce>` — what the user opens in Telegram. */
	deep_link: string;
	/** RFC3339 instant the pairing stops being redeemable (manager TTL, ~10 min). */
	expires_at: string;
	/** Public correlation id. Safe to display; useless without the node's secret. */
	nonce: string;
}

/**
 * Poll result. The three arms are Core's own vocabulary, verbatim.
 *
 * `confirm` is the security-critical one. The pairing nonce is public — it rides a
 * QR the user may hold up to a camera — so the manager binds the pairing to
 * whoever opens the deep link FIRST, which need not be the person at this desktop.
 * Core therefore holds the token unwritten and asks: is this bot yours? Only
 * {@link confirmManagedBot} lands it, and {@link cancelManagedBotPairing} refuses
 * it (which revokes the token, so a refused bot is left useful to nobody).
 *
 * `token` is optional on the ready arm on purpose: the node writes the channel row
 * itself — the pairing's claim secret has to be sealed into that row and must not
 * pass through a webview — so a ready status normally carries no token at all.
 */
export type ManagedBotStatus =
	| { status: "waiting" }
	| {
			bot_id: number;
			bot_username: string;
			/** Telegram user id the manager says owns the new bot. */
			owner_telegram_user_id: number | null;
			status: "confirm";
	  }
	| {
			bot_id: number;
			bot_username: string;
			channel_id?: string;
			status: "ready";
			token?: string;
	  };

/**
 * The add-channel form, sent when the pairing STARTS.
 *
 * It has to travel now, not at the end: the node writes the channel config itself
 * when the token lands, minutes after this dialog is gone. Anything omitted here is
 * a user choice that silently reverts to a server default — which is exactly how a
 * managed bot once arrived named after its @handle, bound to no agent, with the
 * default reply mode and enabled against the user's wishes.
 */
export interface ManagedBotPairingRequest {
	agent_id?: string | null;
	enabled?: boolean;
	group_reply_mode?: string;
	model?: string | null;
	/** Name for the channel config. Falls back to the created bot's `@handle`. */
	name?: string;
	/** Let Ryu send one welcome message when the channel starts. */
	proactive_opening?: boolean;
	/** Explicit approved chat id that should receive the welcome. */
	proactive_target?: string | null;
	/** Provider emojis that the Telegram adapter translates into Learning feedback. */
	reaction_learning?: {
		allowGroup: boolean;
		enabled: boolean;
		negativeEmoji: string[];
		positiveEmoji: string[];
	};
	/** Name Telegram pre-fills in its create-a-bot dialog (a hint, not a promise). */
	suggested_name?: string;
	system_prompt?: string | null;
	team_id?: string | null;
}

/**
 * Why a managed-bot call failed, in the shapes the UI has to draw differently.
 *
 * `unsupported` is the important one: managed bots need the operator to have
 * flipped BotFather's "Bot Management Mode" on Ryu's manager bot, which no amount
 * of client retrying fixes. It must fall back to the manual token path rather
 * than becoming a dead end, so it is a distinct kind and not just an error string.
 */
export type ManagedBotFailure =
	| { kind: "unsupported"; message: string }
	| { kind: "unreachable"; message: string }
	| { kind: "expired"; message: string };

/** Core's error code for "this node/manager cannot do managed bots at all". */
const UNSUPPORTED_ERROR = "managed_bots_unavailable";

const UNSUPPORTED_MESSAGE =
	"This node can't create Telegram bots for you yet — the hosted bot service hasn't been switched on.";

function unsupported(): ManagedBotFailure {
	return { kind: "unsupported", message: UNSUPPORTED_MESSAGE };
}

// Thrown values are untyped at the catch boundary. Only genuine native Error
// instances carry details this classifier reads; all other thrown values use
// the existing generic service-failure message.
const managedBotErrorSchema = z
	.union([z.instanceof(ApiError), z.instanceof(Error)])
	.nullable()
	.catch(null);
type ManagedBotError = z.output<typeof managedBotErrorSchema>;
function unreachable(error: ManagedBotError): ManagedBotFailure {
	if (error instanceof ApiError) {
		return {
			kind: "unreachable",
			message:
				error.serverMessage ??
				`The pairing service answered ${error.status}. Try again in a moment.`,
		};
	}
	return {
		kind: "unreachable",
		message:
			error instanceof Error
				? error.message
				: "Could not reach the pairing service.",
	};
}

/**
 * Classify a failure from {@link beginManagedBotPairing}.
 *
 * 501 is the contract's own "managed-bot endpoints stay OFF unless the manager
 * reports `can_manage_bots`" signal, and a 404 here means the route does not
 * exist — a Core too old to have it, or a manager that never mounted it. Both
 * mean the same thing to the user, so both collapse to `unsupported`.
 */
const pairFailureSchema = managedBotErrorSchema.transform(
	(error): ManagedBotFailure => {
		if (
			error instanceof ApiError &&
			(error.status === 501 ||
				error.status === 404 ||
				error.serverMessage === UNSUPPORTED_ERROR)
		) {
			return unsupported();
		}
		return unreachable(error);
	}
);
export const classifyPairError = pairFailureSchema.parse;

/**
 * Classify a failure from {@link getManagedBotStatus}.
 *
 * The 404 split from {@link classifyPairError} is the whole reason these are two
 * functions: on the status route the manager answers 404 for an unknown OR
 * expired nonce, so a 404 here means this pairing is dead, NOT that the feature
 * is missing. Collapsing the two would drop the user into the manual fields with
 * a wrong explanation every time a link timed out.
 */
const statusFailureSchema = managedBotErrorSchema.transform(
	(error): ManagedBotFailure => {
		if (error instanceof ApiError) {
			if (error.status === 501 || error.serverMessage === UNSUPPORTED_ERROR) {
				return unsupported();
			}
			if (error.status === 404) {
				return {
					kind: "expired",
					message: "That pairing link is no longer valid.",
				};
			}
		}
		return unreachable(error);
	}
);
export const classifyStatusError = statusFailureSchema.parse;

function preserveManagedBotReply<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			activityJsonValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
export const managedBotPairingSchema = preserveManagedBotReply(
	z.object({
		deep_link: z.string(),
		expires_at: z.string(),
		nonce: z.string(),
		status: z.literal("waiting").optional(),
	})
) satisfies z.ZodType<ManagedBotPairing>;
export const managedBotStatusSchema = preserveManagedBotReply(
	z.discriminatedUnion("status", [
		z.object({ status: z.literal("waiting") }),
		z.object({
			status: z.literal("confirm"),
			bot_id: z.number(),
			bot_username: z.string(),
			owner_telegram_user_id: z.number().nullable(),
		}),
		z.object({
			status: z.literal("ready"),
			bot_id: z.number(),
			bot_username: z.string(),
			channel_id: z.string().optional(),
			token: z.string().optional(),
		}),
	])
) satisfies z.ZodType<ManagedBotStatus>;
const managedBotCancelSchema = preserveManagedBotReply(
	z.object({ manager_forgot: z.boolean().optional(), status: z.string() })
);

/**
 * Open a pairing: Core asks the manager for a nonce + deep link, keeps the claim
 * secret, and returns only what the desktop may show.
 *
 * `suggested_name` is a hint the manager can pre-fill into Telegram's create-bot
 * dialog. It is best-effort — Telegram documents no guarantee that the suggestion
 * is honoured, so nothing downstream depends on the created bot bearing it.
 */
export function beginManagedBotPairing(
	target: ApiTarget,
	form: ManagedBotPairingRequest,
	signal?: AbortSignal
): Promise<ManagedBotPairing> {
	return request(
		target,
		PAIR_PATH,
		{
			method: "POST",
			body: form,
			signal,
		},
		gatewayJsonValueSchema
	).then(managedBotPairingSchema.parse);
}

/** The pairing's own URL. One builder, so the poll/confirm/cancel calls agree. */
function pairingUrl(nonce: string): string {
	return `${STATUS_PATH}/${encodeURIComponent(nonce)}`;
}

/**
 * Ask whether a pairing has completed. Core authenticates the underlying claim
 * with the secret it kept, so this call carries only the public nonce.
 */
export function getManagedBotStatus(
	target: ApiTarget,
	nonce: string,
	signal?: AbortSignal
): Promise<ManagedBotStatus> {
	return request(
		target,
		pairingUrl(nonce),
		{ signal },
		gatewayJsonValueSchema
	).then(managedBotStatusSchema.parse);
}

/**
 * "Yes, that is the bot I just created." The only call that makes the token a
 * channel config, so it is deliberately a separate user action and not something
 * the poll can do on its own.
 */
export function confirmManagedBot(
	target: ApiTarget,
	nonce: string,
	signal?: AbortSignal
): Promise<ManagedBotStatus> {
	return request(
		target,
		`${pairingUrl(nonce)}${CONFIRM_SUFFIX}`,
		{
			method: "POST",
			signal,
		},
		gatewayJsonValueSchema
	).then(managedBotStatusSchema.parse);
}

/**
 * "No, that is not mine" — or a plain cancel. Core drops the pairing and asks the
 * manager to forget the record, which revokes the token it holds: refusing a bot
 * someone else created must leave nobody with a working credential.
 */
export function cancelManagedBotPairing(
	target: ApiTarget,
	nonce: string,
	signal?: AbortSignal
): Promise<{ manager_forgot?: boolean; status: string }> {
	return request(
		target,
		pairingUrl(nonce),
		{ method: "DELETE", signal },
		gatewayJsonValueSchema
	).then(managedBotCancelSchema.parse);
}
