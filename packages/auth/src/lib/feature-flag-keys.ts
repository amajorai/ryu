/**
 * Stable wire keys of the rollout flags in the feature-flag catalog
 * (`feature-flag-catalog.ts`). Re-exported from `feature-flags.ts`, which is the
 * import path callers use. A key is a wire identifier: never rename one in
 * flight. This module has no imports so the catalog can load it without a cycle.
 */

/** Stable key for the OS desktop interface (the workspace tier). */
export const INTERFACE_OS_FLAG = "ui.interface_os" as const;

/**
 * Stable key for the workspace interfaces beyond the OS desktop: Channels,
 * Feed, the worlds, the layouts, and Marketplace interfaces.
 */
export const WORKSPACE_INTERFACES_FLAG = "ui.workspace_interfaces" as const;

/** Stable key for the temporary organization-first pricing rollout. */
export const INDIVIDUAL_PLANS_FLAG = "billing.individual_plans" as const;
export const STANDALONE_PAYG_FLAG = "billing.standalone_payg" as const;
export const BILLING_PERIODS_FLAG = "billing.payment_periods" as const;

/**
 * Stable key for the desktop Lifetime Desktop trial + free-tier caps. Off (the
 * waitlist phase default) every desktop runs as "free during beta": no trial
 * clock, no paywall or upsell, and no numeric caps (tabs, remote nodes,
 * agents). Paid subscriptions and licences resolve exactly as before.
 */
export const DESKTOP_TRIAL_FLAG = "billing.desktop_trial" as const;

/** Stable key for the A Major Pass (`marketplace-membership`) rollout. */
export const A_MAJOR_PASS_FLAG = "billing.a_major_pass" as const;

/**
 * Stable key for opening the private Plus plan to the public. Off, Plus is
 * reachable only through its private offer link and nothing public lists or
 * sells it: no pricing card, no gift option, no plan switch, and the billing
 * and gifts routers refuse it. Existing Plus subscribers, already-bought gifts
 * and the private offer keep working either way.
 */
export const PLUS_PUBLIC_FLAG = "plans.plus_public" as const;

/** Stable key for the Ryu for Students page and its verification endpoints. */
export const STUDENT_PROGRAM_FLAG = "programs.students" as const;

/** Stable key for the Ryu for Startups page and its application endpoints. */
export const STARTUP_PROGRAM_FLAG = "programs.startups" as const;

/**
 * Stable key for the invite-only Template Rewards pilot: discretionary,
 * usage-based rewards for creators of Marketplace agent/workflow templates,
 * settled over the seller Stripe Connect rail.
 */
export const TEMPLATE_REWARDS_PILOT_FLAG =
	"marketplace.template_rewards_pilot" as const;

/**
 * Stable key for the Max family-sharing rollout. It gates only NEW enables and
 * NEW admissions; switching it off never removes members or reverts a family
 * organization's kind.
 */
export const FAMILY_SHARING_FLAG = "billing.family_sharing" as const;

/**
 * Stable key for scheduled plan-price migrations (`plan-migration.ts`). Off,
 * an admin can preview a migration but cannot arm one, and an armed campaign
 * sends nothing and changes no subscription. Even on, the money-moving step
 * also needs `RYU_PLAN_MIGRATIONS_LIVE=1` in the server environment; without
 * it every step runs in simulate mode.
 */
export const PLAN_MIGRATIONS_FLAG = "billing.plan_migrations" as const;

/**
 * Stable key for the Family hub app (`@ryu/family`) rollout. It is a discovery
 * gate only: it hides the app and its Family Planner template from Store and
 * marketplace listings. Installed copies keep working when it is off, and the
 * app itself never reads it. Deliberately separate from `FAMILY_SHARING_FLAG`:
 * the hub works for any workspace, not only a shared Max family.
 */
export const FAMILY_HUB_FLAG = "family.hub" as const;

/**
 * Standalone-service rollout keys, one per purchasable or hosted service. Each
 * gates only that service's STANDALONE surface: marketing discovery (header,
 * products index, product page, sitemap, standalone pricing card), the org
 * console card, the Store listing where an app is the standalone surface, and
 * the control-plane routes that start NEW standalone usage. None of them gates
 * a plan-included feature (Agent Inboxes, organization notifications, managed
 * Gateway inference), stops settlement of usage that already happened, or
 * touches the customer-owned `products.*` organization features, which are a
 * different axis (`organization-features.ts`). Turning one off hides the
 * service from new buyers; existing hosted resources stay listable, stoppable
 * and deletable.
 */
export const SERVICE_BOX_FLAG = "services.box" as const;
export const SERVICE_CONNECT_FLAG = "services.connect" as const;
export const SERVICE_GATEWAY_FLAG = "services.gateway" as const;
export const SERVICE_HIRE_FLAG = "services.hire" as const;
export const SERVICE_MAIL_FLAG = "services.mail" as const;
export const SERVICE_MESSAGING_FLAG = "services.messaging" as const;
export const SERVICE_NOTIFY_FLAG = "services.notify" as const;
export const SERVICE_PASSPORT_FLAG = "services.passport" as const;
export const SERVICE_SITES_FLAG = "services.sites" as const;

/**
 * Product launch keys for marketing products that are built but not released.
 * Each one only lists its product on the public site (header Products menu,
 * mobile nav, footer, /products index and homepage cards); the product page
 * itself stays reachable by URL. Mapped by slug in `product-launch-flags.ts`.
 */
export const CATALOG_WORKFLOWS_FLAG = "catalog.workflows" as const;
export const CATALOG_AGENTS_AS_A_SERVICE_FLAG =
	"catalog.agents_as_a_service" as const;
export const CATALOG_RED_TEAM_FLAG = "catalog.red_team" as const;

/**
 * Stable key for the desktop Compute and Share tabs (the compute exchange):
 * their sidebar buttons, command-palette entries, and the `/compute` and
 * `/share` pages.
 */
export const COMPUTE_SHARE_FLAG = "ui.compute_share" as const;

/**
 * Stable key for the hosted Ryu Messaging rollout (SMS, MMS, WhatsApp, voice,
 * and phone numbers over AWS End User Messaging; docs/messaging-service.md).
 * The messaging router re-evaluates it per organization on every org route, so
 * the client value only hides entry points. Off refuses new sends and number
 * purchases; leased numbers keep renewing until they are released.
 */
export const MESSAGING_FLAG = "messaging.hosted" as const;

/** Stable key for the Fresh cloud box cloud-task backend rollout. */
export const CLOUD_TASKS_BOX_BACKEND_FLAG = "cloud_tasks.box_backend" as const;

/**
 * Stable key for running cloud tasks on the node owner's own Claude or ChatGPT plan,
 * through the provider CLI they signed in themselves (`docs/subscription-cloud-sessions.md`).
 */
export const CLOUD_TASKS_SUBSCRIPTION_BACKENDS_FLAG =
	"cloud_tasks.subscription_backends" as const;

/**
 * Hosted (Ryu-managed node) use of the ChatGPT plan backends. OpenAI requires paid or
 * remotely hosted apps to be approved before using Sign in with ChatGPT, so this stays
 * off until that approval exists. Core reads it from the signed `ryu_flags` claim.
 */
export const CLOUD_TASKS_SUBSCRIPTION_BACKENDS_HOSTED_OPENAI_FLAG =
	"cloud_tasks.subscription_backends_hosted_openai" as const;

/**
 * Stable key for the hosted Ryu Managed Agents surface (`/api/v1/managed-agents`,
 * docs/managed-agents-spec.md). Platform level: off answers every route 503
 * `managed_agents_disabled` and the sweeper skips its passes. Data is kept.
 */
export const MANAGED_AGENTS_FLAG = "services.managed_agents" as const;

/**
 * Stable key for Managed Agents platform-credential mode: sessions that run on
 * Ryu's own vendor keys (ProviderKeyVault scope `managed-agents`), metered to
 * the org wallet. Off rejects new platform environments and sessions; BYOK
 * sessions are unaffected.
 */
export const MANAGED_AGENTS_PLATFORM_KEYS_FLAG =
	"services.managed_agents_platform_keys" as const;

/**
 * Stable key for the onboarding connection-reward campaign (`onboarding-rewards.ts`). Platform
 * level and fail closed: a claim names a connection id the cloud cannot verify, so turning it on
 * accepts that unverified claims are paid.
 */
export const ONBOARDING_CONNECTION_REWARDS_FLAG =
	"onboarding.connection_rewards" as const;

/**
 * Stable key for the Ryu Watch background worker (`docs/ryu-watch.md`). Platform level: off
 * skips every sweep, so no enrolled asset is scanned and no owner is notified.
 */
export const WATCH_WORKER_FLAG = "watch.worker" as const;

/**
 * Stable key for Ryu Watch partner intake: the GitHub secret-scanning callback. Platform level:
 * off answers the callback 503 `partner_intake_disabled`.
 */
export const WATCH_GITHUB_PARTNER_FLAG = "watch.github_partner" as const;

/**
 * Stable key for the managed-guardrails abuse jobs (detectors, the pending-event sweep, the
 * ladder sweep and enforcement push retries). Platform level kill switch, default on: off stops
 * the scheduled passes on every replica within one refresh; ingest still stores events and
 * applies the ledger inline.
 */
export const ABUSE_JOBS_FLAG = "abuse.jobs" as const;
