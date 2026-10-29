"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import { Skeleton } from "@ryu/ui/components/skeleton";
import { Users, X } from "lucide-react";
import type { ReactNode } from "react";

const noop = () => {
	// presentational default; the live app injects real handlers
};

export interface TeamMemberRow {
	id: string;
	label: string;
	userId: string;
}

export interface TeamCardViewProps {
	/** Add-member row (Select + Add button); the live page injects the data-bound widget. */
	addMemberSlot?: ReactNode;
	busy?: boolean;
	canManage?: boolean;
	error?: string | null;
	/** Header rename/delete controls; the live page injects its rename dialog + delete button. */
	headerActions?: ReactNode;
	/** Header navigation shown to every viewer (e.g. a link to the team's policies). */
	headerLinks?: ReactNode;
	loadingMembers?: boolean;
	members?: TeamMemberRow[];
	name: string;
	onRemoveMember?: (userId: string) => void;
	onRetryMembers?: () => void;
}

/**
 * The real team card body, presentational. The live page
 * (apps/web/src/app/organizations/teams/page.tsx) owns the member-loading hooks
 * and the add/remove mutations; it resolves member labels and passes the
 * add-member widget + rename/delete controls as slots. The storyboard renders it
 * with a static member list.
 */
export function TeamCardView({
	name,
	members = [],
	loadingMembers = false,
	error = null,
	canManage = false,
	busy = false,
	onRemoveMember = noop,
	onRetryMembers,
	headerActions,
	headerLinks,
	addMemberSlot,
}: TeamCardViewProps) {
	const tl = useLiteralMessages();
	return (
		<Card aria-label={tl("{teamName} team", { teamName: name })} role="region">
			<CardHeader layout="summary">
				<CardTitle layout="badge-row" variant="default">
					<Users className="h-4 w-4" /> {name}
				</CardTitle>
				{headerLinks || (canManage && headerActions) ? (
					<div className="flex items-center gap-1">
						{headerLinks}
						{canManage && headerActions}
					</div>
				) : null}
			</CardHeader>
			<CardContent spacing="relaxed">
				{error && (
					<div className="flex flex-wrap items-center justify-between gap-2">
						<p className="text-sm text-status-destructive" role="alert">
							{error}
						</p>
						{onRetryMembers && (
							<Button onClick={onRetryMembers} size="sm" variant="outline">
								Retry loading members
							</Button>
						)}
					</div>
				)}

				{loadingMembers ? (
					<Skeleton className="h-10 w-full" />
				) : (
					<ul className="space-y-1">
						{members.length === 0 && (
							<li className="text-muted-foreground text-sm">
								No members in this team yet.
							</li>
						)}
						{members.map((member) => (
							<li
								className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
								key={member.id}
							>
								<span>{member.label}</span>
								{canManage && (
									<Button
										aria-label="Remove from team"
										disabled={busy}
										onClick={() => onRemoveMember(member.userId)}
										size="icon"
										variant="ghost"
									>
										<X className="h-4 w-4" />
									</Button>
								)}
							</li>
						))}
					</ul>
				)}

				{canManage && addMemberSlot}
			</CardContent>
		</Card>
	);
}

export interface TeamsLayoutProps {
	/** Active-team selector; the live app injects the Better Auth control. */
	activeTeamSlot?: ReactNode;
	canManage?: boolean;
	children?: ReactNode;
	/** Create-team control; the live page injects its create dialog. */
	createTeamSlot?: ReactNode;
	error?: string | null;
	isEmpty?: boolean;
	loading?: boolean;
	noActiveOrg?: boolean;
	onRetry?: () => void;
	organizationName?: string;
}

/**
 * The real teams page chrome (header, states, list container), presentational.
 * The live page passes the active-org name, role-derived `canManage`, the
 * create-team dialog, and the rendered team cards as children.
 */
export function TeamsLayout({
	activeTeamSlot,
	organizationName,
	canManage = false,
	loading = false,
	error = null,
	isEmpty = false,
	noActiveOrg = false,
	createTeamSlot,
	children,
	onRetry,
}: TeamsLayoutProps) {
	const tl = useLiteralMessages();
	if (noActiveOrg) {
		return (
			<div className="mx-auto w-full max-w-4xl">
				<Card>
					<CardHeader>
						<CardTitle>No active organization</CardTitle>
						<CardDescription>
							Select or create an organization from the switcher above to manage
							its teams.
						</CardDescription>
					</CardHeader>
				</Card>
			</div>
		);
	}

	return (
		<div className="mx-auto flex w-full max-w-4xl flex-col gap-8">
			<div className="flex flex-wrap items-center justify-between gap-4">
				<div>
					<h1 className="font-medium text-2xl">Teams</h1>
					<p className="text-muted-foreground text-sm">
						{organizationName === undefined
							? "Group members of your organization into teams."
							: tl("Group members of {organizationName} into teams.", {
									organizationName,
								})}
					</p>
				</div>
				{canManage && createTeamSlot}
			</div>

			{activeTeamSlot ? (
				<div className="rounded-2xl border border-border/70 bg-card p-4">
					{activeTeamSlot}
				</div>
			) : null}

			{error && (
				<div
					className="flex flex-wrap items-center justify-between gap-2"
					role="alert"
				>
					<p className="text-sm text-status-destructive">{error}</p>
					{onRetry && (
						<Button onClick={onRetry} size="sm" variant="outline">
							Reload teams
						</Button>
					)}
				</div>
			)}

			{loading && (
				<div className="grid gap-3">
					<Skeleton className="h-28 w-full" />
					<Skeleton className="h-28 w-full" />
				</div>
			)}

			{!loading && isEmpty && (
				<Card>
					<CardHeader>
						<CardTitle>No teams yet</CardTitle>
						<CardDescription>
							{canManage
								? "Create your first team to start grouping members."
								: "An admin has not created any teams yet."}
						</CardDescription>
					</CardHeader>
				</Card>
			)}

			{!loading && children}
		</div>
	);
}
