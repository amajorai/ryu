import type { LiteralMessage } from "@ryu/i18n/react";
import type { NodeOnboardingSnapshot } from "@/src/lib/api/onboarding-profile.ts";
import type { DesktopOnboardingPhase } from "@/src/lib/desktop-onboarding-state.ts";

// The 'personalize-agent', 'first-project', 'agents', 'features', 'mic', 'theme', 'preferences',
// 'guidance', 'notifications', and 'privacy' phases are interactive: the user customizes the
// default agent, picks optional agents, optionally enables the microphone, sets
// the look, tunes general settings, and reviews the final onboarding screens.
// Every other phase auto-advances.
export type Phase = DesktopOnboardingPhase;

export const PHASE_TITLES = new Map<Phase, string>([
	["intro", "Welcome to Ryu"],
	["updates", "Before we get started"],
	["choose", "Where should Ryu do the work?"],
	["connect", "Connect the place where work runs"],
	["personalize-agent", "Personalize your default agent"],
	["first-project", "Create your first project"],
	["agents", "Choose what you want to run"],
	["skills", "Choose your recommended skills"],
	["node-setup", "Set up this node"],
	["local-default", "Choose your local starting point"],
	["organization", "Choose the workspace you work in"],
	["providers", "Choose how cloud work connects"],
	["connections", "Connect the tools behind your work"],
	["cloud-default", "Choose your cloud starting point"],
	["imports", "Bring your work with you"],
	["migrate", "Coming from another agent?"],
	["profile", "Give Ryu a starting point"],
	["agent-suggestions", "Suggested agents for your work"],
	["telegram", "Take the work to Telegram"],
	["features", "Choose what Ryu can do"],
	["mic", "Choose how you talk to Ryu"],
	// These steps render their own headers; these entries only satisfy the map.
	["notifications", "Know when your agents reply"],
	["theme", "Make it yours"],
	["safety", "Choose your workflow autonomy"],
	["preferences", "Set your preferences"],
	["guidance", "A few things to know"],
	["privacy", "Your privacy choices"],
	["done", "Ready to finish real work"],
]);

export const PHASE_SUBTITLES = new Map<Phase, string>([
	[
		"choose",
		"Ryu Cloud is the easiest. You can also run Ryu here or on your team's server.",
	],
	["connect", "Use an existing Ryu node as the place your work runs"],
	["personalize-agent", "Choose a name and avatar for your default agent"],
	[
		"first-project",
		"Projects keep a goal, its context and the bots working on it in one place",
	],
	["agents", "Start with one capability; add more when a workflow needs it"],
	[
		"skills",
		"Choose the optional skill collections this node should install; Ryu's built-in skills stay available",
	],
	[
		"node-setup",
		"Choose whether this node is for private work or a shared team workspace",
	],
	[
		"local-default",
		"This is the default lane for local work, plugins, and offline fallback",
	],
	[
		"organization",
		"Choose the shared workspace that owns your work and access",
	],
	[
		"providers",
		"Optional: connect a provider for cloud work. Keys stay on this node.",
	],
	[
		"connections",
		"Connect the accounts Ryu will use, then review each permission",
	],
	["cloud-default", "Normal chats use this lane when it is configured"],
	["imports", "Bring existing conversations into the workspace"],
	["migrate", "Bring your chats, agents, memory, and skills with you"],
	[
		"profile",
		"Give Ryu a starting point; approve the result before it becomes your profile",
	],
	[
		"agent-suggestions",
		"Review focused agent drafts from the workflows Ryu found in your approved sources",
	],
	["telegram", "Use the same default agent from Telegram"],
	["features", "Turn capabilities on or off; change them later"],
	["mic", "Talk to Ryu when typing is not the fastest way"],
	["safety", "Choose how much autonomy each workflow can have"],
	["done", "Ready to finish real work"],
]);

export interface OnboardingPageProps {
	nodeOnboardingState: NodeOnboardingSnapshot | null;
	nodeOnboardingStateAvailable: boolean;
}

// The auto-advancing phases (`installing`/`finishing`) can sit for a
// long time — `waitForLocalStack` polls the bundled inference install for up to
// 30 minutes. A single frozen line reads as "nothing is happening", so on those
// phases we cycle the header line to make the wait feel alive.
export const ROTATING_SUBTITLES = new Map<Phase, string[]>([
	[
		"installing",
		[
			"Installing the AI engine",
			"Downloading your local model",
			"Optimizing for your device",
			"Getting your local AI ready",
			"Teaching Ryu to think",
			"Wiring up the neurons",
			"Loading the brain cells",
			"Tuning the model weights",
			"Almost ready to chat",
			"This part can take a few minutes",
			"Hang tight, nearly there",
			"Putting the finishing touches",
		],
	],
	[
		"finishing",
		[
			"Adding your agents",
			"Applying your preferences",
			"Finishing up",
			"Rolling out the welcome mat",
			"Polishing things off",
			"Just a sec",
		],
	],
]);

export const ROTATE_INTERVAL_MS = 2600;

/** Why some selected agent drafts were not added, as one sentence group. */
export function agentSuggestionsFailureMessage(
	tl: LiteralMessage,
	{
		blockedByLimit,
		createdCount,
		createFailedNames,
		failedNames,
		refused,
	}: {
		blockedByLimit: boolean;
		createdCount: number;
		createFailedNames: string[];
		failedNames: string[];
		refused: string[];
	}
): string {
	if (blockedByLimit) {
		return "Your plan's agent limit prevented the remaining drafts from being added.";
	}
	if (refused.length > 0) {
		return tl(
			"{added}{refusals} Change how {count, plural, one {it works} other {they work}}, or skip.{failures}",
			{
				added:
					createdCount > 0
						? `${tl("Added {count}.", { count: createdCount })} `
						: "",
				count: refused.length,
				failures:
					createFailedNames.length > 0
						? ` ${tl("Couldn't add {names}. Try again or skip.", {
								names: createFailedNames.join(", "),
							})}`
						: "",
				refusals: refused.join(" "),
			}
		);
	}
	if (createdCount > 0) {
		return tl("Added {count}. Couldn't add {names}. Try again or skip.", {
			count: createdCount,
			names: failedNames.join(", "),
		});
	}
	return "Ryu couldn't add those agents yet. Try again or skip for now.";
}
