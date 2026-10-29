import { LinkSquare02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import PageHeader from "@ryu/ui/components/page-header.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import type { MfaEnrollmentAccess } from "@ryuhq/core-client/mfa-enrollment.ts";
import { DoorClosed, DoorOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { clearSessionToken, signOut } from "@/lib/auth-client.ts";

// What a signed-in account sees instead of the app while it has neither an
// authenticator app nor a passkey. Setup itself lives on the website
// (/settings/setup-2fa), which already offers both factors and asks the user to
// sign in first when the browser has no session; this screen only sends them
// there, notices when they are done, and keeps the waitlist screen's way out.
export default function MfaEnrollmentPage({
	accountEmail,
	onCheckAgain,
	onOpenSetup,
}: {
	/** The signed-in account, so the user signs in to the website as the same one. */
	accountEmail?: string | null;
	/** Read the enrollment status now; resolves with the new answer. */
	onCheckAgain: () => Promise<MfaEnrollmentAccess | null>;
	/** Open the website's setup page in the system browser. */
	onOpenSetup: () => Promise<void> | void;
}) {
	const [checking, setChecking] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const [signingOut, setSigningOut] = useState(false);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const openSetup = async () => {
		setNotice(null);
		try {
			await onOpenSetup();
		} catch {
			setNotice(
				"Couldn't open your browser. Go to Settings on the Ryu website and add a passkey or an authenticator app."
			);
		}
	};

	// A `clear` answer swaps this screen for the app, so only the other two
	// answers ever need saying here.
	const checkAgain = async () => {
		if (checking) {
			return;
		}
		setChecking(true);
		setNotice(null);
		const access = await onCheckAgain();
		if (!mounted.current) {
			return;
		}
		setChecking(false);
		if (access === "required") {
			setNotice(
				"Still not set up. Add a passkey or an authenticator app in your browser, then check again."
			);
		} else if (access === "unknown") {
			setNotice("Couldn't reach Ryu to check. Try again in a moment.");
		}
	};

	// Same sign-out as the waitlist screen: clear the Better Auth session and the
	// stored bearer, then reload so the auth gate re-evaluates to signed out.
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

	return (
		// top area used as drag region
		<div
			className="scroll-fade size-full overflow-y-auto"
			data-tauri-drag-region="true"
		>
			<div className="relative flex min-h-full items-center justify-center px-4 py-12">
				<div className="flex w-full max-w-md flex-col gap-4">
					<PageHeader
						subtitle="Your Ryu account needs a passkey or an authenticator app before it can continue. Email codes don't count as a second factor."
						title="Set up two-factor authentication"
					/>

					{accountEmail ? (
						<p className="text-muted-foreground text-sm">
							Signed in as{" "}
							<span className="font-medium text-foreground">
								{accountEmail}
							</span>
							. Use this account if the website asks you to sign in.
						</p>
					) : null}

					<Button
						className="w-full"
						onClick={openSetup}
						size="lg"
						type="button"
					>
						<HugeiconsIcon icon={LinkSquare02Icon} size={18} />
						Open setup in browser
					</Button>

					<div className="flex flex-col gap-2 sm:flex-row">
						<Button
							className="flex-1"
							disabled={checking}
							onClick={checkAgain}
							size="lg"
							type="button"
							variant="secondary"
						>
							{checking ? (
								<span className="flex items-center gap-2">
									<Spinner className="size-4" />
									Checking…
								</span>
							) : (
								"Check again"
							)}
						</Button>
						<Button
							className="group flex-1"
							disabled={signingOut}
							onClick={handleSignOut}
							size="lg"
							type="button"
							variant="destructive"
						>
							<DoorClosed className="size-4 transition-all duration-200 group-hover:hidden" />
							<DoorOpen className="hidden size-4 transition-all duration-200 group-hover:block" />
							{signingOut ? "Signing out…" : "Sign out"}
						</Button>
					</div>

					{/* Always mounted, so screen readers announce a new answer. */}
					<p
						aria-live="polite"
						className="text-muted-foreground text-sm"
						role="status"
					>
						{notice}
					</p>
				</div>
			</div>
		</div>
	);
}
