import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useEffect, useState } from "react";
import {
	type CampaignView as Campaign,
	type CreatorView as Creator,
	campaignViewSchema,
	type PlatformView as PlatformSource,
	readUgcList,
} from "../ugc-wire-contracts.ts";
import { CampaignDetail } from "./campaign-detail.tsx";
import { NewCampaignDialog } from "./new-campaign-dialog.tsx";
import {
	CAMPAIGN_STATUS_VARIANT,
	describeError,
	formatCents,
	useUgcCall,
} from "./ugc-format.ts";
import {
	ErrorBanner,
	LoadingRow,
	PanelNotice,
	StatusPill,
} from "./ugc-primitives.tsx";

// ── Campaigns ────────────────────────────────────────────────────────────────

const CAMPAIGN_STATUS_FILTERS: Array<{ label: string; value: string }> = [
	{ label: "All statuses", value: "" },
	{ label: "Draft", value: "draft" },
	{ label: "Active", value: "active" },
	{ label: "Paused", value: "paused" },
	{ label: "Ended", value: "ended" },
];

export function CampaignsView({
	composioConfigured,
	creatorName,
	creators,
	invalidate,
	onOpenGatewayKeys,
	platformLabel,
	platforms,
	revision,
}: {
	composioConfigured: boolean | null;
	creatorName: (id: string) => string;
	creators: Creator[];
	invalidate: () => void;
	onOpenGatewayKeys: () => void;
	platformLabel: (platform: string) => string;
	platforms: PlatformSource[];
	revision: number;
}) {
	const call = useUgcCall();
	const [campaigns, setCampaigns] = useState<Campaign[]>([]);
	const [statusFilter, setStatusFilter] = useState("");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		const query = statusFilter ? `?status=${statusFilter}` : "";
		call(`/campaigns${query}`)
			.then((data) => {
				if (cancelled) {
					return;
				}
				const rows = readUgcList(data, "campaigns", campaignViewSchema);
				setCampaigns(rows);
				setError(null);
				setSelectedId((prev) =>
					prev && rows.some((c) => c.id === prev) ? prev : (rows[0]?.id ?? null)
				);
			})
			.catch((err) => {
				if (!cancelled) {
					setCampaigns([]);
					setError(describeError(err));
				}
			})
			.finally(() => {
				if (!cancelled) {
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [call, statusFilter, revision]);

	const selected = campaigns.find((c) => c.id === selectedId) ?? null;

	return (
		<div className="flex min-h-0 flex-1">
			<aside className="flex w-64 shrink-0 flex-col border-border border-r">
				<div className="flex shrink-0 items-center gap-1.5 border-border border-b px-2 py-1.5">
					<NativeSelect
						aria-label="Filter campaigns by status"
						className="w-full"
						onChange={(e) => setStatusFilter(e.target.value)}
						size="sm"
						value={statusFilter}
					>
						{CAMPAIGN_STATUS_FILTERS.map((opt) => (
							<NativeSelectOption key={opt.value} value={opt.value}>
								{opt.label}
							</NativeSelectOption>
						))}
					</NativeSelect>
					<Button
						onClick={() => setCreating(true)}
						size="icon-sm"
						title="New campaign"
						type="button"
						variant="ghost"
					>
						<HugeiconsIcon icon={PlusSignIcon} />
						<span className="sr-only">New campaign</span>
					</Button>
				</div>
				<div className="scroll-fade min-h-0 flex-1 overflow-y-auto">
					{loading && campaigns.length === 0 ? <LoadingRow /> : null}
					{error ? (
						<div className="p-2">
							<ErrorBanner message={error} />
						</div>
					) : null}
					{!(loading || error) && campaigns.length === 0 ? (
						<PanelNotice>
							No campaigns yet. Create one to start tracking submissions.
						</PanelNotice>
					) : null}
					<ul>
						{campaigns.map((campaign) => (
							<li key={campaign.id}>
								<button
									className={cn(
										"w-full border-border border-b px-2.5 py-2 text-left",
										campaign.id === selectedId
											? "bg-accent"
											: "hover:bg-muted/50"
									)}
									onClick={() => setSelectedId(campaign.id)}
									type="button"
								>
									<span className="flex items-center gap-1.5">
										<span className="min-w-0 flex-1 truncate font-medium text-xs">
											{campaign.brand || "Untitled campaign"}
										</span>
										<StatusPill
											label={campaign.status}
											variant={
												CAMPAIGN_STATUS_VARIANT[campaign.status] ?? "outline"
											}
										/>
									</span>
									<span className="mt-1 block text-muted-foreground text-xs">
										{campaign.budget_cents > 0 ? (
											<>
												Budget{" "}
												<span className="font-mono tabular-nums">
													{formatCents(campaign.budget_cents)}
												</span>
											</>
										) : (
											"No budget cap"
										)}
									</span>
								</button>
							</li>
						))}
					</ul>
				</div>
			</aside>
			<div className="scroll-fade min-w-0 flex-1 overflow-y-auto">
				{selected ? (
					<CampaignDetail
						campaign={selected}
						composioConfigured={composioConfigured}
						creatorName={creatorName}
						creators={creators}
						invalidate={invalidate}
						onOpenGatewayKeys={onOpenGatewayKeys}
						platformLabel={platformLabel}
						platforms={platforms}
						revision={revision}
					/>
				) : (
					<div className="flex h-full items-center justify-center p-6 text-center text-muted-foreground text-xs">
						Select a campaign to see its submissions, leaderboard and spend.
					</div>
				)}
			</div>
			<NewCampaignDialog
				onCreated={invalidate}
				onOpenChange={setCreating}
				open={creating}
				platforms={platforms}
			/>
		</div>
	);
}
