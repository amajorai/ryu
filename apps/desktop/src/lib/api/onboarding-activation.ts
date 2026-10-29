import { z } from "zod";
import { BACKEND_URL, getActiveToken } from "@/lib/auth-client.ts";

export const ONBOARDING_SOURCES = [
	"friend",
	"search",
	"social",
	"community",
	"youtube",
	"podcast",
	"newsletter",
	"work",
	"other",
] as const;
export type OnboardingSource = (typeof ONBOARDING_SOURCES)[number];

export interface ActivationRewardSummary {
	amountMicroUsd: number;
	completed: number;
	remaining: number;
}

export interface ActivationRewardClaim extends ActivationRewardSummary {
	granted: boolean;
	reason?: "cap_reached" | "duplicate" | "paused";
}

const BASE = BACKEND_URL.replace(/\/$/, "");
const REQUEST_TIMEOUT_MS = 15_000;

function authHeaders() {
	const token = getActiveToken();
	if (!token) {
		throw new Error("Sign in to finish onboarding.");
	}
	return {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
	} satisfies NonNullable<RequestInit["headers"]>;
}

async function requestJson<T>(
	path: string,
	schema: z.ZodType<T>,
	init?: RequestInit
): Promise<T> {
	const response = await fetch(`${BASE}${path}`, {
		...init,
		headers: {
			...authHeaders(),
			...init?.headers,
		},
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		const body = z
			.object({
				error: z.string().optional().catch(undefined),
				message: z.string().optional().catch(undefined),
			})
			.catch({})
			.parse(await response.json().catch(() => ({})));
		throw new Error(
			body.message ?? body.error ?? `Request failed (${response.status})`
		);
	}
	return schema.parse(await response.json());
}

const activationRewardSummarySchema = z.object({
	amountMicroUsd: z.number(),
	completed: z.number(),
	remaining: z.number(),
});
const activationRewardClaimSchema = activationRewardSummarySchema.extend({
	granted: z.boolean(),
	reason: z.enum(["cap_reached", "duplicate", "paused"]).optional(),
});

export async function saveOnboardingSource(
	source: OnboardingSource
): Promise<void> {
	await requestJson<{ source: OnboardingSource }>(
		"/api/profile/me/onboarding-source",
		z.object({ source: z.enum(ONBOARDING_SOURCES) }),
		{
			body: JSON.stringify({ source }),
			method: "PATCH",
		}
	);
}

export function fetchActivationRewardSummary(): Promise<ActivationRewardSummary> {
	return requestJson<ActivationRewardSummary>(
		"/api/onboarding/activation/rewards",
		activationRewardSummarySchema
	);
}

export function claimActivationReward(input: {
	appSlug: string;
	connectionId: string;
}): Promise<ActivationRewardClaim> {
	return requestJson<ActivationRewardClaim>(
		"/api/onboarding/activation/rewards/claim",
		activationRewardClaimSchema,
		{
			body: JSON.stringify(input),
			method: "POST",
		}
	);
}
