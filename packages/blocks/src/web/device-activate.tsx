"use client";

import { Button } from "@ryu/ui/components/button";
import { Logo } from "@ryu/ui/components/logo";
import PageHeader from "@ryu/ui/components/page-header";
import type { ChangeEvent, FormEvent, ReactNode } from "react";

export interface DeviceActivateProps {
	/** Optional account switcher shown above the code form (device flow). */
	accountSwitcher?: ReactNode;
	/** Validation/verification error message. */
	error?: string | null;
	/** Verification request in flight. */
	isSubmitting?: boolean;
	/** Form submit handler. */
	onSubmit?: (e: FormEvent) => void;
	/** Code input change handler. */
	onUserCodeChange?: (e: ChangeEvent<HTMLInputElement>) => void;
	/** The current device code value. */
	userCode?: string;
}

const noop = () => {
	// presentational default; the live app injects real handlers
};

/**
 * The real device-activation page, presentational. The live route owns the
 * authClient verify call, router redirect and session gating; the storyboard
 * renders it standalone with static state.
 */
export default function DeviceActivate({
	userCode = "",
	error = null,
	isSubmitting = false,
	onUserCodeChange = noop,
	onSubmit = noop,
	accountSwitcher = null,
}: DeviceActivateProps) {
	return (
		<div className="flex min-h-[calc(100vh-5rem)] items-center justify-center px-4">
			<div className="w-full max-w-md space-y-8">
				<Logo size="32px" variant="outline" />
				<PageHeader
					subtitle="Enter the code displayed on your device to sign in"
					title="Activate device"
				/>

				{accountSwitcher}

				<form className="space-y-4" onSubmit={onSubmit}>
					<input
						autoComplete="off"
						className="w-full rounded-lg bg-muted/30 px-4 py-3 text-center font-mono text-xl uppercase tracking-widest focus:outline-none focus:ring-2 focus:ring-primary"
						maxLength={12}
						onChange={onUserCodeChange}
						placeholder="e.g. ABCD-1234"
						spellCheck={false}
						type="text"
						value={userCode}
					/>
					{error && (
						<p className="text-center text-destructive text-sm">{error}</p>
					)}
					<Button
						className="w-full"
						disabled={isSubmitting || userCode.trim().length < 4}
						size="lg"
						type="submit"
						variant="mono"
					>
						{isSubmitting ? "Verifying..." : "Continue"}
					</Button>
				</form>
			</div>
		</div>
	);
}
