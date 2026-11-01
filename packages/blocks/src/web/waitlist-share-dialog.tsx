"use client";

import { formatPassDate } from "@ryu/ui/components/waitlist-pass.tsx";
import {
	type PassShareFacts,
	passBackdropSeed,
} from "@ryu/ui/lib/pass-share.ts";
import { useMemo } from "react";
import { PassShareDialog } from "./pass-share-dialog.tsx";

// The waitlist pass's share sheet: nothing but what makes THIS card itself —
// its seeded backdrop, its type, and the member's own referral line. The tabs,
// the format ladder, the recorder and the four actions all live in
// <PassShareDialog>, which is shared with the paid-tier card.
//
// The picture here is the REAL card — the same warp shader, the same metal ring,
// turned in real perspective — rather than the flat side-by-side raster that
// `/api/og/pass` draws. See `@ryu/ui/components/pass-studio`. That raster is
// still what an unfurled `/pass` link shows, because an `og:image` has to be a
// URL a crawler can fetch and this one is made in the member's own browser.
//
// ONE definition for both waitlist screens (`apps/web` waitlist-view.tsx and the
// desktop's WaitlistPage.tsx), which is why `host` and `isDark` are props rather
// than read off `window.location` and `next-themes`: the desktop shell's own
// host is `tauri.localhost`, and printing that under the card would put a dead
// address on every picture a desktop member posts.

export function WaitlistShareDialog({
	avatarUrl,
	facts,
	host,
	isDark,
	onOpenChange,
	onShareOnLinkedIn,
	onShareOnX,
	open,
}: {
	/** The member's own picture, if set — the card draws it above the name. */
	avatarUrl?: string | null;
	facts: PassShareFacts;
	/** The web app's host, e.g. `ryuhq.com` — never the shell's own origin. */
	host: string;
	isDark: boolean;
	onOpenChange: (open: boolean) => void;
	onShareOnLinkedIn: () => void;
	onShareOnX: () => void;
	open: boolean;
}) {
	// The card's OWN backdrop seed, by the live card's rule. Anything else and
	// the exported card is a different colour from the one on screen.
	const seed = passBackdropSeed(facts);
	// Memoized because it is the scene's identity: a fresh object every render
	// would rebuild the type layer on every keystroke behind the dialog.
	const content = useMemo(
		() => ({
			joined: formatPassDate(facts.joined),
			name: facts.name,
			position: facts.position ?? null,
			referralUrl: facts.ref
				? `https://${host.replace(/^https?:\/\//u, "")}/r/${encodeURIComponent(facts.ref)}`
				: null,
			username: facts.username ?? null,
		}),
		[facts.joined, facts.name, facts.position, facts.ref, facts.username, host]
	);

	// What gets printed under the card. The member's OWN referral link, not the
	// bare domain: the picture is the ad, so the one line on it should be the one
	// that credits them when a viewer types it in. Matches `referralUrlFor`
	// (`${origin}/r/${code}`), minus the protocol — nobody reads "https://" off a
	// video, and dropping it buys back the width the code needs.
	const wordmark = facts.ref ? `${host}/r/${facts.ref}` : host;

	return (
		<PassShareDialog
			description="Your card, in the shape the post wants it."
			filenameStem="ryu-pass"
			onOpenChange={onOpenChange}
			onShareOnLinkedIn={onShareOnLinkedIn}
			onShareOnX={onShareOnX}
			open={open}
			studio={{
				avatarUrl,
				content,
				isDark,
				seed,
				wordmark,
			}}
			title="Share your pass"
		/>
	);
}
