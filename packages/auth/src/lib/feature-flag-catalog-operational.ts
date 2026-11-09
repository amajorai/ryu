/**
 * The server-only operational switches of the feature-flag catalog: kill
 * switches and platform-level gates that only API replicas and workers read.
 * Split out of `feature-flag-catalog.ts` for the file-size limit; that module
 * appends these rows to `FEATURE_FLAGS` in this order.
 */
import {
	ABUSE_JOBS_FLAG,
	AUTH_DEVICE_LIMITS_FLAG,
	MANAGED_AGENTS_FLAG,
	MANAGED_AGENTS_PLATFORM_KEYS_FLAG,
	ONBOARDING_CONNECTION_REWARDS_FLAG,
	WATCH_GITHUB_PARTNER_FLAG,
	WATCH_WORKER_FLAG,
} from "./feature-flag-keys.ts";
import type { FeatureFlagDef } from "./feature-flags.ts";

export const OPERATIONAL_FEATURE_FLAGS: FeatureFlagDef[] = [
	{
		key: MANAGED_AGENTS_FLAG,
		description:
			"Serve the hosted Managed Agents API (/api/v1/managed-agents) and run its sweeper. Off answers every route 503 managed_agents_disabled; sessions and events are kept. Backends are enabled in code (MANAGED_AGENTS_BACKENDS), not by this flag: with the flag on and no backend listed, every create still fails with backend_disabled.",
		defaultValue: false,
		// Server-only: the router and sweeper read it; no client does.
		exposure: "private",
		// Spends vendor tokens and org credits: never on by accident.
		failMode: "closed",
	},
	{
		key: MANAGED_AGENTS_PLATFORM_KEYS_FLAG,
		description:
			"Let Managed Agents sessions run on Ryu's own vendor keys, metered to the org wallet. Off rejects new platform environments and sessions; BYOK sessions keep working.",
		defaultValue: false,
		exposure: "private",
		failMode: "closed",
	},
	{
		key: ONBOARDING_CONNECTION_REWARDS_FLAG,
		description:
			"Pay the onboarding connection rewards (Ryu Fast credit per connected app, capped per account). Off pauses every claim. The claimed connection id is not verified server-side, so on accepts that unverified claims are paid.",
		defaultValue: false,
		// Server-only: the claim route reads it; the client only sees the claim result.
		exposure: "private",
		// Mints credit grants: never on by accident.
		failMode: "closed",
	},
	{
		key: WATCH_WORKER_FLAG,
		description:
			"Run the Ryu Watch worker: scan enrolled assets, reconcile leaks and notify owners. Off skips each sweep; enrollments and findings are kept. Each replica re-reads it every minute.",
		defaultValue: false,
		exposure: "private",
		// Makes outbound scans and sends notifications: off until verified in the deployment.
		failMode: "closed",
	},
	{
		key: WATCH_GITHUB_PARTNER_FLAG,
		description:
			"Accept the GitHub secret-scanning partner callback for Ryu Watch (off answers 503 partner_intake_disabled). Turn it on only once a partner callback is configured; it does not mean GitHub approved the integration.",
		defaultValue: false,
		exposure: "private",
		failMode: "closed",
	},
	{
		key: ABUSE_JOBS_FLAG,
		description:
			"Run the managed-guardrails abuse jobs: scheduled detectors, the pending-event sweep, the ladder sweep and enforcement push retries. Off stops the scheduled passes on every replica within a minute; ingest still stores events and applies the ledger inline.",
		defaultValue: true,
		// Server-only: the API replicas' job supervisor reads it; no client does.
		exposure: "private",
		// A kill switch: a failed read keeps the jobs running, as before the flag existed.
		failMode: "open",
	},
	{
		key: AUTH_DEVICE_LIMITS_FLAG,
		description:
			"Refuse new sign-ins over the per-surface device caps (web, desktop, self-hosted, mobile, extension, CLI). Surface stamping and the usage summary work regardless.",
		defaultValue: false,
		exposure: "private",
		failMode: "closed",
	},
];
