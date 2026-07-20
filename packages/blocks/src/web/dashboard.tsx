"use client";

import { Button } from "@ryu/ui/components/button";

const noop = () => {
	// presentational default; the live app injects real handlers
};

export interface DashboardProps {
	/** Manage-subscription handler (live app opens the Polar portal). */
	onManage?: () => void | Promise<void>;
	/** Upgrade handler (live app starts the Polar checkout). */
	onUpgrade?: () => void | Promise<void>;
	/** Whether the customer has an active Pro subscription. */
	pro?: boolean;
}

/**
 * The real dashboard plan-status panel, presentational. The live page passes
 * authClient-backed handlers and resolves `pro` from the customer state; the
 * storyboard renders it standalone with a static `pro` prop.
 */
export default function Dashboard({
	pro = false,
	onManage = noop,
	onUpgrade = noop,
}: DashboardProps) {
	return (
		<div className="space-y-6">
			<div className="flex items-center gap-4">
				<p className="font-medium text-lg">Plan: {pro ? "Pro" : "Free"}</p>
				{pro ? (
					<Button onClick={onManage}>Manage Subscription</Button>
				) : (
					<Button onClick={onUpgrade}>Upgrade to Pro</Button>
				)}
			</div>
			<div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
				<a
					className="rounded-lg border p-4 transition-colors hover:bg-muted"
					href="/dashboard/certifications"
				>
					<p className="font-medium">Certifications</p>
					<p className="text-muted-foreground text-sm">
						View your certifications
					</p>
				</a>
			</div>
		</div>
	);
}
