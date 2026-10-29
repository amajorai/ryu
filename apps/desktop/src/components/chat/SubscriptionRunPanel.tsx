// apps/desktop/src/components/chat/SubscriptionRunPanel.tsx
//
// A locked cloud chat whose task runs on the owner's own Claude or ChatGPT plan.
// Core started it with the provider's CLI, so Ryu shows what the CLI can report:
// - a run in the provider's cloud: the provider's link, Codex's status and summary,
//   and the last error;
// - a run on this computer (`claude -p` or `codex exec`): its live log, branch, Stop,
//   and the changes in its worktree.
// It also lists the session features this backend does not have in Ryu, instead of
// hiding them. The panel renders nothing when the conversation runs elsewhere (404).

import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, type ApiTarget } from "@/src/lib/api/client.ts";
import {
	CLOUD_TASK_BACKEND_LABELS,
	type CloudTaskBackendFeatures,
	fetchSubscriptionRun,
	fetchSubscriptionRunDiff,
	stopSubscriptionRun,
} from "@/src/lib/api/cloud-task-backends.ts";

export const SUBSCRIPTION_RUN_QUERY_KEY = "cloud-task-subscription-run";

const MISSING: { feature: keyof CloudTaskBackendFeatures; label: string }[] = [
	{ feature: "liveScreen", label: "live screen" },
	{ feature: "runLog", label: "run log" },
	{ feature: "diffInRyu", label: "diff review in Ryu" },
	{ feature: "pullRequestInRyu", label: "pull requests from Ryu" },
	{ feature: "stopFromRyu", label: "stop from Ryu" },
	{ feature: "followUp", label: "follow-up messages" },
];

const ACTIVE = new Set(["starting", "running"]);

const errorText = (failure: unknown): string => {
	if (failure instanceof ApiError) {
		return failure.serverMessage ?? failure.message;
	}
	return failure instanceof Error ? failure.message : "Something went wrong.";
};

function siteFor(backend: string): string | null {
	if (backend === "openai-subscription-cli") {
		return "Codex";
	}
	return backend === "anthropic-subscription-cli" ? "Claude" : null;
}

export function SubscriptionRunPanel({
	conversationId,
	target,
}: {
	conversationId: string;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const { url, token, userJwt } = target;
	const queryClient = useQueryClient();
	const queryKey = [SUBSCRIPTION_RUN_QUERY_KEY, url, conversationId];
	const { data: run } = useQuery({
		queryKey,
		queryFn: ({ signal }) =>
			fetchSubscriptionRun({ url, token, userJwt }, conversationId, signal),
		refetchInterval: (query) => {
			const current = query.state.data;
			if (!current?.features.liveStatus) {
				return false;
			}
			return ACTIVE.has(current.status) ? 3000 : 15_000;
		},
		retry: false,
	});
	const [showDiff, setShowDiff] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const { data: diff, error: diffError } = useQuery({
		enabled: showDiff && Boolean(run?.features.diffInRyu),
		queryKey: [SUBSCRIPTION_RUN_QUERY_KEY, "diff", url, conversationId],
		queryFn: ({ signal }) =>
			fetchSubscriptionRunDiff({ url, token, userJwt }, conversationId, signal),
		retry: false,
	});
	if (!run) {
		return null;
	}
	const missing = MISSING.filter(({ feature }) => !run.features[feature]).map(
		({ label }) => label
	);
	const site = siteFor(run.backend);
	const active = ACTIVE.has(run.status);
	const stop = async () => {
		setActionError(null);
		try {
			await stopSubscriptionRun({ url, token, userJwt }, conversationId);
			await queryClient.invalidateQueries({ queryKey });
		} catch (failure) {
			setActionError(errorText(failure));
		}
	};
	return (
		<section
			aria-label="Cloud task on your plan"
			className="flex w-full flex-col gap-1 rounded-md border px-2 py-1.5 text-xs"
		>
			<div className="flex flex-wrap items-center gap-2">
				<Badge variant="secondary">
					{CLOUD_TASK_BACKEND_LABELS[run.backend]}
				</Badge>
				<span className="text-muted-foreground">
					{tl("Status: {status}", { status: run.status })}
				</span>
				<span className="text-muted-foreground">No Ryu credits used</span>
				{run.branch ? (
					<span className="text-muted-foreground">
						Branch: <code>{run.branch}</code>
					</span>
				) : null}
				{run.url && site ? (
					<a
						className="underline underline-offset-2"
						href={run.url}
						rel="noopener noreferrer"
						target="_blank"
					>
						{tl("Open in {site}", { site })}
					</a>
				) : null}
				{run.features.diffInRyu ? (
					<Button
						aria-expanded={showDiff}
						onClick={() => setShowDiff((shown) => !shown)}
						size="sm"
						variant="ghost"
					>
						{showDiff ? "Hide changes" : "View changes"}
					</Button>
				) : null}
				{run.features.stopFromRyu && active ? (
					<Button onClick={stop} size="sm" variant="outline">
						Stop
					</Button>
				) : null}
			</div>
			{run.outputTail ? (
				<pre
					aria-label="Run log"
					className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-1.5 font-mono text-[11px]"
				>
					{run.outputTail}
				</pre>
			) : null}
			{run.summary ? (
				<p className="text-muted-foreground">{run.summary}</p>
			) : null}
			{run.lastError ? (
				<p className="text-destructive" role="alert">
					{run.lastError}
				</p>
			) : null}
			{actionError ? (
				<p className="text-destructive" role="alert">
					{actionError}
				</p>
			) : null}
			{showDiff && diffError ? (
				<p className="text-destructive" role="alert">
					{errorText(diffError)}
				</p>
			) : null}
			{showDiff && diff ? (
				<div className="flex flex-col gap-1">
					{diff.files.length === 0 ? (
						<p className="text-muted-foreground">No changes yet.</p>
					) : (
						<pre
							aria-label="Changes"
							className="max-h-72 overflow-auto rounded bg-muted p-1.5 font-mono text-[11px]"
						>
							{diff.patch}
						</pre>
					)}
					{diff.truncated ? (
						<p className="text-muted-foreground">
							The patch is cut at 512 KiB. See the full changes on the branch.
						</p>
					) : null}
				</div>
			) : null}
			{missing.length > 0 ? (
				<p className="text-muted-foreground">
					{site
						? tl(
								"Not available on this backend: {missingFeatures}. Review changes and open pull requests in {site}.",
								{ missingFeatures: missing.join(", "), site }
							)
						: tl(
								"Not available on this backend: {missingFeatures}. Push the branch from your checkout to open a pull request.",
								{ missingFeatures: missing.join(", ") }
							)}
				</p>
			) : null}
		</section>
	);
}
