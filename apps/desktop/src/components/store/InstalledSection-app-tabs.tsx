// apps/desktop/src/components/store/InstalledSection-app-tabs.tsx
//
// The store detail tabs and runtime doctor card for an installed app.

import { Markdown } from "@ryu/blocks/desktop/agent-elements/markdown.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { RequiredPluginsSection } from "@ryu/marketplace/catalog/detail/dependency-graph";
import { ListingDetailTabs } from "@ryu/marketplace/catalog/detail/listing-detail-tabs";
import { runScorecard } from "@ryu/marketplace/catalog/scorecard";
import type { CatalogEntry } from "@ryu/marketplace/catalog/types";
import { Button } from "@ryu/ui/components/button.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { useQuery } from "@tanstack/react-query";
import { useContext, useMemo } from "react";
import { TabsContext } from "@/src/contexts/TabsContext.tsx";
import { runCatalogScan } from "@/src/lib/api/catalog-scan.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type AppInfo,
	fetchPluginCatalogDetail,
	fetchPluginDoctor,
	type PluginDoctorReport,
} from "@/src/lib/api/plugins.ts";
import { InstalledPluginEvalCard } from "./InstalledPluginEvalCard.tsx";

/** The catalog entry an installed app maps onto, so the shared detail tabs can
 *  grade and render it exactly as the store does.
 *
 *  Only the five fields `CatalogEntry` requires are synthesised; everything the
 *  tabs actually read (README, versions, permissions, licence…) comes from the
 *  DETAIL fetch, not from here. Kept deliberately thin rather than fabricating
 *  plausible-looking values — a made-up description or tag would be graded by the
 *  scorecard as if the listing had declared it.
 *
 *  `description` is the one field that stopped being a synthesis: the manifest
 *  declares it and Core has always serialised it, so passing it through grades the
 *  listing on what it actually says. `tags` stays empty — no manifest field backs
 *  it, so anything here would be invented. */
function installedAppAsEntry(app: AppInfo): CatalogEntry {
	return {
		description: app.description ?? app.tagline ?? "",
		id: app.id,
		kinds: [...new Set(app.runnables.map((r) => r.kind))],
		name: app.name,
		surface_support: app.surfaceSupport,
		// The one exception to "synthesise nothing": the installed record IS the
		// authority on what this app requires, and the catalog detail is not — Core's
		// catalog source only emits `requires` when it has it, which is why
		// `useAppsCatalog` falls back to the record too. Carried as `apps` only:
		// `requires.grants` feeds the scorecard's permission-breadth check, and a
		// synthesised value there would grade a listing on a field it never declared.
		requires: app.requires
			? {
					apps: app.requires.apps.map((dep) => ({
						id: dep.id,
						min_version: dep.minVersion,
					})),
				}
			: null,
		tags: [],
		version: app.version,
	};
}

/** README / API / Versions / Dependencies / Reviews / Health for an INSTALLED
 *  app — the same tabs the store shows.
 *
 *  Installing an app used to make its documentation disappear: the store rendered
 *  the full tabbed panel, and Store → Installed rendered a separate view with none
 *  of it. Fetched lazily and rendered only once it resolves, so the lifecycle
 *  controls above are never blocked on a network round-trip.
 *
 *  A local-only app has no catalog listing and so no tabs — but its dependency
 *  chain comes off the installed record, not the catalog, so that one section is
 *  rendered on its own rather than lost with the rest. */
export function InstalledAppTabs({
	app,
	target,
}: {
	app: AppInfo;
	target: ApiTarget;
}) {
	const entry = useMemo(() => installedAppAsEntry(app), [app]);
	const { data: detail } = useQuery({
		enabled: Boolean(app.id),
		queryFn: () => fetchPluginCatalogDetail(target, app.id),
		queryKey: ["plugins", "detail", "installed", app.id],
		// A local-only app has no catalog listing; that is expected, not an error.
		retry: false,
		staleTime: 5 * 60 * 1000,
	});
	const tabsHost = useContext(TabsContext);
	const scorecard = useMemo(
		() => (detail ? runScorecard(entry, detail) : null),
		[detail, entry]
	);
	const doctorQuery = useQuery({
		enabled: false,
		queryFn: () => fetchPluginDoctor(target, app.id),
		queryKey: ["plugins", "doctor", app.id],
	});
	if (!detail) {
		return (
			<div className="flex flex-col gap-4">
				<RequiredPluginsSection
					apps={entry.requires?.apps ?? []}
					subjectId={app.id}
					subjectName={app.name}
				/>
				<InstalledDoctorCard
					onRun={() => {
						void doctorQuery.refetch();
					}}
					report={doctorQuery.data ?? null}
					running={doctorQuery.isFetching}
				/>
				<InstalledPluginEvalCard appId={app.id} target={target} />
			</div>
		);
	}
	return (
		<ListingDetailTabs
			agentScan={
				scorecard
					? () =>
							runCatalogScan(target, {
								description: detail.description ?? entry.description,
								id: entry.id,
								kind: "app",
								metadata: {
									source: detail.source,
									url: detail.url,
								},
								name: entry.name,
								scorecard,
							})
					: undefined
			}
			detail={detail}
			developerDoctor={
				<InstalledDoctorCard
					onRun={() => {
						void doctorQuery.refetch();
					}}
					report={doctorQuery.data ?? null}
					running={doctorQuery.isFetching}
				/>
			}
			developerEvals={
				<InstalledPluginEvalCard appId={app.id} target={target} />
			}
			entry={entry}
			key={target.url}
			Markdown={Markdown}
			onOpenAuditConversation={
				tabsHost
					? (conversationId) => tabsHost.openTab("/chat", { conversationId })
					: undefined
			}
			scorecard={scorecard}
		/>
	);
}

function InstalledDoctorCard({
	onRun,
	report,
	running,
}: {
	onRun: () => void;
	report: PluginDoctorReport | null;
	running: boolean;
}) {
	const tl = useLiteralMessages();
	return (
		<section
			className="flex flex-col gap-3"
			data-testid="plugin-runtime-doctor"
		>
			<div className="flex items-start justify-between gap-6">
				<div className="min-w-0">
					<h3 className="font-semibold text-sm">Runtime doctor</h3>
					<p className="text-detail text-muted-foreground">
						Read-only check of the manifest, dependencies and grants.
					</p>
				</div>
				<Button loading={running} onClick={onRun} size="sm" variant="outline">
					{running ? "Checking" : "Run doctor"}
				</Button>
			</div>
			{report ? (
				<div className="space-y-2 text-xs">
					<div className="flex flex-wrap items-center gap-2">
						<span className="font-medium tabular-nums">{report.score}/100</span>
						<span className="text-muted-foreground">
							{tl("{errors} errors · {warnings} warnings", {
								errors: formatCount(report.counts.errors) ?? "—",
								warnings: formatCount(report.counts.warnings) ?? "—",
							})}
						</span>
					</div>
					{report.findings.length > 0 ? (
						<ul>
							{report.findings.slice(0, 5).map((finding) => (
								<li
									className="border-border border-b py-2 last:border-b-0"
									key={finding.checkId}
								>
									<p className="font-medium">
										{finding.severity} · {finding.summary}
									</p>
									<p className="mt-0.5 text-muted-foreground">
										{finding.detail}
									</p>
								</li>
							))}
						</ul>
					) : (
						<p className="text-status-success">
							Healthy — no runtime findings.
						</p>
					)}
				</div>
			) : null}
		</section>
	);
}
