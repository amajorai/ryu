// The facts a queued member's shareable pass is drawn from, derived ONCE for
// both waitlist screens (web `waitlist-view.tsx`, desktop `WaitlistPage.tsx`).
//
// This exists because the position gate is a rule, not a value: a queue too
// small to show a number on screen must not leak one into a picture — or into
// the compose text — posted to X. That rule used to live inline in the web
// screen only, which is exactly how the desktop ended up posting "spot #42"
// off a queue the web page was still hiding.
//
// Split out of `pass-share.ts` so that file stays React-free for the
// server-rendered `/pass` page; `QUEUE_STATS_MIN` lives in a client component.

import { QUEUE_STATS_MIN } from "../components/waitlist-pass.tsx";
import { isPassQueueNumber, type PassShareFacts } from "./pass-share.ts";

/** The subset of `/api/waitlist/me` the pass is drawn from. */
export interface WaitlistShareSource {
	joinedAt?: string | null;
	position?: number | null;
	referralCode?: string | null;
	totalWaiting?: number | null;
}

export function waitlistShareFacts(
	me: WaitlistShareSource | null | undefined,
	{
		reserved,
		userName,
	}: {
		/** The claimed handle, without the leading "@". */
		reserved?: string | null;
		userName?: string | null;
	}
): PassShareFacts {
	const showPosition =
		isPassQueueNumber(me?.totalWaiting) && me.totalWaiting > QUEUE_STATS_MIN;
	return {
		name: userName?.trim() || (reserved ? `@${reserved}` : "Member"),
		position: showPosition ? (me?.position ?? null) : null,
		ref: me?.referralCode ?? null,
		joined: me?.joinedAt ?? null,
		username: reserved ?? null,
	};
}
