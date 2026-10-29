import type { ComposioConnection, ComposioToolkit } from "./api/composio.ts";
import type { GatewayOnboardingAccess } from "./api/onboarding-profile.ts";

/** One connection quest pays fifty cents in the Ryu Fast pool. */
export const ONBOARDING_REWARD_PER_CONNECTION_MICRO_USD = 500_000;
/** The activation campaign caps connection rewards at twenty apps. */
export const ONBOARDING_REWARD_CAP_MICRO_USD = 10_000_000;
export const ONBOARDING_REWARD_CONNECTION_CAP =
	ONBOARDING_REWARD_CAP_MICRO_USD / ONBOARDING_REWARD_PER_CONNECTION_MICRO_USD;

const EMAIL_TOOLKIT_SLUGS = new Set([
	"gmail",
	"google-mail",
	"microsoft-outlook",
	"outlook",
	"outlook-mail",
	"outlook365",
	"outlook_365",
]);

const CURATED_TOOLKIT_ORDER = [
	"notion",
	"slack",
	"hubspot",
	"linear",
	"gmail",
	"outlook",
] as const;

interface ToolkitTaskTemplate {
	prompt: string;
	title: string;
}

const TASK_TEMPLATES = new Map<string, ToolkitTaskTemplate>([
	[
		"gmail",
		{
			prompt:
				"Review my recent email and turn the work waiting for me into a prioritized follow-up list. Include the sender, the next action, and the reason it matters. Do not send or change anything without asking.",
			title: "Turn recent email into a follow-up list",
		},
	],
	[
		"hubspot",
		{
			prompt:
				"Review my highest-priority HubSpot opportunities and draft the next follow-up task for each one. Keep the tasks actionable and ask before changing CRM records.",
			title: "Prepare the next CRM follow-ups",
		},
	],
	[
		"linear",
		{
			prompt:
				"Review my Linear issues and propose the three tasks that should move next. Explain the order and ask before changing issue state.",
			title: "Find the next three issues to move",
		},
	],
	[
		"notion",
		{
			prompt:
				"Review the Notion workspaces I connected and find the most useful next task for me. Return a concise task brief with links and ask before editing anything.",
			title: "Find the next task in Notion",
		},
	],
	[
		"slack",
		{
			prompt:
				"Review the recent Slack work I connected and summarize the tasks that need an owner or a follow-up. Ask before sending messages or changing anything.",
			title: "Turn Slack follow-ups into tasks",
		},
	],
	[
		"outlook",
		{
			prompt:
				"Review my recent Outlook email and turn the work waiting for me into a prioritized follow-up list. Include the sender, the next action, and the reason it matters. Do not send or change anything without asking.",
			title: "Turn Outlook email into a follow-up list",
		},
	],
]);

export interface ActivationTaskDraft {
	appName: string | null;
	appSlug: string | null;
	prompt: string;
	title: string;
}

export interface ActivationRecommendation extends ActivationTaskDraft {
	active: boolean;
	connectionId: string | null;
	description: string | null;
	logo: string | null;
	reason: string;
}

export interface ActivationRewardProgress {
	amountMicroUsd: number;
	completed: number;
	remaining: number;
}

export interface ActivationEligibility {
	reason: string;
	recommendationsAllowed: boolean;
	rewardAllowed: boolean;
	taskAllowed: boolean;
}

export function activationRewardProgress(
	completedCount: number
): ActivationRewardProgress {
	const completed = Math.max(
		0,
		Math.min(ONBOARDING_REWARD_CONNECTION_CAP, Math.floor(completedCount))
	);
	return {
		amountMicroUsd: completed * ONBOARDING_REWARD_PER_CONNECTION_MICRO_USD,
		completed,
		remaining: ONBOARDING_REWARD_CONNECTION_CAP - completed,
	};
}

function normalizeSlug(value: string): string {
	return value.trim().toLowerCase().replaceAll("_", "-");
}

function hasActiveEmailConnection(
	connections: readonly ComposioConnection[]
): boolean {
	return connections.some(
		(connection) =>
			connection.active &&
			EMAIL_TOOLKIT_SLUGS.has(normalizeSlug(connection.toolkit))
	);
}

function templateFor(slug: string): ToolkitTaskTemplate {
	return (
		TASK_TEMPLATES.get(slug) ?? {
			prompt: `Review my recent ${slug} work and suggest the next task I can delegate. Keep it concise, cite the relevant source, and ask before changing anything.`,
			title: `Find the next task in ${slug}`,
		}
	);
}

function taskDraftFor(slug: string, name: string | null): ActivationTaskDraft {
	const template = templateFor(slug);
	return {
		appName: name,
		appSlug: slug,
		prompt: template.prompt,
		title: template.title,
	};
}

/**
 * Build a stable, small set of app rows from Core's live Composio catalog.
 * The only profile signal used here is whether the user has an active email
 * connection; raw email content never crosses into the desktop UI.
 */
export function buildActivationRecommendations(input: {
	connections: readonly ComposioConnection[];
	toolkits: readonly ComposioToolkit[];
}): ActivationRecommendation[] {
	const emailConnected = hasActiveEmailConnection(input.connections);
	const toolkitsBySlug = new Map<string, ComposioToolkit>();
	for (const toolkit of input.toolkits) {
		const slug = normalizeSlug(toolkit.slug);
		if (slug && !toolkitsBySlug.has(slug)) {
			toolkitsBySlug.set(slug, toolkit);
		}
	}
	const connectionsByToolkit = new Map<string, ComposioConnection>();
	for (const connection of input.connections) {
		const slug = normalizeSlug(connection.toolkit);
		if (slug && !connectionsByToolkit.has(slug)) {
			connectionsByToolkit.set(slug, connection);
		}
	}

	const rows: ActivationRecommendation[] = [];
	for (const curatedSlug of CURATED_TOOLKIT_ORDER) {
		const toolkit = toolkitsBySlug.get(curatedSlug);
		if (!toolkit) {
			continue;
		}
		const connection = connectionsByToolkit.get(curatedSlug);
		const active = connection?.active ?? false;
		const reason =
			active && EMAIL_TOOLKIT_SLUGS.has(curatedSlug)
				? "Your email is connected, so Ryu can organize the work waiting for you."
				: emailConnected
					? "This app fits the work Ryu found around your connected email."
					: "A useful place to start delegating work in Ryu.";
		const task = taskDraftFor(curatedSlug, toolkit.name || curatedSlug);
		rows.push({
			...task,
			active,
			connectionId: connection?.id ?? null,
			description: toolkit.description,
			logo: toolkit.logo,
			reason,
		});
	}
	return rows;
}

export function buildActivationTaskDraft(
	recommendations: readonly ActivationRecommendation[]
): ActivationTaskDraft {
	const active = recommendations.find(
		(recommendation) => recommendation.active
	);
	if (active) {
		return {
			appName: active.appName,
			appSlug: active.appSlug,
			prompt: active.prompt,
			title: active.title,
		};
	}
	const first = recommendations[0];
	if (first) {
		return taskDraftFor(first.appSlug ?? "work", first.appName);
	}
	return {
		appName: null,
		appSlug: null,
		prompt:
			"Look at the context I have connected to Ryu and suggest the next three tasks I can delegate. Explain the order, keep the list concise, and ask before changing anything.",
		title: "Find your next best task",
	};
}

export function deriveActivationEligibility(input: {
	gateway: GatewayOnboardingAccess | null;
	ownerOrAdmin: boolean;
}): ActivationEligibility {
	if (!input.gateway) {
		return {
			reason: "access_unavailable",
			recommendationsAllowed: false,
			rewardAllowed: false,
			taskAllowed: false,
		};
	}
	if (!input.gateway.allowed) {
		return {
			reason: input.gateway.reason,
			recommendationsAllowed: false,
			rewardAllowed: false,
			taskAllowed: false,
		};
	}
	if (!input.ownerOrAdmin) {
		return {
			reason: "not_owner_or_admin",
			recommendationsAllowed: false,
			rewardAllowed: false,
			taskAllowed: false,
		};
	}
	return {
		reason: "ready",
		recommendationsAllowed: true,
		rewardAllowed: true,
		taskAllowed: true,
	};
}

/** Preview and checkout never create work. The live entitlement is rechecked before execution. */
export function activationStartAction(input: {
	task: ActivationTaskDraft;
	recommendations: readonly ActivationRecommendation[];
	managedInference: boolean;
}): "connect" | "checkout" | "execute" {
	if (
		input.task.appSlug &&
		!input.recommendations.some(
			(item) => item.appSlug === input.task.appSlug && item.active
		)
	) {
		return "connect";
	}
	return input.managedInference ? "execute" : "checkout";
}
