import { WaitlistShareDialog } from "@ryu/blocks/web/waitlist-share-dialog.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import {
	linkedInShareUrl,
	waitlistShareText,
	xShareIntentUrl,
} from "@ryu/ui/components/waitlist-pass.tsx";
import { WaitlistQueue } from "@ryu/ui/components/waitlist-queue.tsx";
import {
	normalizeWaitlistUsername,
	WAITLIST_USERNAME_RE,
} from "@ryu/ui/components/waitlist-username-field.tsx";
import { passPageUrl } from "@ryu/ui/lib/pass-share.ts";
import { waitlistShareFacts } from "@ryu/ui/lib/waitlist-share-facts.ts";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	authClient,
	clearSessionToken,
	FRONTEND_URL,
	signOut,
} from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import {
	fetchWaitlistMe,
	openWaitlistStream,
	releaseWaitlistUsername,
	type WaitlistMe,
} from "@/src/lib/api/waitlist.ts";

/** How long the "Copied" label sticks before reverting. */
const COPIED_RESET_MS = 2000;

/** The host printed under the shared card, when FRONTEND_URL can't be parsed. */
const FALLBACK_SHARE_HOST = "ryuhq.com";
const TRAILING_SLASH_RE = /\/$/;
/** The web app, without a trailing slash — `${origin}/pass?…` must not double it. */
const SHARE_ORIGIN = FRONTEND_URL.replace(TRAILING_SLASH_RE, "");
const STREAM_INITIAL_BACKOFF_MS = 500;
const STREAM_MAX_BACKOFF_MS = 10_000;

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true }
		);
	});
}

// The desktop activation gate a pending account sees instead of the app.
//
// The screen itself is `WaitlistQueue` from the UI package and its share sheet
// is `WaitlistShareDialog` from blocks — the SAME two components apps/web
// renders. This file is only the desktop half of that contract: the bearer-token
// auth client, `openExternal` (the shell has no back button, so x.com must never
// open in the app window), the web app's origin (the shell's own is
// `tauri.localhost`), and the reload-based sign-out.
//
// It used to be a second, hand-written copy of the same screen, which is exactly
// why it sat months behind the web one — and after the screen was shared, the
// CALLBACKS drifted the same way: this file fired an x.com compose window
// straight off "Share your pass" instead of opening the dialog, with a position
// the web page's gate was hiding. Anything derived from queue state belongs in
// `@ryu/ui/lib/waitlist-share-facts`, not inline here.
export default function WaitlistPage({
	avatarSeed,
	avatarUrl,
	userName,
	userNameLoading = false,
}: {
	/** Canonical dither seed for the signed-in user (`ditherAvatarSeed`), so the
	 *  pass shows the same placeholder glyph as the sidebar's account row. */
	avatarSeed?: string | null;
	avatarUrl?: string | null;
	userName?: string | null;
	/** True while the session is still resolving, so a null `userName` means "not
	 *  known yet" rather than "this account has no display name". */
	userNameLoading?: boolean;
}) {
	// The metal ring ships its own light/dark tunings, and its `auto` default
	// follows the OS — wrong here, because the app's theme toggle can disagree
	// with it. Feed it the theme actually on screen.
	const { resolvedTheme } = useTheme();
	const [me, setMe] = useState<WaitlistMe | null>(null);
	const [copied, setCopied] = useState(false);
	const [signingOut, setSigningOut] = useState(false);
	const [handle, setHandle] = useState("");
	const [handleError, setHandleError] = useState<string | null>(null);
	const [reserving, setReserving] = useState(false);
	// Held locally as well as on `me` so the pass flips to the reserved handle the
	// instant the claim succeeds, without waiting for another /me read.
	const [reserved, setReserved] = useState<string | null>(null);
	const [sharing, setSharing] = useState(false);

	const loadMe = useCallback(async () => {
		try {
			const data = await fetchWaitlistMe();
			setMe(data);
			// Only adopt the server's handle; never clear a just-reserved one if a
			// background refresh raced ahead of the write.
			const serverHandle = data?.displayUsername ?? data?.username ?? null;
			if (serverHandle) {
				setReserved(serverHandle);
			}
			if (data?.status === "approved") {
				window.location.reload();
			}
		} catch {
			// Background refresh keeps the last known state on screen.
		}
	}, []);

	useEffect(() => {
		loadMe();
	}, [loadMe]);

	// Approval is a server-side transition, so polling alone leaves a queued
	// desktop account stuck until its next refresh. The API replays an approval
	// snapshot on connect, making this safe across missed events and reconnects.
	useEffect(() => {
		const controller = new AbortController();
		const watch = async () => {
			let backoff = STREAM_INITIAL_BACKOFF_MS;
			while (!controller.signal.aborted) {
				try {
					for await (const message of openWaitlistStream(controller.signal)) {
						if (message.data.status === "approved") {
							window.location.reload();
							return;
						}
						backoff = STREAM_INITIAL_BACKOFF_MS;
					}
				} catch {
					// Sign-out, network loss, and restarts reconnect below.
				}
				if (controller.signal.aborted) {
					break;
				}
				await delay(backoff, controller.signal);
				backoff = Math.min(backoff * 2, STREAM_MAX_BACKOFF_MS);
			}
		};
		watch().catch(() => {
			// The loop owns expected connection failures; teardown is the other exit.
		});
		return () => controller.abort();
	}, []);

	// The application form is completed in the browser (Apply for early access
	// opens FRONTEND_URL externally). When the user returns to the desktop window,
	// re-fetch so the Apply button and position reflect their new status instead
	// of the stale pre-apply state.
	useEffect(() => {
		const refresh = () => {
			if (document.visibilityState === "visible") {
				loadMe();
			}
		};
		window.addEventListener("focus", refresh);
		document.addEventListener("visibilitychange", refresh);
		return () => {
			window.removeEventListener("focus", refresh);
			document.removeEventListener("visibilitychange", refresh);
		};
	}, [loadMe]);

	const copyReferral = async () => {
		if (!me?.referralUrl) {
			return;
		}
		try {
			await navigator.clipboard.writeText(me.referralUrl);
			setCopied(true);
			toast.success("Copied to clipboard");
			setTimeout(() => setCopied(false), COPIED_RESET_MS);
		} catch {
			// Clipboard unavailable; the link is shown for manual copy.
		}
	};

	// Mirror the app's real sign-out (contexts/auth-context.tsx): clear the Better
	// Auth session (so useSession() stops returning the cached session) AND the
	// stored bearer token, then reload so the auth gate re-evaluates to logged-out.
	// Without the signOut()/reload the cached session keeps `authed` true.
	const handleSignOut = async () => {
		if (signingOut) {
			return;
		}
		setSigningOut(true);
		try {
			await Promise.all([signOut(), clearSessionToken()]);
		} finally {
			window.location.reload();
		}
	};

	// Claim the handle now, while queued, so an early position also buys the name.
	const reserveHandle = async () => {
		const next = normalizeWaitlistUsername(handle);
		if (!WAITLIST_USERNAME_RE.test(next)) {
			setHandleError("Use 3–32 letters, numbers or underscores.");
			return;
		}
		setReserving(true);
		setHandleError(null);
		try {
			// Skip the availability check when the handle is already yours.
			// `isUsernameAvailable` answers "is this free", and your own reserved
			// handle is not — so re-confirming it after "Change handle" used to fail
			// with "That handle is already taken", naming you as the taker.
			if (next !== reserved) {
				const availability = await authClient.isUsernameAvailable({
					username: next,
				});
				if (availability.error) {
					throw new Error(availability.error.message ?? "Handle unavailable");
				}
				if (availability.data?.available === false) {
					throw new Error("That handle is already taken.");
				}
			}
			const { error } = await authClient.updateUser({ username: next });
			if (error) {
				throw new Error(error.message ?? "Couldn't reserve that handle.");
			}
			setReserved(next);
			toast.success(`@${next} is reserved`);
		} catch (err) {
			setHandleError(
				err instanceof Error ? err.message : "Couldn't reserve that handle."
			);
		} finally {
			setReserving(false);
		}
	};

	// Give the handle back. The server does the clearing; this only resets what
	// the screen shows, which includes the pass — it reads the handle straight
	// off `reserved`.
	const unreserveHandle = async () => {
		setReserving(true);
		setHandleError(null);
		try {
			await releaseWaitlistUsername();
			setReserved(null);
			setHandle("");
			toast.success("Handle released");
		} catch {
			setHandleError("Couldn't release that handle. Try again in a moment.");
		} finally {
			setReserving(false);
		}
	};

	// The facts the shareable card is drawn from, via the SAME builder the web
	// screen uses — which is what applies the position gate. Reading `me.position`
	// straight (what this screen used to do) posted "spot #42" off a queue the web
	// page was still hiding.
	// Sticky: once a real display name has been seen, it is never given back.
	//
	// `session.user.name` is null on the first hydrate and fills in a tick later,
	// and the pass falls back to `@handle` when it has no name — so the card
	// printed the user's HANDLE for that tick and then swapped to their name. Two
	// different identities on a card whose whole job is to be screenshotted.
	//
	// Suppressing the handle fallback while the session is still resolving is not
	// enough on its own: the name can also blank out on a later refetch, and this
	// covers both.
	const lastKnownName = useRef<string | null>(null);
	if (userName?.trim()) {
		lastKnownName.current = userName;
	}
	const resolvedName = userName?.trim()
		? userName
		: (lastKnownName.current ??
			// Nothing yet AND the session may still deliver one — say "Member"
			// rather than promoting the handle to a display name it will lose.
			(userNameLoading ? "Member" : null));
	const shareFacts = waitlistShareFacts(me, {
		reserved,
		userName: resolvedName,
	});

	// The web app's host, not the shell's: `window.location.host` inside Tauri is
	// `tauri.localhost`, which would print a dead address under every shared card.
	let shareHost = FALLBACK_SHARE_HOST;
	try {
		shareHost = new URL(SHARE_ORIGIN).host;
	} catch {
		// Malformed FRONTEND_URL — the fallback is still a working address.
	}

	// Share the /pass page rather than the bare referral link: it is public and
	// carries the card as its og:image, so the post unfurls the pass instead of a
	// login screen — and it still forwards the referral code.
	// Everything opens in the user's browser, never in the app window: the desktop
	// shell has no back button to return from x.com.
	const shareOnX = () => {
		openExternal(
			xShareIntentUrl(
				waitlistShareText(shareFacts.position),
				passPageUrl(shareFacts, SHARE_ORIGIN)
			)
		);
	};

	// LinkedIn takes no compose text: it builds the post from the target page's
	// Open Graph tags, which is what /pass serves.
	const shareOnLinkedIn = () => {
		openExternal(linkedInShareUrl(passPageUrl(shareFacts, SHARE_ORIGIN)));
	};

	// Same three states the web screen reads, for the same reason: "apply" is the
	// one thing a queued member can do to move up, and a member who already did
	// should not still be told to.
	const APPLIED_SUBTITLE =
		"Your application is in. We're reviewing applications and sending invites. We'll email you the moment you're in.";
	const APPLY_SUBTITLE =
		"Applying is optional, but a complete application can move you up and get you in sooner.";
	const UNKNOWN_SUBTITLE =
		"You're on the list. We'll email you the moment your spot opens up.";
	let subtitle = UNKNOWN_SUBTITLE;
	if (me) {
		subtitle = me.hasApplied ? APPLIED_SUBTITLE : APPLY_SUBTITLE;
	}

	return (
		// top area used as drag region
		<div
			className="scroll-fade size-full overflow-y-auto"
			data-tauri-drag-region="true"
		>
			<WaitlistQueue
				avatarSeed={avatarSeed}
				avatarUrl={avatarUrl}
				className="min-h-full"
				copied={copied}
				eta={me?.eta}
				handle={handle}
				handleError={handleError}
				hasApplied={Boolean(me?.hasApplied)}
				joinedAt={me?.joinedAt}
				loaded={Boolean(me)}
				metalTheme={resolvedTheme === "light" ? "light" : "dark"}
				// /waitlist/apply, not /waitlist: the latter is the web queue page,
				// which mirrors this screen — opening it would land the user on a page
				// whose primary CTA is these same words.
				onApply={() => openExternal(`${SHARE_ORIGIN}/waitlist/apply`)}
				onChangeHandle={(next) => {
					setHandle(next);
					setHandleError(null);
				}}
				onCopyReferral={copyReferral}
				onLifetimeAccess={() => openExternal(`${SHARE_ORIGIN}/pricing#plans`)}
				onRefresh={loadMe}
				onReserve={reserveHandle}
				// Same as the web: "Share your pass" opens the share sheet (preview,
				// formats, image/video export, X and LinkedIn), it does not fire an
				// x.com compose window straight off the button.
				onShare={() => setSharing(true)}
				onSignOut={handleSignOut}
				onUnreserve={unreserveHandle}
				onUpgrade={() => openExternal(`${SHARE_ORIGIN}/pricing`)}
				position={me?.position ?? null}
				referralCount={me?.referralCount ?? 0}
				referralUrl={me?.referralUrl}
				reserved={reserved}
				reserving={reserving}
				signingOut={signingOut}
				subtitle={subtitle}
				totalWaiting={me?.totalWaiting ?? null}
				userName={resolvedName}
			/>
			<WaitlistShareDialog
				avatarUrl={avatarUrl}
				facts={shareFacts}
				host={shareHost}
				isDark={resolvedTheme !== "light"}
				onOpenChange={setSharing}
				onShareOnLinkedIn={shareOnLinkedIn}
				onShareOnX={shareOnX}
				open={sharing}
			/>
		</div>
	);
}
