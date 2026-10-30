import {
	CheckmarkCircle02Icon,
	Download01Icon,
	ServerStack01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { InstallProgressButton } from "@ryu/blocks/desktop/install-button.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	ListingAsideCard,
	ListingDetailShell,
	ListingHero,
	ListingInfoGrid,
	ListingSection,
	type ListingStat,
	ListingStatStrip,
} from "@ryu/marketplace/catalog/detail/listing-detail-shell";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { DitherAvatar } from "@ryu/ui/components/dither-kit/avatar.tsx";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import type { McpCatalogDetail } from "@/src/lib/api/mcp.ts";
import { useInstallProgress } from "@/src/store/useDownloadsStore.ts";

export function McpDetailPanel({
	selectedId,
	detail,
	loading,
	error,
	install,
	installing,
}: {
	selectedId: string | null;
	detail: McpCatalogDetail | null;
	loading: boolean;
	error: string | null;
	install: () => Promise<void>;
	installing: string | null;
}) {
	const tl = useLiteralMessages();
	if (!selectedId) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={ServerStack01Icon} />
					</EmptyMedia>
					<EmptyTitle>No server selected</EmptyTitle>
					<EmptyDescription>
						Pick an MCP server on the left to review what it launches before
						adding it.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}
	if (loading && !detail) {
		return <SkeletonRows rows={6} spacing="library" />;
	}
	if (error) {
		return (
			<div className="p-4 text-sm text-status-destructive">
				{tl("Couldn't load this server: {error}", { error })}
			</div>
		);
	}
	if (!detail) {
		return null;
	}

	const { card, packages, remotes } = detail;
	const isInstalling = installing === card.id;
	const { percent } = useInstallProgress(["tool", "other"], card.name);

	const transports = Array.from(
		new Set(
			[
				...packages.map((p) => p.transport),
				...remotes.map((r) => r.transportType),
			].filter((t): t is string => Boolean(t))
		)
	);

	const statItems: (ListingStat | null)[] = [
		card.version ? { label: "Version", value: `v${card.version}` } : null,
		packages.length > 0
			? { label: "Packages", value: formatCount(packages.length) ?? "—" }
			: null,
		remotes.length > 0
			? { label: "Remotes", value: formatCount(remotes.length) ?? "—" }
			: null,
		transports.length > 0
			? { label: "Transport", value: transports.join(", ") }
			: null,
		{ label: "Registry", value: "MCP Registry" },
	];

	return (
		<ListingDetailShell
			actions={
				<>
					{card.installed ? (
						<Badge variant="secondary">
							<HugeiconsIcon
								className="size-3.5 text-status-success"
								icon={CheckmarkCircle02Icon}
							/>
							Added
						</Badge>
					) : (
						<InstallProgressButton
							installing={isInstalling}
							onClick={() => {
								install().catch(() => undefined);
							}}
							percent={percent}
						>
							<HugeiconsIcon className="size-4" icon={Download01Icon} />
							Add server
						</InstallProgressButton>
					)}
					{card.installed ? (
						<span className="ml-auto text-muted-foreground text-xs">
							Added to your MCP servers (disabled). Enable and start it from the
							Tools page — Ryu never auto-launches a registry command.
						</span>
					) : null}
				</>
			}
			aside={
				<ListingAsideCard title="Information">
					<ListingInfoGrid
						rows={[
							{ label: "Server ID", value: card.id },
							{ label: "Version", value: card.version ?? "Unversioned" },
							{
								label: "Launchable",
								value:
									packages.length + remotes.length > 0 ? "Yes" : "No target",
							},
						]}
					/>
				</ListingAsideCard>
			}
			hero={
				<ListingHero
					badges={[card.installed ? "Added" : null, ...transports].filter(
						(b): b is string => Boolean(b)
					)}
					icon={
						// Registry servers ship no art, so the tile is the generative one
						// keyed on the server id — the same rule the Apps hero uses for an
						// artless listing.
						<DitherAvatar
							animate={false}
							className="size-full"
							name={card.id}
						/>
					}
					name={card.name}
					tagline={card.description}
				/>
			}
			stats={
				<ListingStatStrip
					items={statItems.filter((s): s is ListingStat => s !== null)}
				/>
			}
		>
			{packages.length > 0 && (
				<ListingSection
					title={tl("Packages ({count})", {
						count: formatCount(packages.length) ?? "—",
					})}
				>
					{/* Two-up on a wide dialog: a launch target is a short line, and one
					    per full-width row was a column of mostly-empty cards. */}
					<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
						{packages.map((p) => (
							<div
								className="rounded-lg border border-border px-3 py-2"
								key={`${p.registryType}:${p.identifier}:${p.version}`}
							>
								<div className="flex items-center gap-2">
									{p.registryType && (
										<Badge size="compact" variant="secondary">
											{p.registryType}
										</Badge>
									)}
									{p.transport && (
										<Badge size="compact" variant="outline">
											{p.transport}
										</Badge>
									)}
								</div>
								<div className="mt-1 truncate font-mono text-sm">
									{p.identifier ?? "—"}
									{p.version ? `@${p.version}` : ""}
								</div>
							</div>
						))}
					</div>
				</ListingSection>
			)}

			{remotes.length > 0 && (
				<ListingSection
					title={tl("Remotes ({count})", {
						count: formatCount(remotes.length) ?? "—",
					})}
				>
					<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
						{remotes.map((r) => (
							<div
								className="rounded-lg border border-border px-3 py-2"
								key={`${r.transportType}:${r.url}`}
							>
								{r.transportType && (
									<Badge size="compact" variant="secondary">
										{r.transportType}
									</Badge>
								)}
								<div className="mt-1 break-all font-mono text-sm">
									{r.url ?? "—"}
								</div>
							</div>
						))}
					</div>
				</ListingSection>
			)}

			{packages.length === 0 && remotes.length === 0 && (
				<p className="text-muted-foreground text-sm">
					This server advertises no launchable package or remote endpoint.
				</p>
			)}
		</ListingDetailShell>
	);
}
