// apps/desktop/src/lib/api/memory-git-trace.ts
//
// Typed client for the recent-commit trace of the explicitly configured
// `memory/` Git source (`/api/memory/git/trace`).

import { z } from "zod";
import { type ApiTarget, request } from "./client.ts";

const commitsResponseSchema = z.looseObject({
	author: z.string(),
	files: z.array(z.string()),
	hash: z.string(),
	subject: z.string(),
	timestamp: z.string(),
});
const jsonResponseSchema7 = z.looseObject({
	commits: z.array(commitsResponseSchema).optional(),
	configured: z.boolean().optional(),
	path: z.string().optional(),
});

/** A bounded commit entry from the explicitly configured memory Git source. */
export interface MemoryGitTraceCommit {
	author: string;
	files: string[];
	hash: string;
	subject: string;
	timestamp: string;
}

export interface MemoryGitTrace {
	commits: MemoryGitTraceCommit[];
	configured: boolean;
	path: string;
}

/** Read recent commits from the configured `memory/` Git source. */
export async function getMemoryGitTrace(
	target: ApiTarget,
	path = "memory",
	limit = 20
): Promise<MemoryGitTrace> {
	const query = new URLSearchParams({ path, limit: String(limit) });
	const json = await request(
		target,
		`/api/memory/git/trace?${query.toString()}`,
		undefined,
		jsonResponseSchema7
	);
	return {
		commits: json.commits ?? [],
		configured: json.configured ?? false,
		path: json.path ?? path,
	};
}
