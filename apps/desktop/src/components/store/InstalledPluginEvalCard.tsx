import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchPluginEvals,
	type PluginEvalOverview,
	type PluginEvalRunResult,
	runPluginEvals,
} from "@/src/lib/api/plugins.ts";

function evalStatusLabel(status: string): string {
	switch (status) {
		case "ready":
		case "ready_with_warnings":
			return "Ready";
		case "not_configured":
			return "Not configured";
		case "empty":
			return "Empty suite";
		case "invalid":
			return "Needs attention";
		default:
			return status;
	}
}

function PluginEvalResultSummary({ result }: { result: PluginEvalRunResult }) {
	return (
		<div className="space-y-2" data-testid="plugin-evals-result">
			<div className="flex flex-wrap items-center gap-2 text-xs">
				<Badge variant="outline">
					{result.score === null
						? "—"
						: `${Math.round(result.score * 100)}/100`}
				</Badge>
				<span className="text-muted-foreground">
					{result.status} · {result.evidenceLevel}
				</span>
			</div>
			<ul>
				{result.cases.map((item) => (
					<li
						className="flex flex-wrap items-center justify-between gap-2 border-border border-b py-2 last:border-b-0"
						key={item.id}
					>
						<span className="min-w-0 truncate" title={item.name}>
							{item.name}
						</span>
						<span className="shrink-0 text-muted-foreground">
							{item.score === null
								? "not scored"
								: `${Math.round(item.score * 100)}/100`}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

export function InstalledPluginEvalCard({
	appId,
	target,
}: {
	appId: string;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const instanceId = useId();
	const generation = useRef(0);
	const authority = useMemo(
		() => ({
			queryScope: `${instanceId}:${++generation.current}`,
			target: {
				url: target.url.replace(/\/$/, ""),
				token: target.token,
				userJwt: target.userJwt ?? null,
			},
			appId,
		}),
		[
			target.url.replace(/\/$/, ""),
			target.token,
			target.userJwt ?? null,
			appId,
			instanceId,
		]
	);
	const currentAuthority = useRef(authority);
	currentAuthority.current = authority;
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const pending = useRef<typeof authority | null>(null);
	const [runningOwner, setRunningOwner] = useState<typeof authority | null>(
		null
	);
	const [resultState, setResultState] = useState<{
		owner: typeof authority;
		value: PluginEvalRunResult;
	} | null>(null);
	const [errorState, setErrorState] = useState<{
		owner: typeof authority;
		value: string;
	} | null>(null);
	const running = runningOwner === authority;
	const result = resultState?.owner === authority ? resultState.value : null;
	const runError = errorState?.owner === authority ? errorState.value : null;
	const isCurrent = () =>
		mounted.current && currentAuthority.current === authority;
	const suiteQuery = useQuery({
		enabled: Boolean(appId),
		queryFn: async () => {
			const payload = await fetchPluginEvals(authority.target, authority.appId);
			return "suite" in payload ? payload : null;
		},
		queryKey: ["plugins", "evals", authority.queryScope, authority.appId],
		retry: false,
		staleTime: 5 * 60 * 1000,
	});
	const overview = suiteQuery.data as PluginEvalOverview | null | undefined;
	const suite = overview?.suite;
	const run = async () => {
		if (
			!suite ||
			suite.caseCount === 0 ||
			suiteQuery.error ||
			pending.current === authority ||
			!isCurrent()
		) {
			return;
		}
		pending.current = authority;
		setRunningOwner(authority);
		setErrorState(null);
		try {
			const value = await runPluginEvals(authority.target, {
				id: authority.appId,
			});
			if (isCurrent()) {
				setResultState({ owner: authority, value });
			}
		} catch (error) {
			if (isCurrent()) {
				setErrorState({
					owner: authority,
					value: error instanceof Error ? error.message : String(error),
				});
			}
		} finally {
			if (pending.current === authority) {
				pending.current = null;
			}
			if (isCurrent()) {
				setRunningOwner(null);
			}
		}
	};

	return (
		<section
			className="flex flex-col gap-3 border-border border-t pt-4"
			data-testid="plugin-evals-card"
		>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h3 className="font-medium text-sm">Behavioral evals</h3>
					<p className="mt-1 text-muted-foreground text-xs leading-relaxed">
						Runs the package's evals/ cases through the enabled Ryu plugin or
						app. This is behavioral evidence, separate from the static scorecard
						and read-only doctor.
					</p>
				</div>
				<Button
					disabled={
						!suite ||
						suite.caseCount === 0 ||
						Boolean(suiteQuery.error) ||
						running
					}
					loading={running}
					onClick={() => {
						void run();
					}}
					size="sm"
				>
					{running ? "Running" : "Run evals"}
				</Button>
			</div>
			{suiteQuery.isLoading ? (
				<p className="text-muted-foreground text-xs">Inspecting eval suite…</p>
			) : suiteQuery.error ? (
				<div className="space-y-2">
					<p className="text-status-destructive text-xs" role="alert">
						{suiteQuery.error instanceof Error
							? suiteQuery.error.message
							: "Eval suite inspection failed."}
					</p>
					<Button
						onClick={() => {
							void suiteQuery.refetch();
						}}
						size="sm"
					>
						Retry
					</Button>
				</div>
			) : suite ? (
				<div className="space-y-2 text-xs">
					<div className="flex flex-wrap items-center gap-2">
						<Badge data-testid="plugin-evals-status" variant="outline">
							{evalStatusLabel(suite.status)}
						</Badge>
						<span className="text-muted-foreground">
							{tl(
								"{caseCount, plural, one {# case} other {# cases}} · {graderCount, plural, one {# grader} other {# graders}}",
								{
									caseCount: suite.caseCount,
									graderCount: suite.graderCount,
								}
							)}
						</span>
					</div>
					{suite.unsupportedGraders.length > 0 ? (
						<p className="text-status-warning">
							{tl("Skipped grader types: {graderTypes}", {
								graderTypes: suite.unsupportedGraders.join(", "),
							})}
						</p>
					) : null}
					{suite.issues.length > 0 ? (
						<p className="text-muted-foreground">{suite.issues[0]?.message}</p>
					) : null}
					{result ? <PluginEvalResultSummary result={result} /> : null}
				</div>
			) : (
				<p className="text-muted-foreground text-xs">
					No package eval suite found. Add evals/&lt;case&gt;/prompt.md and a
					grader to measure behavior.
				</p>
			)}
			{runError ? (
				<p className="text-status-destructive text-xs" role="alert">
					{runError}
				</p>
			) : null}
		</section>
	);
}
