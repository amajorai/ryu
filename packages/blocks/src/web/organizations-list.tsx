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
import {
	Building2,
	Check,
	ChevronRight,
	KeyRound,
	ShieldCheck,
} from "lucide-react";
import type { ReactNode } from "react";

const noop = () => {
	// presentational default; the live app injects real handlers
};

export interface OrganizationSummary {
	id: string;
	name: string;
	slug?: string | null;
}

export interface OrganizationsListProps {
	activeOrganizationId?: string | null;
	isPending?: boolean;
	onSetActive?: (organizationId: string) => void;
	organizations?: OrganizationSummary[];
	/**
	 * Renders the per-org navigation actions (Policies / Gateway keys / Config /
	 * Dashboard / Manage). The live page renders Next.js `<Link>`-backed buttons;
	 * the storyboard renders plain buttons. Defaults to plain links.
	 */
	renderOrgActions?: (org: OrganizationSummary) => ReactNode;
}

function DefaultOrgActions() {
	const links = [
		{ label: "Policies", icon: <ShieldCheck className="h-4 w-4" /> },
		{ label: "Gateway keys", icon: <KeyRound className="h-4 w-4" /> },
		{ label: "Config", icon: null },
		{ label: "Dashboard", icon: null },
	];
	return (
		<>
			{links.map((link) => (
				<Button key={link.label} size="sm" variant="ghost">
					{link.icon}
					{link.label}
				</Button>
			))}
			<Button size="sm" variant="ghost">
				Manage
				<ChevronRight className="h-4 w-4" />
			</Button>
		</>
	);
}

/**
 * The real organizations switcher list, presentational. The live page
 * (apps/web/src/app/organizations/page.tsx) owns the authClient hooks and passes
 * the resolved list, the active id, and Link-backed per-org actions; the
 * storyboard renders it with static data and default plain-button actions.
 */
export default function OrganizationsList({
	organizations = [],
	activeOrganizationId = null,
	isPending = false,
	onSetActive = noop,
	renderOrgActions,
}: OrganizationsListProps) {
	const isEmpty = !organizations || organizations.length === 0;

	return (
		<div className="mx-auto w-full max-w-3xl">
			<div className="mb-8">
				<h1 className="font-bold text-2xl">Your organizations</h1>
				<p className="text-muted-foreground text-sm">
					Switch between organizations or create a new one from the switcher
					above.
				</p>
			</div>

			{isPending && (
				<div className="grid gap-3">
					<Skeleton className="h-20 w-full" />
					<Skeleton className="h-20 w-full" />
				</div>
			)}

			{!isPending && isEmpty && (
				<Card>
					<CardHeader>
						<CardTitle>No organizations yet</CardTitle>
						<CardDescription>
							Create your first organization using the switcher in the header.
							You will become its owner.
						</CardDescription>
					</CardHeader>
				</Card>
			)}

			{!(isPending || isEmpty) && (
				<div className="grid gap-3">
					{organizations.map((org) => {
						const isActive = activeOrganizationId === org.id;
						return (
							<Card key={org.id}>
								<CardContent className="flex items-center justify-between gap-4 py-4">
									<div className="flex items-center gap-3">
										<span className="flex h-10 w-10 items-center justify-center rounded-md bg-muted">
											<Building2 className="h-5 w-5" />
										</span>
										<div>
											<p className="font-medium">{org.name}</p>
											<p className="text-muted-foreground text-xs">
												{org.slug}
											</p>
										</div>
									</div>
									<div className="flex items-center gap-2">
										{isActive ? (
											<span className="flex items-center gap-1 text-muted-foreground text-sm">
												<Check className="h-4 w-4" />
												Active
											</span>
										) : (
											<Button
												onClick={() => onSetActive(org.id)}
												size="sm"
												variant="outline"
											>
												Set active
											</Button>
										)}
										{renderOrgActions ? (
											renderOrgActions(org)
										) : (
											<DefaultOrgActions />
										)}
									</div>
								</CardContent>
							</Card>
						);
					})}
				</div>
			)}
		</div>
	);
}
