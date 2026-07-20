import { useCallback, useEffect, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	createJob as apiCreateJob,
	deleteJob as apiDeleteJob,
	fetchJobs,
	type JobInput,
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
	};
	const { url, token } = target;

	const [jobs, setJobs] = useState<ScheduledJob[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const list = await fetchJobs({ url, token });
			setJobs(list);
		} catch (e) {
			console.error("Failed to load schedules", e);
			setError("We couldn't load your schedules. Please try again.");
		} finally {
			setLoading(false);
		}
	}, [url, token]);

	useEffect(() => {
		reload().catch(() => undefined);
	}, [reload]);

	// Auto-recover when Core reconnects or the user hits "Refresh all".
	useCoreRefresh(reload);

	const create = useCallback(
		async (input: JobInput) => {
			const job = await apiCreateJob({ url, token }, input);
			setJobs((prev) => [...prev, job]);
			return job;
		},
		[url, token]
	);

	const remove = useCallback(
		async (id: string) => {
			await apiDeleteJob({ url, token }, id);
			setJobs((prev) => prev.filter((j) => j.id !== id));
		},
		[url, token]
	);

	return { jobs, loading, error, reload, create, remove };
}
