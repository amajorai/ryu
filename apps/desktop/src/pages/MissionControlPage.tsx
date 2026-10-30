// apps/desktop/src/pages/MissionControlPage.tsx
//
// Mission Control: the project-level view over many chats.
//
// The chat's own Mission Control dock panel answers "what did THIS chat do". This
// page answers what neither a transcript nor a single panel can — what has been
// happening across every chat, over days and weeks. Recent sessions and what each
// accomplished, per-day activity, the files several chats keep returning to, and
// the to-dos left outstanding in threads nobody reopened.
//
// A SHELL page owned by an APP: the component ships here, but the feature belongs
// to `@ryu/mission-control`, which declares where it lives via
// `contributes.sidebar_buttons[].target` and owns the store behind
// `/api/mission-control/*`. See `contributions/app-shell-routes.ts`.
//
// The page also drives indexing (`syncMissionIndex`), because the sidecar cannot
// read a conversation — see `lib/api/mission-control.ts` for why that is forced
// rather than chosen. Opening the page brings the index up to date; everything
// rendered below is then a stored fact.

import { RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { PageBody, PageTop } from "@/src/components/views/page-layout.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { type ApiTarget, toTarget } from "@/src/lib/api/client.ts";
import {
	getMissionOverview,
	summarizeMissionConversation,
	syncMissionIndex,
} from "@/src/lib/api/mission-control.ts";

import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import {
	DEFAULT_RANGE_DAYS,
	type MissionScope,
	OverviewBody,
	RANGE_OPTIONS,
	SyncNotice,
} from "./MissionControlPage.sections.tsx";

export default function MissionControlPage() {
	const tl = useLiteralMessages();
	const [days, setDays] = useState(DEFAULT_RANGE_DAYS);
	const [scope, setScope] = useState<MissionScope>("project");
	const folder = useWorkspaceStore((s) => s.folder);
	// No folder open means there is no project to scope TO, so the choice
	// collapses rather than silently filtering everything out.
	const folderPath = scope === "project" ? folder : null;
	const projectLabel = useMemo(
		() => folder?.split("/").filter(Boolean).at(-1) ?? "This project",
		[folder]
	);
	// Derived, not a module constant: Base UI resolves the TRIGGER's text from
	// `items`, so a static label would read "This project" on the trigger while the
	// dropdown row read the folder name.
	const scopeOptions = useMemo(
		() => [
			{ value: "project", label: projectLabel },
			{ value: "everywhere", label: "All projects" },
		],
		[projectLabel]
	);
	const [summarizingId, setSummarizingId] = useState<string | null>(null);
	const activeNode = useActiveNode();
	const target: ApiTarget = useMemo(() => toTarget(activeNode), [activeNode]);
	const queryClient = useQueryClient();

	// Indexing runs first and the overview depends on it, so opening the page
	// cannot show a stale window: the sync's result is part of the query key.
	const sync = useQuery({
		queryKey: ["mission-control-sync", target.url],
		queryFn: ({ signal }) => syncMissionIndex(target, signal),
		refetchOnWindowFocus: false,
	});

	const overview = useQuery({
		queryKey: [
			"mission-control-overview",
			target.url,
			days,
			folderPath,
			// Both stamps: `dataUpdatedAt` alone never moves on a FAILED refetch, so
			// clicking Refresh after a transient error would look like nothing happened.
			sync.dataUpdatedAt,
			sync.errorUpdatedAt,
		],
		queryFn: ({ signal }) =>
			getMissionOverview(
				target,
				{ days: days || undefined, folderPath },
				signal
			),
		enabled: sync.isSuccess || sync.isError,
	});

	const summarize = useMutation({
		mutationFn: (id: string) => summarizeMissionConversation(target, id),
		onMutate: (id: string) => setSummarizingId(id),
		onSettled: () => {
			setSummarizingId(null);
			queryClient.invalidateQueries({ queryKey: ["mission-control-overview"] });
		},
	});

	const refresh = () => {
		sync.refetch();
	};

	const loading = sync.isLoading || overview.isLoading;

	return (
		<PageBody width="wide">
			<PageTop
				actions={
					<div className="flex items-center gap-2">
						{folder && (
							<Select
								items={scopeOptions}
								onValueChange={(value: string | null) =>
									setScope(value === "everywhere" ? "everywhere" : "project")
								}
								value={scope}
							>
								<SelectTrigger size="sm">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{scopeOptions.map((option) => (
										<SelectItem key={option.value} value={option.value}>
											{option.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						)}
						<Select
							items={RANGE_OPTIONS}
							onValueChange={(value: string | null) => {
								setDays(Number(value ?? DEFAULT_RANGE_DAYS));
							}}
							value={String(days)}
						>
							<SelectTrigger size="sm">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{RANGE_OPTIONS.map((option) => (
									<SelectItem key={option.value} value={option.value}>
										{option.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Button
							aria-label={tl("Refresh")}
							loading={sync.isFetching}
							onClick={refresh}
							size="icon-sm"
							variant="ghost-muted"
						>
							<HugeiconsIcon icon={RefreshIcon} size={16} />
						</Button>
					</div>
				}
				subtitle={
					folderPath
						? tl(
								"What every chat in {projectLabel} did, and what is still open.",
								{ projectLabel }
							)
						: "What every chat did, and what is still open."
				}
				title="Mission Control"
			/>

			{loading && (
				<SkeletonRows label="Reading your chats…" spacing="comfortable" />
			)}
			{overview.isError && (
				<p className="text-sm text-status-destructive" role="alert">
					Mission Control's sidecar did not answer. Check the app is enabled in
					the Store.
				</p>
			)}
			{summarize.isError && (
				<p className="text-sm text-status-destructive" role="alert">
					That summary needs a model this node can reach — the dashboard's own
					numbers are unaffected.
				</p>
			)}
			<SyncNotice sync={sync.data} />
			{overview.data && (
				<OverviewBody
					onSummarize={(id) => summarize.mutate(id)}
					overview={overview.data}
					summarizingId={summarizingId}
				/>
			)}
		</PageBody>
	);
}
