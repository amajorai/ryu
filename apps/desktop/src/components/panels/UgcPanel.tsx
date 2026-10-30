// The workspace UGC panel: a creator-marketing campaign tracker driven entirely
// by the `@ryu/ugc` app's sidecar.
//
// This is a `panel: "native"` dock contribution (the `@ryu/browser` /
// `@ryu/simulator` precedent), not a sandboxed companion: a companion frame runs
// under CSP `connect-src 'none'` and could only reach the sidecar through per-app
// RPC verbs in Core, which is exactly the per-app coupling an apps-store satellite
// must not require. A native panel just fetches the sidecar's public mount.
//
// Data path: `/api/ugc/*` DIRECTLY. The app's manifest declares `http.public_mount`,
// so Core mounts the sidecar at that prefix and the longer `/api/ext/@ryu/ugc/*`
// form the Browser panel uses (its manifest declares no public mount) is not needed
// here. Every path below must also appear in the manifest's `http.routes[]` — Core's
// ext-proxy 404s an undeclared path before it ever reaches the sidecar.
//
// Money is integer cents on the wire and stays integer until `formatCents` divides
// once at the render edge. No currency arithmetic happens in floats.

import {
	Megaphone01Icon,
	RefreshIcon,
	Settings01Icon,
	UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRichLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@ryu/ui/components/tabs.tsx";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { useApps } from "@/src/hooks/useApps.ts";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";
import { CampaignsView } from "./ugc/campaigns-view.tsx";
import { NewCreatorDialog } from "./ugc/new-creator-submission-dialogs.tsx";
import { PayoutsView } from "./ugc/payouts-view.tsx";
import {
	formatCents,
	formatCount,
	readPlatformCatalog,
	UGC_PLUGIN_ID,
	useUgcCall,
} from "./ugc/ugc-format.ts";
import {
	type CreatorView as Creator,
	creatorViewSchema,
	type PlatformView as PlatformSource,
	readUgcList,
	type UgcOverview,
	ugcOverviewSchema,
} from "./ugc-wire-contracts.ts";

// ── Panel root ───────────────────────────────────────────────────────────────

/** The dock panel. Feature-detected against the app registry exactly as the
 *  Simulator panel is: with the app off there is no sidecar to talk to, so the
 *  panel says so instead of showing an unreachable-host error. */
export function UgcPanel() {
	const { apps } = useApps();
	const enabled = apps.some((a) => a.id === UGC_PLUGIN_ID && a.enabled);
	if (!enabled) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground text-xs">
				<HugeiconsIcon className="size-6 opacity-60" icon={Megaphone01Icon} />
				<p className="max-w-xs">
					Enable the <span className="font-medium">UGC</span> app to track
					creator campaigns, submissions and payouts from here.
				</p>
			</div>
		);
	}
	return <UgcWorkspace />;
}

const ugcViewSchema = z.enum(["campaigns", "payouts"]);
type UgcView = z.output<typeof ugcViewSchema>;

function UgcWorkspace() {
	const tlRich = useRichLiteralMessages();
	const call = useUgcCall();
	const openGateway = useGatewayDialog((state) => state.openGateway);
	const [view, setView] = useState<UgcView>("campaigns");
	const [revision, setRevision] = useState(0);
	const [addingCreator, setAddingCreator] = useState(false);
	const [creators, setCreators] = useState<Creator[]>([]);
	const [platforms, setPlatforms] = useState<PlatformSource[]>([]);
	const [composioConfigured, setComposioConfigured] = useState<boolean | null>(
		null
	);
	const [overview, setOverview] = useState<UgcOverview | null>(null);

	/** Anything that changes server state bumps this; every view re-reads. */
	const invalidate = useCallback(() => setRevision((r) => r + 1), []);

	useEffect(() => {
		let cancelled = false;
		const load = async () => {
			// The bare mount is the sidecar's cross-campaign rollup — the one read
			// that answers "what is the state of everything" without a campaign.
			const [overviewData, creatorData, platformData] = await Promise.all([
				call("").then(ugcOverviewSchema.parse),
				call("/creators"),
				call("/platforms"),
			]);
			if (cancelled) {
				return;
			}
			setOverview(overviewData);
			setCreators(readUgcList(creatorData, "creators", creatorViewSchema));
			const catalog = readPlatformCatalog(platformData);
			setPlatforms(catalog.platforms);
			setComposioConfigured(catalog.composioConfigured);
		};
		load().catch(() => {
			// The views below each surface their own fetch error; a failure here only
			// costs the rollup, display names and platform labels, so it must not
			// blank the panel.
			if (!cancelled) {
				setOverview(null);
				setCreators([]);
				setPlatforms([]);
				setComposioConfigured(null);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [call, revision]);

	const creatorName = useCallback(
		(id: string) =>
			creators.find((c) => c.id === id)?.display_name ?? id.slice(0, 8),
		[creators]
	);

	const platformLabel = useCallback(
		(platform: string) =>
			platforms.find((p) => p.platform === platform)?.label ?? platform,
		[platforms]
	);

	return (
		<Tabs
			className="flex h-full min-h-0 flex-col"
			onValueChange={(v) => setView(ugcViewSchema.parse(v))}
			value={view}
		>
			<header className="flex shrink-0 items-center gap-2 border-border border-b bg-sidebar px-2 py-1.5">
				<HugeiconsIcon
					className="size-3.5 shrink-0 text-muted-foreground"
					icon={Megaphone01Icon}
				/>
				<TabsList variant="pills">
					<TabsTrigger value="campaigns">Campaigns</TabsTrigger>
					<TabsTrigger value="payouts">Payouts</TabsTrigger>
				</TabsList>
				<span className="flex-1" />
				{overview ? (
					<span className="hidden truncate text-muted-foreground text-xs tabular-nums sm:inline">
						{tlRich(
							"{campaigns} campaigns · {creators} creators · {pending} pending · <mono>{accrued}</mono> accrued · <mono>{paid}</mono> paid",
							{
								accrued: formatCents(overview.accrued_cents),
								campaigns: formatCount(overview.campaigns),
								creators: formatCount(overview.creators),
								paid: formatCents(overview.paid_cents),
								pending: formatCount(overview.submissions.pending),
							},
							{
								mono: (chunks) => <span className="font-mono">{chunks}</span>,
							}
						)}
					</span>
				) : null}
				{/* The roster is the entry point of the whole flow — a submission binds a
				    creator to a campaign, so with an empty roster nothing can be
				    recorded and nothing ever accrues. It lives in the workspace header
				    rather than inside the submission dialog because the roster spans
				    campaigns and both tabs render creator names from it. */}
				<Button
					onClick={() => setAddingCreator(true)}
					size="xs"
					title="Add a creator to the roster"
					type="button"
					variant="ghost"
				>
					<HugeiconsIcon icon={UserGroupIcon} />
					Add creator
				</Button>
				<Button
					onClick={invalidate}
					size="xs"
					title="Reload from the sidecar"
					type="button"
					variant="ghost"
				>
					<HugeiconsIcon icon={RefreshIcon} />
					Reload
				</Button>
				{/* Composio credentials are owned by Gateway. Keep a direct path to the
				    existing node-level key settings; the UGC sidecar has no key route. */}
				<Button
					onClick={() => openGateway("keys")}
					size="icon-sm"
					title="Composio settings in Gateway → Keys"
					type="button"
					variant="ghost"
				>
					<HugeiconsIcon icon={Settings01Icon} />
					<span className="sr-only">Composio settings in Gateway → Keys</span>
				</Button>
			</header>
			<NewCreatorDialog
				onCreated={invalidate}
				onOpenChange={setAddingCreator}
				open={addingCreator}
			/>
			<TabsContent className="flex min-h-0 flex-1 flex-col" value="campaigns">
				<CampaignsView
					composioConfigured={composioConfigured}
					creatorName={creatorName}
					creators={creators}
					invalidate={invalidate}
					onOpenGatewayKeys={() => openGateway("keys")}
					platformLabel={platformLabel}
					platforms={platforms}
					revision={revision}
				/>
			</TabsContent>
			<TabsContent className="flex min-h-0 flex-1 flex-col" value="payouts">
				<PayoutsView
					creatorName={creatorName}
					invalidate={invalidate}
					revision={revision}
				/>
			</TabsContent>
		</Tabs>
	);
}
