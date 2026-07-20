"use client";

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
	loadingMembers?: boolean;
	members?: TeamMemberRow[];
	name: string;
	onRemoveMember?: (userId: string) => void;
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
	headerActions,
	addMemberSlot,
}: TeamCardViewProps) {
	return (
		<Card>
			<CardHeader className="flex flex-row items-start justify-between gap-4">
				<CardTitle className="flex items-center gap-2 text-base">
					<Users className="h-4 w-4" /> {name}
				</CardTitle>
				{canManage && headerActions}
			</CardHeader>
			<CardContent className="space-y-4">
				{error && <p className="text-destructive text-sm">{error}</p>}

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
	canManage?: boolean;
	children?: ReactNode;
	/** Create-team control; the live page injects its create dialog. */
	createTeamSlot?: ReactNode;
	error?: string | null;
	isEmpty?: boolean;
	loading?: boolean;
	noActiveOrg?: boolean;
	organizationName?: string;
}

/**
 * The real teams page chrome (header, states, list container), presentational.
 * The live page passes the active-org name, role-derived `canManage`, the
 * create-team dialog, and the rendered team cards as children.
 */
export function TeamsLayout({
	organizationName,
	canManage = false,
	loading = false,
	error = null,
	isEmpty = false,
	noActiveOrg = false,
	createTeamSlot,
	children,
}: TeamsLayoutProps) {
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
					<h1 className="font-bold text-2xl">Teams</h1>
					<p className="text-muted-foreground text-sm">
						Group members of {organizationName ?? "your organization"} into
						teams.
					</p>
				</div>
				{canManage && createTeamSlot}
			</div>

			{error && <p className="text-destructive text-sm">{error}</p>}

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
