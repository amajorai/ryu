"use client";

import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import { Skeleton } from "@ryu/ui/components/skeleton";
import { Building2, Check, X } from "lucide-react";

const noop = () => {
	// presentational default; the live app injects real handlers
};

export interface InvitationDetails {
	email?: string | null;
	inviterEmail?: string | null;
	organizationName?: string | null;
	organizationSlug?: string | null;
	role?: string | null;
	status?: string | null;
}

export interface AcceptInvitationProps {
	error?: string | null;
	invitation?: InvitationDetails | null;
	loading?: boolean;
	onAccept?: () => void;
	onReject?: () => void;
	onRetry?: () => void;
	working?: "accept" | "reject" | null;
}

/**
 * The real organization-invitation card, presentational. The live page
 * (apps/web/src/app/organizations/accept-invitation/[invitationId]/page.tsx)
 * owns the authClient calls and routing; it passes the resolved invitation +
 * handlers. The storyboard renders it with static invitation data.
 */
export default function AcceptInvitation({
	invitation = null,
	loading = false,
	error = null,
	working = null,
	onAccept = noop,
	onReject = noop,
	onRetry = noop,
}: AcceptInvitationProps) {
	return (
		<div className="mx-auto flex w-full max-w-md justify-center py-12">
			<Card className="w-full">
				<CardHeader>
					<span className="mb-2 flex h-11 w-11 items-center justify-center rounded-md bg-muted">
						<Building2 className="h-6 w-6" />
					</span>
					<CardTitle>Organization invitation</CardTitle>
					<CardDescription>
						{loading
							? "Loading the invitation..."
							: invitation?.organizationName
								? `You've been invited to join ${invitation.organizationName}.`
								: "Review and respond to this invitation."}
					</CardDescription>
				</CardHeader>

				<CardContent className="space-y-3">
					{loading && (
						<div className="space-y-2">
							<Skeleton className="h-5 w-3/4" />
							<Skeleton className="h-5 w-1/2" />
						</div>
					)}

					{!loading && error && (
						<p className="text-destructive text-sm">{error}</p>
					)}

					{!(loading || error) && invitation && (
						<dl className="space-y-2 text-sm">
							{invitation.inviterEmail && (
								<div className="flex items-center justify-between gap-4">
									<dt className="text-muted-foreground">Invited by</dt>
									<dd className="font-medium">{invitation.inviterEmail}</dd>
								</div>
							)}
							{invitation.role && (
								<div className="flex items-center justify-between gap-4">
									<dt className="text-muted-foreground">Role</dt>
									<dd>
										<Badge variant="secondary">{invitation.role}</Badge>
									</dd>
								</div>
							)}
							{invitation.status && invitation.status !== "pending" && (
								<div className="flex items-center justify-between gap-4">
									<dt className="text-muted-foreground">Status</dt>
									<dd>
										<Badge variant="outline">{invitation.status}</Badge>
									</dd>
								</div>
							)}
						</dl>
					)}
				</CardContent>

				<CardFooter className="flex justify-end gap-2">
					{error && !invitation ? (
						<Button onClick={onRetry} variant="outline">
							Retry
						</Button>
					) : (
						<>
							<Button
								disabled={loading || working !== null}
								onClick={onReject}
								variant="outline"
							>
								<X className="h-4 w-4" />
								{working === "reject" ? "Declining..." : "Decline"}
							</Button>
							<Button disabled={loading || working !== null} onClick={onAccept}>
								<Check className="h-4 w-4" />
								{working === "accept" ? "Accepting..." : "Accept invitation"}
							</Button>
						</>
					)}
				</CardFooter>
			</Card>
		</div>
	);
}
