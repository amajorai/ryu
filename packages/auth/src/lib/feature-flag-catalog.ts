import { WAITLIST_MANAGED_ONLY_FLAG } from "@ryuhq/protocol/feature-flags";
import {
	A_MAJOR_PASS_FLAG,
	ABUSE_JOBS_FLAG,
	BILLING_PERIODS_FLAG,
	CATALOG_AGENTS_AS_A_SERVICE_FLAG,
	CATALOG_RED_TEAM_FLAG,
	CATALOG_WORKFLOWS_FLAG,
	CLOUD_TASKS_BOX_BACKEND_FLAG,
	CLOUD_TASKS_SUBSCRIPTION_BACKENDS_FLAG,
	CLOUD_TASKS_SUBSCRIPTION_BACKENDS_HOSTED_OPENAI_FLAG,
	COMPUTE_SHARE_FLAG,
	DESKTOP_TRIAL_FLAG,
	FAMILY_HUB_FLAG,
	FAMILY_SHARING_FLAG,
	INDIVIDUAL_PLANS_FLAG,
	INTERFACE_OS_FLAG,
	MANAGED_AGENTS_FLAG,
	MANAGED_AGENTS_PLATFORM_KEYS_FLAG,
	MESSAGING_FLAG,
	ONBOARDING_CONNECTION_REWARDS_FLAG,
	PLAN_MIGRATIONS_FLAG,
	PLUS_PUBLIC_FLAG,
	SERVICE_BOX_FLAG,
	SERVICE_CONNECT_FLAG,
	SERVICE_GATEWAY_FLAG,
	SERVICE_HIRE_FLAG,
	SERVICE_MAIL_FLAG,
	SERVICE_MESSAGING_FLAG,
	SERVICE_NOTIFY_FLAG,
	SERVICE_PASSPORT_FLAG,
	SERVICE_SITES_FLAG,
	STANDALONE_PAYG_FLAG,
	STARTUP_PROGRAM_FLAG,
	STUDENT_PROGRAM_FLAG,
	TEMPLATE_REWARDS_PILOT_FLAG,
	WATCH_GITHUB_PARTNER_FLAG,
	WATCH_WORKER_FLAG,
	WORKSPACE_INTERFACES_FLAG,
} from "./feature-flag-keys.ts";
import type { FeatureFlagDef } from "./feature-flags.ts";

/**
 * The catalog. Adding a row here is enough for the SERVER to serve the key; a
 * client only sees it if a build carrying the reader is installed (see the
 * honest constraint above).
 */
export const FEATURE_FLAGS: FeatureFlagDef[] = [
	{
		key: STANDALONE_PAYG_FLAG,
		description:
			"Show standalone PAYG funding tiers and allow new standalone credit subscriptions. Existing credits and subscriptions stay valid when hidden.",
		defaultValue: false,
		exposure: "public",
		failMode: "closed",
	},
	{
		key: BILLING_PERIODS_FLAG,
		description:
			"Enable configured monthly/annual pricing display and its three-variant conversion experiment. Off restores both billing periods.",
		defaultValue: true,
		exposure: "public",
		failMode: "open",
	},
	{
		key: DESKTOP_TRIAL_FLAG,
		description:
			"Run the desktop Lifetime Desktop trial, its free-tier caps (open tabs, remote nodes, agents) and the paywall/upsell. Off keeps every desktop free and uncapped during beta.",
		defaultValue: false,
		exposure: "client",
		// Closed = an install that never read the map shows no trial and no caps.
		// Managed inference, credits and cloud nodes stay server-gated either way,
		// so turning this off gives away no spend.
		failMode: "closed",
	},
	{
		key: "ui.managed_inference_card",
		description:
			"Show the Managed inference (fleet URL + org token) card in the desktop's Gateway → Network settings.",
		defaultValue: false,
		exposure: "client",
		// Money-adjacent, so default OFF — but note precisely what that does and
		// does not do. Hiding the card does NOT stop spend: the prefs persist and
		// Core keeps resolving the fleet from them. Showing it does NOT enable
		// spend: minting an `rgw_` key is 402-gated by `managedInferenceAvailableForOrg`,
		// and `/gateway/resolve` recomputes `managedInference` on every 60s window.
		// This flag is a ROLLOUT / DISCOVERY gate. Both real gates are server-side
		// and must stay there — do not treat this as a money control.
		failMode: "closed",
	},
	{
		key: INDIVIDUAL_PLANS_FLAG,
		description:
			"Show the individual pricing shelf and allow new individual-plan checkout; existing individual entitlements remain valid when this is off.",
		defaultValue: false,
		exposure: "public",
		// Money-adjacent availability must stay closed until the rollout is
		// explicitly opened. The billing router applies the same decision, so
		// hiding the shelf is not the security boundary.
		failMode: "closed",
	},
	{
		key: A_MAJOR_PASS_FLAG,
		description:
			"Offer A Major Pass: show its pricing card, catalog ticket, and publisher opt-in, and allow new A Major Pass checkout; existing subscribers keep their Marketplace access when this is off.",
		defaultValue: false,
		exposure: "public",
		// Money-adjacent availability stays closed until explicitly opened. The
		// billing router refuses new checkout on the same decision, so hiding the
		// card is not the security boundary. Paid-package access never reads
		// this flag: an existing entitlement keeps working either way.
		failMode: "closed",
	},
	{
		key: PLUS_PUBLIC_FLAG,
		description:
			"Offer the private Plus plan publicly: show it on the pricing page and as a gift, and allow new checkout outside its private offer link. Existing subscribers, bought gifts, and the private offer keep working when this is off.",
		defaultValue: false,
		exposure: "public",
		// Money-adjacent availability stays closed until explicitly opened. The
		// billing and gifts routers refuse public Plus purchases on the same
		// decision, so hiding the card is not the security boundary.
		failMode: "closed",
	},
	{
		key: FAMILY_SHARING_FLAG,
		description:
			"Let Ryu Max holders turn their personal workspace into a family workspace and admit up to 6 people; existing family members stay when this is off.",
		defaultValue: false,
		exposure: "public",
		// Money-adjacent: sharing a paid plan. Closed so a client that never read
		// the map shows no entry point. The server re-evaluates the flag before
		// every enable and admission, so the public value is not the boundary.
		failMode: "closed",
	},
	{
		key: PLAN_MIGRATIONS_FLAG,
		description:
			"Allow admins to arm scheduled plan-price migrations and let armed campaigns send notices. Changing a subscription's price also needs RYU_PLAN_MIGRATIONS_LIVE=1 on the server.",
		defaultValue: false,
		// Server-only: no client ever reads it.
		exposure: "private",
		// Moves money: never on by accident.
		failMode: "closed",
	},
	{
		key: INTERFACE_OS_FLAG,
		description:
			"Offer the OS desktop interface in the desktop switcher and startup realm. Off leaves Bot and Agent as the only interfaces.",
		defaultValue: false,
		exposure: "client",
		// Cosmetic, but held back until the rollout opens: an install that never
		// read the flag shows Bot and Console only. A remembered OS choice is kept
		// and returns when the flag turns on.
		failMode: "closed",
	},
	{
		key: WORKSPACE_INTERFACES_FLAG,
		description:
			"Offer the workspace interfaces beyond the OS desktop (Channels, Feed, the worlds, the layouts, and Marketplace interfaces). Needs ui.interface_os.",
		defaultValue: false,
		exposure: "client",
		failMode: "closed",
	},
	{
		key: STUDENT_PROGRAM_FLAG,
		description:
			"Show /students and accept school-email verification for a free one-year desktop licence (BYOK, no Ryu Cloud).",
		defaultValue: false,
		exposure: "public",
		// Gives away a paid licence, so it stays off until opened. The programs
		// router re-checks this flag on every write; hiding the page is not the gate.
		failMode: "closed",
	},
	{
		key: STARTUP_PROGRAM_FLAG,
		description:
			"Show /startups and accept startup applications for a free 3–6 month desktop licence (BYOK, no Ryu Cloud).",
		defaultValue: false,
		exposure: "public",
		failMode: "closed",
	},
	{
		key: TEMPLATE_REWARDS_PILOT_FLAG,
		description:
			"Open the invite-only Template Rewards pilot: template usage reporting, the creator rewards dashboard, and admin reward periods/payouts.",
		defaultValue: false,
		exposure: "client",
		// Money-adjacent: every route re-evaluates this server-side and enrollment
		// is invite-only, so the flag is the rollout gate rather than the only
		// guard on a transfer.
		failMode: "closed",
	},
	{
		key: FAMILY_HUB_FLAG,
		description:
			"Show the Family hub app and Family Planner template in the Store and marketplace; installed copies keep working when this is off.",
		defaultValue: false,
		exposure: "client",
		// Discovery only: the satellite is not flag-aware and installed copies
		// keep running. Closed so a client that never read the map does not list
		// an app that has not been rolled out to it.
		failMode: "closed",
	},
	{
		key: MESSAGING_FLAG,
		description:
			"Offer hosted Ryu Messaging (SMS, MMS, WhatsApp, voice, phone numbers) and accept its organization API calls; leased numbers keep renewing until released.",
		defaultValue: false,
		exposure: "client",
		// Money-adjacent, with SMS-pumping fraud risk: closed so a client that
		// never read the map shows no entry point. The messaging router evaluates
		// the flag for the organization on every org route; this is not the gate.
		failMode: "closed",
	},
	{
		key: WAITLIST_MANAGED_ONLY_FLAG.key,
		description:
			"Limit waitlist gating to nodes listed as Ryu Cloud managed. Off gates all node connections; on gates managed nodes only.",
		defaultValue: WAITLIST_MANAGED_ONLY_FLAG.defaultValue,
		exposure: "public",
		failMode: "closed",
	},
	{
		key: COMPUTE_SHARE_FLAG,
		description:
			"Show the Compute and Share tabs (sidebar buttons, command palette, and the /compute and /share pages) in the desktop.",
		defaultValue: false,
		exposure: "client",
		// Discovery gate for a surface still in rollout. Closed so a client that
		// never read the map does not show it; platform admins see it by catalog
		// audience, and the kill switch hides it for them too.
		failMode: "closed",
		audiences: ["platform_admin"],
	},
	{
		key: SERVICE_BOX_FLAG,
		description:
			"Offer hosted Ryu Box (on by default since launch): product page, nav, sitemap, pricing card, org console New Box and Resume, new Box create/resume, the node Box credential and rbx1 tenant tokens. The kill switch closes them all; existing Boxes stay listable, stoppable and deletable, and their usage keeps settling.",
		// ON by default: Box ships on day one (docs/box-per-session-desktop.md
		// §12). Spend is bounded server-side by plan caps in the tenant token,
		// the node-credential credit check, and the tick-liveness lease.
		defaultValue: true,
		// Public: anonymous marketing pages read every `services.*` flag. Closed:
		// a surface that never read the map hides the service. These gate
		// discovery and NEW standalone usage only; settlement and plan-included
		// features never read them.
		exposure: "public",
		failMode: "closed",
	},
	{
		key: SERVICE_NOTIFY_FLAG,
		description:
			"Offer hosted Ryu Notify as a standalone service: product page, nav, pricing card and org console card. Organization notifications (products.notify) and existing hosted usage settlement are unaffected.",
		defaultValue: false,
		exposure: "public",
		failMode: "closed",
	},
	{
		key: SERVICE_PASSPORT_FLAG,
		description:
			"Offer hosted Ryu Passport as a standalone service: product page, nav and pricing card. The desktop Agent passport and existing hosted usage settlement are unaffected.",
		defaultValue: false,
		exposure: "public",
		failMode: "closed",
	},
	{
		key: SERVICE_CONNECT_FLAG,
		description:
			"Offer hosted Ryu Connect as a standalone service: product page, nav and pricing card, and minting or rotating a self-serve Connect key (listing and revoking stay open). Plan-included Composio calls through the Gateway and the local /connect bridge are unaffected.",
		defaultValue: false,
		exposure: "public",
		failMode: "closed",
	},
	{
		key: SERVICE_MAIL_FLAG,
		description:
			"Offer standalone Ryu Mail: product page, nav and pricing card. Plan-included Agent Inboxes (/api/mail, quotas, overage, the console Mail card and the @ryu/mail app) keep working when this is off.",
		defaultValue: false,
		exposure: "public",
		failMode: "closed",
	},
	{
		key: SERVICE_MESSAGING_FLAG,
		description:
			"Offer hosted Ryu Messaging as a standalone service: product page, nav and pricing card. Sends, number purchases and the organization console stay gated by messaging.hosted, and leased numbers keep renewing and settling either way.",
		defaultValue: false,
		exposure: "public",
		failMode: "closed",
	},
	{
		key: SERVICE_SITES_FLAG,
		description:
			"Offer Ryu Sites as a standalone service: product page, nav, pricing card, the cloud marketplace listing and the web showcase. The Sites app is pre-installed on every Core node, so a node's own Store and sidebar always show it, and installed Sites apps keep working when this is off.",
		defaultValue: false,
		exposure: "public",
		failMode: "closed",
	},
	{
		key: SERVICE_HIRE_FLAG,
		description:
			"Offer Ryu Hire: product page, nav and pricing card. Hire has no runtime, API or checkout yet; the Jobs interface's Freelancers tab is a separate surface.",
		defaultValue: false,
		exposure: "public",
		failMode: "closed",
	},
	{
		key: SERVICE_GATEWAY_FLAG,
		description:
			"List standalone (no-plan) Ryu Gateway in the pricing catalog. The Gateway product page, plan-included managed inference and the gateway API are unaffected; no-plan PAYG checkout stays under billing.standalone_payg.",
		defaultValue: false,
		exposure: "public",
		failMode: "closed",
	},
	{
		key: CATALOG_WORKFLOWS_FLAG,
		description:
			"List Workflows on the public site: header Products menu, mobile nav, /products index and homepage card. The /products/workflows page stays reachable by URL either way.",
		defaultValue: false,
		// Public: anonymous marketing pages read it. Closed: a page that never
		// read the map keeps the unreleased product out of its listings.
		exposure: "public",
		failMode: "closed",
	},
	{
		key: CATALOG_AGENTS_AS_A_SERVICE_FLAG,
		description:
			"List Agents as a Service on the public site: header Products menu, mobile nav, footer, /products index and homepage card. The /products/agents-as-a-service page stays reachable by URL either way.",
		defaultValue: false,
		exposure: "public",
		failMode: "closed",
	},
	{
		key: CATALOG_RED_TEAM_FLAG,
		description:
			"List Red Teaming on the public site: header Products menu, mobile nav, footer, /products index and homepage card. The /products/red-team page stays reachable by URL either way.",
		defaultValue: false,
		exposure: "public",
		failMode: "closed",
	},
	{
		key: CLOUD_TASKS_BOX_BACKEND_FLAG,
		description:
			"Run session work in Ryu Boxes (on by default): the Fresh cloud box backend for cloud environments and tasks, one Box per session with its own screen, computer-use and browser routing to that Box, and sub-agent Boxes. The kill switch turns every surface off and drops the key from Core's ryu_flags claim.",
		// ON for everyone by default (design §12). The former platform-admin
		// audience is gone: with a true base value it only added an enabling
		// rule, so removing it changes no evaluation.
		defaultValue: true,
		exposure: "client",
		// The desktop hides the backend when off; Core enforces it for verified
		// cloud callers through the signed `ryu_flags` JWT claim. A local owner
		// with no cloud identity is gated only by the node's Box service
		// configuration.
		failMode: "closed",
		coreClaim: true,
	},
	{
		key: CLOUD_TASKS_SUBSCRIPTION_BACKENDS_FLAG,
		description:
			"Run cloud tasks for the Claude Code and Codex agents on the node owner's own Claude or ChatGPT plan, through the provider CLI they signed in on the node, with the Ryu Box as the fallback. On by default (founder decision 2026-10-20, following Anthropic's 2026-10-07 plan-usage update); hosted OpenAI use stays behind the separate hosted flag.",
		defaultValue: true,
		exposure: "client",
		// The desktop hides the backends when off; Core enforces it for verified cloud
		// callers through the signed `ryu_flags` claim. A local owner with no cloud
		// identity is gated by their own Settings switch.
		failMode: "closed",
		coreClaim: true,
	},
	{
		key: CLOUD_TASKS_SUBSCRIPTION_BACKENDS_HOSTED_OPENAI_FLAG,
		description:
			"Allow Codex plan backends and new Sign in with ChatGPT sign-ins on Ryu-managed (hosted) nodes. Off until OpenAI approves Ryu through its Sign in with ChatGPT interest form; local and self-hosted nodes do not need it.",
		defaultValue: false,
		exposure: "client",
		failMode: "closed",
		coreClaim: true,
	},
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
];
