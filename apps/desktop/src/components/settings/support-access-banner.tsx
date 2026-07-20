// apps/desktop/src/components/settings/support-access-banner.tsx
//
// The always-visible "support access active" banner (#547, P5 of
// docs/observability-analytics-support-access.md). The §5.2 / §6 design requires
// a visible indicator while the local Core diagnostic channel is granted, plus a
// one-click end (WorkOS/Notion pattern). This is mounted app-level in the layout
// shell (next to PrivacyDisclosure) so it shows on EVERY route, not just the
// Privacy settings tab.
//
// The active-state predicate mirrors Core's `SupportAccessLocal::is_active`:
// granted = enabled AND (no expiry OR now < expiry). Ending the grant flips the
// enabled pref to false (the expiry is left as-is; Core's startup sweep + the
// enabled flag are the durable guarantee). Polls the prefs so it reflects an
// expiry that has lapsed, or a grant made from another surface.

import { ShieldKeyIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { toast } from "@ryu/ui/components/sileo";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	getSupportAccessLocalEnabled,
	getSupportAccessLocalExpiry,
	setSupportAccessLocalEnabled,
} from "@/src/lib/api/preferences.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

// How often to re-check the grant so an expiry that lapses (or a grant made on
// another surface) is reflected without a manual refresh.
const POLL_INTERVAL_MS = 15_000;

/** Mirror of Core's `SupportAccessLocal::is_active`: granted AND not expired. */
function isGrantActive(enabled: boolean, expiryMs: number, nowMs: number) {
	return enabled && (expiryMs === 0 || nowMs < expiryMs);
}

/** Human-readable "expires in N" for the banner; empty when no expiry is set. */
function formatRemaining(expiryMs: number, nowMs: number): string {
	if (expiryMs === 0) {
		return "no expiry set";
	}
	const remaining = expiryMs - nowMs;
	if (remaining <= 0) {
		return "expiring";
	}
	const minutes = Math.floor(remaining / 60_000);
	if (minutes < 60) {
		return `expires in ${minutes} min`;
	}
	// Floor to whole hours and surface the leftover minutes so we never overstate
	// the time left (e.g. 90 min reads "1 h 30 min", not "2 h").
	const hours = Math.floor(minutes / 60);
	const leftoverMinutes = minutes % 60;
	if (leftoverMinutes === 0) {
		return `expires in ${hours} h`;
	}
	return `expires in ${hours} h ${leftoverMinutes} min`;
}

/**
 * App-level banner shown whenever the local support-access channel is active.
 * Non-rendering when the grant is off/expired.
 */
export function SupportAccessBanner() {
	// No tab context here (mounted in the shell), so resolve the default node.
	// Select the node (a stable store ref), then derive `target` in the render
	// body — building the object inside the selector would return a fresh object
	// on every store change and re-render the banner needlessly.
	const node = useNodeStore((s) => s.getActiveNode());
	const target: ApiTarget = useMemo(
		() => ({ url: node.url, token: node.token ?? null }),
		[node.url, node.token]
	);

	const [active, setActive] = useState(false);
	const [expiryMs, setExpiryMs] = useState(0);
	const [now, setNow] = useState(() => Date.now());
	const [ending, setEnding] = useState(false);

	const cancelledRef = useRef(false);

	const refresh = useCallback(async () => {
		const [enabled, expiry] = await Promise.all([
			getSupportAccessLocalEnabled(target),
			getSupportAccessLocalExpiry(target),
		]);
		if (cancelledRef.current) {
			return;
		}
		const nowMs = Date.now();
		setExpiryMs(expiry);
		setNow(nowMs);
		setActive(isGrantActive(enabled, expiry, nowMs));
	}, [target]);

	useEffect(() => {
		cancelledRef.current = false;
		refresh().catch(() => undefined);
		const id = setInterval(() => {
			refresh().catch(() => undefined);
		}, POLL_INTERVAL_MS);
		return () => {
			cancelledRef.current = true;
			clearInterval(id);
		};
	}, [refresh]);

	const handleEnd = useCallback(async () => {
		setEnding(true);
		try {
			await setSupportAccessLocalEnabled(target, false);
			if (!cancelledRef.current) {
				setActive(false);
			}
		} catch {
			// Ending failed — the grant is still live, so keep the banner up and
			// tell the user instead of silently swallowing the rejection.
			toast.error("Couldn't end support access", {
				description: "Check your connection and try again.",
			});
		} finally {
			if (!cancelledRef.current) {
				setEnding(false);
			}
		}
	}, [target]);

	if (!active) {
		return null;
	}

	return (
		<div className="pointer-events-auto fixed top-12 right-4 z-50 flex items-center gap-3 rounded-xl border border-warning/40 bg-warning/15 px-3 py-2 shadow-lg backdrop-blur-xl">
			<HugeiconsIcon
				className="size-4 shrink-0 text-warning dark:text-warning"
				icon={ShieldKeyIcon}
			/>
			<div className="flex flex-col leading-tight">
				<span className="font-medium text-xs">Support access active</span>
				<span className="text-[11px] text-muted-foreground">
					Support can read redacted diagnostics over the mesh ·{" "}
					{formatRemaining(expiryMs, now)}
				</span>
			</div>
			<Button
				className="h-7"
				disabled={ending}
				onClick={handleEnd}
				size="sm"
				variant="outline"
			>
				End now
			</Button>
		</div>
	);
}
