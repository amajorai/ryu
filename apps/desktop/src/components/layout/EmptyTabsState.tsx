// Shown in the main content area whenever every tab is closed: one mark, a
// greeting and the launchpad composer, centred. It mounts while Center has no
// route items (see Layout), even if a side region still hosts a route.
//
// The earlier quick-action grid, onboarding checklist and recent agents/spaces
// sections were hidden here on request and are gone; the composer is the one
// way in, and the library and sidebar keep those lists.

import { Logo as RyuLogo } from "@ryu/ui/components/logo.tsx";
import { useSession } from "@/lib/auth-client.ts";
import { LiveActivityDock } from "@/src/components/live/LiveActivityDock.tsx";
import { LaunchpadComposer } from "./EmptyTabsState-composer.tsx";

/** Splits a name on whitespace to pull the first token for the greeting. */
const WHITESPACE_RE = /\s+/;

/** A greeting that tracks the time of day, so the home reads as alive. */
function greeting(): string {
	const hour = new Date().getHours();
	if (hour < 5) {
		return "Good evening";
	}
	if (hour < 12) {
		return "Good morning";
	}
	if (hour < 18) {
		return "Good afternoon";
	}
	return "Good evening";
}

/** First name only — a full name in a greeting reads stiff. */
function firstName(name: string | null | undefined): string | null {
	const trimmed = name?.trim();
	if (!trimmed) {
		return null;
	}
	return trimmed.split(WHITESPACE_RE)[0];
}

/** Shown when Center has no routes — a quiet launchpad back into work. */
export function EmptyTabsState() {
	const { data: session } = useSession();
	const name = firstName(session?.user?.name);

	return (
		<div className="scroll-fade h-full w-full overflow-y-auto">
			{/* Centred at about 40% of the height while still scrolling from the
			    top when the content is taller than the viewport. */}
			<div className="flex min-h-full flex-col justify-center pb-[10vh]">
				<div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-12">
					<header className="flex flex-col items-center gap-6 text-center">
						<RyuLogo size="32px" variant="outline" />
						<h1 className="text-balance font-medium text-2xl text-foreground tracking-tight">
							{greeting()}
							{name ? `, ${name}` : ""}
						</h1>
					</header>

					<LaunchpadComposer />

					{/* Live activities: compact pills for whatever is in progress
					    (agent runs, downloads, approvals, recording). Self-hides when
					    nothing is live. */}
					<LiveActivityDock />
				</div>
			</div>
		</div>
	);
}
