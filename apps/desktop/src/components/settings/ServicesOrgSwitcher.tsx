import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
// The `.tsx` extension is required: `@ryu/ui` resolves through an `exports`
// wildcard that is matched literally, so an extensionless specifier resolves to
// nothing. See the header of `entity-avatar.tsx`.
import { EntityAvatar } from "@ryu/ui/components/entity-avatar.tsx";
import { PlanBadge } from "@ryu/ui/components/plan-badge.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronsUpDown } from "lucide-react";
import { getActiveUserId, useSession } from "@/lib/auth-client.ts";
import { useOrgBillingStatus } from "@/src/hooks/useOrgBillingStatus.ts";
import {
	activeOrgQueryKey,
	hasOrgAuth,
	listOrgs,
	type OrgListEntry,
	setActiveOrg,
	useActiveOrgId,
} from "@/src/lib/api/orgs.ts";
import { queryClient as appQueryClient } from "@/src/lib/query-client.ts";

/**
 * The workspace picker that sits at the top of the settings dialog's SERVICES
 * group, directly above Billing.
 *
 * WHY IT IS HERE AND NOT IN THE TABS. Billing, Referrals, Teams and Credits are
 * all ORG-SCOPED — each resolves its org from the session's active organization
 * — but not one of them printed WHICH org it was showing. A user in two
 * workspaces read four screens of numbers with no way to tell whose they were,
 * and no way to change it without leaving for the web dashboard. Putting the
 * control at the head of the group makes the scope a property of the whole
 * section rather than a fact each tab would have to repeat (and could disagree
 * about).
 *
 * SWITCHING IS A SERVER MUTATION, not local state: `set-active` rewrites
 * `activeOrganizationId` on the session row that every org-scoped route already
 * reads. That is also why the whole query cache is dropped afterwards rather
 * than a hand-picked list of keys invalidated — the switch changes the meaning
 * of every org-scoped response in flight, and enumerating them here would leave
 * the next org-scoped tab someone adds silently stale.
 *
 * BOTH CACHES, not one. The blanket invalidation used to run only against the
 * ambient client, which inside this dialog is the ISOLATED `new QueryClient()`
 * that `SettingsDialog.tsx` creates. The gateway dialog is mounted outside that
 * provider, so its workspace roster and its `gateway.configure` gate read the
 * app-wide client and stayed scoped to the previous org INDEFINITELY, not for a
 * paint. Dropping both is the only version of "everything org-scoped" that is
 * actually everything.
 *
 * Neither drop can reach the surfaces that are not queries at all — the wallet
 * balance, the auto-recharge and low-balance cards are plain state behind an
 * effect. Those re-run because `useActiveOrgId()` is one of their effect
 * dependencies, and its key is dropped here like any other. Every one of them
 * CLEARS to its empty state before it reloads, which is the rule the whole
 * change turns on: an org-scoped surface may show this org's data or nothing,
 * never the last org's while the new one is in flight.
 *
 * WHY THE ORDER BELOW. The active-org id is re-read and AWAITED before anything
 * else is touched, because it is the key half of every org-keyed query here. An
 * invalidation that runs while those queries are still mounted under the
 * PREVIOUS org's id refetches them under that id and stores the new org's answer
 * there — so switching back a minute later is served the wrong org's numbers
 * from cache, which is the exact flash the keys were added to remove.
 */

const ORGS_KEY = ["settings", "orgs"] as const;

export function ServicesOrgSwitcher() {
	const queryClient = useQueryClient();
	const authed = hasOrgAuth();
	const { data: session } = useSession();
	const activeOrgId = useActiveOrgId();
	const { activeOrgId: billingOrgId, plan: billingPlan } =
		useOrgBillingStatus();

	const orgsQuery = useQuery({
		enabled: authed,
		queryFn: listOrgs,
		queryKey: ORGS_KEY,
	});

	const switchMutation = useMutation({
		mutationFn: setActiveOrg,
		onError: (error) =>
			toast.error({
				title:
					error instanceof Error ? error.message : "Couldn't switch workspace",
			}),
		onSuccess: async () => {
			// 1. WHICH org, first and on its own. Until this lands, every org-keyed
			//    query in the dialog is still mounted under the previous org's id.
			//    Only THIS account's entry: another account's entry would be
			//    looked up with this account's session token.
			await appQueryClient
				.refetchQueries({
					exact: true,
					queryKey: activeOrgQueryKey(getActiveUserId()),
				})
				.catch(() => undefined);

			// 2. Everything org-scoped is now about a different org. See the note
			//    above on why this is a blanket invalidation, and why it is two of
			//    them. Only the DIALOG's client is awaited: the spinner on this
			//    trigger is a promise about the tabs directly below it, and the
			//    app-wide client backs the whole shell — catalogs, model lists, node
			//    reads — so awaiting it would hold the switcher disabled until the
			//    slowest unrelated query in the app resolved.
			appQueryClient.invalidateQueries().catch(() => undefined);
			await queryClient.invalidateQueries();

			// 3. Sweep what the switch left behind: the entries left under the
			//    PREVIOUS org's key once the tabs re-keyed onto the new one. Nothing
			//    observes them, so nothing on screen changes — but they survive the
			//    default 5-minute gcTime, and a switch BACK inside that window would
			//    be served from them. Restricted to `inactive` for that reason (a
			//    live query must reload, not disappear) and to the DIALOG's client,
			//    whose org-keyed queries are the ones the switch strands; anything
			//    else swept here is a settings tab nobody has open, which costs one
			//    refetch when it is next opened. Safe here and not earlier: the
			//    awaited invalidation above has settled, so no refetch is still in
			//    flight that could repopulate a stale key behind the sweep.
			queryClient.removeQueries({ type: "inactive" });
		},
	});

	const orgs = orgsQuery.data ?? [];
	if (!authed || orgs.length === 0) {
		return null;
	}

	// The server's own fallback, mirrored: a session with no active org resolves
	// to the EARLIEST membership. Showing "Select…" instead would imply the tabs
	// below are unscoped, when they are already reading that org's numbers.
	const activeId = activeOrgId ?? orgs[0]?.id ?? null;
	const active = orgs.find((org) => org.id === activeId) ?? orgs[0];

	// The web dashboard's own rule, mirrored rather than re-invented (see
	// `apps/web/src/components/organizations/org-switcher.tsx`): a personal
	// workspace IS the user, so it wears the user's own avatar; a real org wears
	// its uploaded logo; and anything without one falls back to the generative
	// dither avatar seeded by ID, so renaming an org does not change its picture.
	// The point of routing through `EntityAvatar` at all is that fallback — the
	// stock building glyph this replaced was identical for every workspace, which
	// is the one thing a workspace picker must not be.
	//
	// `?? org.logo` in the personal branch is insurance against the one hole
	// `resolvePersonalOrgId` documents: a user invited into a company org BEFORE
	// they ever signed in has no personal org, so their earliest membership — and
	// therefore their `isPersonal` — is that company. Falling through to the logo
	// means a misclassification degrades to showing the company's real picture
	// rather than suppressing it in favour of a personal avatar.
	const avatarFor = (org: OrgListEntry) =>
		org.isPersonal
			? {
					seed: session?.user?.id ?? org.id,
					src: session?.user?.image ?? org.logo,
				}
			: { seed: org.id, src: org.logo };

	return (
		<div className="px-2 pb-1">
			<DropdownMenu>
				<DropdownMenuTrigger
					disabled={switchMutation.isPending || orgs.length < 2}
					variant="organization-picker"
				>
					{active ? (
						<EntityAvatar
							className="size-4 shrink-0"
							name={active.name}
							size="sm"
							{...avatarFor(active)}
						/>
					) : null}
					<span className="min-w-0 flex-1 truncate">
						{active?.name ?? "Workspace"}
					</span>
					{active?.id === billingOrgId ? (
						<PlanBadge plan={billingPlan} size="sm" />
					) : null}
					{switchMutation.isPending ? (
						<Spinner className="size-3.5 shrink-0" />
					) : orgs.length > 1 ? (
						<ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
					) : null}
				</DropdownMenuTrigger>
				{orgs.length > 1 ? (
					<DropdownMenuContent align="start" className="w-64">
						{orgs.map((org) => (
							<DropdownMenuItem
								key={org.id}
								onClick={() => {
									if (org.id !== activeId) {
										switchMutation.mutate(org.id);
									}
								}}
							>
								{/* The role is the fact that decides what the tabs below will let
							    this person DO — an org they are a plain member of shows the
							    same billing screen with every control disabled — so it is
							    worth the line it costs. */}
								<span className="mr-1 flex size-4 shrink-0 items-center justify-center">
									{org.id === activeId ? <Check className="size-3.5" /> : null}
								</span>
								<EntityAvatar
									className="size-4 shrink-0"
									name={org.name}
									size="sm"
									{...avatarFor(org)}
								/>
								<span className="min-w-0 flex-1 truncate" title={org.name}>
									{org.name}
								</span>
								{org.id === billingOrgId ? (
									<PlanBadge plan={billingPlan} size="sm" />
								) : null}
								{org.role ? (
									<span className="ml-2 shrink-0 text-muted-foreground text-xs">
										{org.role}
									</span>
								) : null}
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				) : null}
			</DropdownMenu>
		</div>
	);
}

export default ServicesOrgSwitcher;
