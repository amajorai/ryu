import { CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { Logo as OrbLogo } from "@ryu/ui/components/logo";
import { toast } from "@ryu/ui/components/sileo";
import { Spinner } from "@ryu/ui/components/spinner";
import { StaggerReveal } from "@ryu/ui/components/stagger-reveal";
import { cn } from "@ryu/ui/lib/utils";
import { useCallback, useEffect, useState } from "react";
import { clearSessionToken, FRONTEND_URL, signOut } from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { fetchWaitlistMe, type WaitlistMe } from "@/src/lib/api/waitlist.ts";

// The desktop activation gate a pending account sees instead of the app. Mirrors
// the device-auth login screen (packages/blocks/src/desktop/login.tsx): the same
// centered column, the shimmering orb, title + subtitle, a full-width mono
// action in max-w-xs, the muted panel for position, and a small underline action.
export default function WaitlistPage({
	userName,
}: {
	userName?: string | null;
}) {
	const [me, setMe] = useState<WaitlistMe | null>(null);
	const [copied, setCopied] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const [signingOut, setSigningOut] = useState(false);

	const loadMe = useCallback(async (opts?: { manual?: boolean }) => {
		if (opts?.manual) {
			setRefreshing(true);
		}
		try {
			const data = await fetchWaitlistMe();
			setMe(data);
			if (data?.status === "approved") {
				window.location.reload();
			}
		} catch (err) {
			if (opts?.manual) {
				const network = err instanceof Error && err.message === "network";
				toast.error("Couldn't refresh", {
					description: network
						? "Can't reach the server. Check your connection, then try again."
						: "Try again in a moment.",
				});
			}
			// Background refresh keeps the last known state on screen.
		} finally {
			if (opts?.manual) {
				setRefreshing(false);
			}
		}
	}, []);

	useEffect(() => {
		loadMe();
	}, [loadMe]);

	// The application form is completed in the browser (Apply for early access
	// opens FRONTEND_URL/waitlist externally). When the user returns to the
	// desktop window, re-fetch so the Apply button and position reflect their
	// new status instead of the stale pre-apply state.
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
			setTimeout(() => setCopied(false), 2000);
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

	const title = userName
		? `You're in line, ${userName}`
		: "You're on the waitlist";

	return (
		// biome-ignore lint/a11y/noAriaHiddenOnFocusable: top area used as drag region
		<div className="size-full" data-tauri-drag-region="true">
			<div
				className="flex h-full w-full flex-col items-center justify-center gap-8 p-8"
				data-tauri-drag-region="true"
			>
				<StaggerReveal>
					<div className="shrink-0">
						<OrbLogo size="50px" variant="outline" />
					</div>

					<div className="space-y-1 text-left">
						<h1 className="font-medium text-xl">{title}</h1>
						<p className="font-medium text-muted-foreground text-xl">
							We&apos;re sending out invites soon.
						</p>
						<p className="font-medium text-muted-foreground text-xl">
							We&apos;ll email you the moment your spot opens up.
						</p>
					</div>

					<div className="flex w-full max-w-xs flex-col items-center gap-3">
						<Button
							className="w-full"
							disabled={refreshing}
							onClick={() => loadMe({ manual: true })}
							size="lg"
							type="button"
							variant="mono"
						>
							{refreshing ? (
								<span className="flex items-center gap-2">
									<Spinner className="size-4" />
									Refreshing…
								</span>
							) : (
								"Refresh"
							)}
						</Button>

						{me && !me.hasApplied ? (
							<Button
								className="w-full"
								onClick={() => openExternal(`${FRONTEND_URL}/waitlist`)}
								size="lg"
								type="button"
								variant="mono"
							>
								Apply for early access →
							</Button>
						) : null}
					</div>

					{me ? (
						<div className="w-full max-w-xs rounded-xl bg-muted/40 px-8 py-4 text-center">
							<p className="text-muted-foreground text-xs">Your position</p>
							<p className="font-bold text-3xl tabular-nums">
								#{me.position ?? "—"}
							</p>
							<p className="mt-1 text-muted-foreground text-xs">
								{me.totalWaiting.toLocaleString()} waiting
							</p>
							{me.eta ? (
								<p className="mt-2 border-border/40 border-t pt-2 text-muted-foreground text-xs">
									Est. wait{" "}
									<span className="font-medium text-foreground">{me.eta}</span>
								</p>
							) : null}
						</div>
					) : null}

					{me?.referralUrl ? (
						<div className="flex w-full max-w-xs flex-col items-center gap-3">
							<p className="text-center text-muted-foreground text-xs">
								Want in faster? Share your link — every friend who joins moves
								you up.
								{me.referralCount > 0
									? ` You've referred ${me.referralCount}.`
									: ""}
							</p>
							<button
								aria-label="Copy referral link"
								className="group flex w-full items-center gap-2 rounded-md bg-muted/40 px-3 py-2 text-left text-xs transition-colors hover:bg-muted/60"
								onClick={copyReferral}
								type="button"
							>
								<span className="min-w-0 flex-1 truncate text-muted-foreground group-hover:text-foreground">
									{me.referralUrl}
								</span>
								<span
									aria-hidden={!copied}
									className={cn(
										"flex shrink-0 items-center gap-1 font-medium text-primary transition-all duration-300 ease-out",
										copied
											? "translate-x-0 opacity-100"
											: "pointer-events-none translate-x-2 opacity-0"
									)}
								>
									<HugeiconsIcon icon={CheckmarkCircle02Icon} size={14} />
									Copied
								</span>
							</button>
						</div>
					) : null}

					<button
						className="text-xs underline underline-offset-2 disabled:opacity-50"
						disabled={signingOut}
						onClick={handleSignOut}
						type="button"
					>
						{signingOut ? "Signing out…" : "Sign out"}
					</button>
				</StaggerReveal>
			</div>
		</div>
	);
}
