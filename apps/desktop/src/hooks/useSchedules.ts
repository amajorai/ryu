import { useCallback, useEffect, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	createJob as apiCreateJob,
	deleteJob as apiDeleteJob,
	runJobNow as apiRunJobNow,
	updateJob as apiUpdateJob,
	fetchJobs,
	type JobInput,
	type JobUpdateInput,
	type ScheduledJob,
} from "@/src/lib/api/schedules.ts";
import { useCoreRefresh } from "@/src/lib/core-refresh.ts";
import { useActiveNode } from "./useActiveNode.ts";

export interface UseSchedulesResult {
	create: (input: JobInput) => Promise<ScheduledJob>;
	error: string | null;
	jobs: ScheduledJob[];
	loading: boolean;
	reload: () => Promise<void>;
	remove: (id: string) => Promise<void>;
	runNow: (id: string) => Promise<string | null>;
	update: (id: string, input: JobUpdateInput) => Promise<ScheduledJob>;
}

/// Loads scheduled (heartbeat) jobs from the active Core node and exposes
/// create/delete operations that keep the in-memory list in sync after each
/// mutation. Create rejects with the exact Core validation error on a bad
/// cron/interval so the form can surface it.
export function useSchedules(): UseSchedulesResult {
	const activeNode = useActiveNode();
	const target: ApiTarget = {
		url: activeNode.url,
		token: activeNode.token ?? null,
		userJwt: activeNode.userJwt ?? null,
	};
	const { url, token, userJwt } = target;

	const [jobs, setJobs] = useState<ScheduledJob[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const list = await fetchJobs({ url, token, userJwt });
			setJobs(list);
		} catch (e) {
			console.error("Failed to load schedules", e);
			setError("We couldn't load your schedules. Please try again.");
		} finally {
			setLoading(false);
		}
	}, [url, token, userJwt]);

	useEffect(() => {
		reload().catch(() => undefined);
	}, [reload]);

	// Auto-recover when Core reconnects or the user hits "Refresh all".
	useCoreRefresh(reload);

	const create = useCallback(
		async (input: JobInput) => {
			const job = await apiCreateJob({ url, token, userJwt }, input);
			setJobs((prev) => [...prev, job]);
			return job;
		},
		[url, token, userJwt]
	);

	const remove = useCallback(
		async (id: string) => {
			await apiDeleteJob({ url, token, userJwt }, id);
			setJobs((prev) => prev.filter((j) => j.id !== id));
		},
		[url, token, userJwt]
	);

	const update = useCallback(
		async (id: string, input: JobUpdateInput) => {
			const job = await apiUpdateJob({ url, token, userJwt }, id, input);
			setJobs((prev) =>
				prev.map((current) => (current.id === id ? job : current))
			);
			return job;
		},
		[url, token, userJwt]
	);

	const runNow = useCallback(
		async (id: string) => {
			const runId = await apiRunJobNow({ url, token, userJwt }, id);
			await reload();
			return runId;
		},
		[url, token, userJwt, reload]
	);

	return { jobs, loading, error, reload, create, remove, update, runNow };
}
