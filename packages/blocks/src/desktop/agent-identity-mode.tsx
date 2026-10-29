"use client";

import {
	Globe02Icon,
	Robot01Icon,
	UserGroupIcon,
	UserIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { RadioGroup, RadioGroupItem } from "@ryu/ui/components/radio-group";
import { cn } from "@ryu/ui/lib/utils";
import type { AgentIdentityMode } from "@ryuhq/core-client/agents";
import { useId } from "react";

// "How should this agent work?" — the three-way identity choice.
//
// One presentational component for both places the choice is made: the first
// step of the New agent dialog (`size="hero"`, the whole step is this
// question) and the Identity section of the agent editor (`size="compact"`).
// It has no data dependencies, so the desktop app and the storyboard render
// the same cards. Each option is a big card with its icon ABOVE the title.
// Selection styling comes from an explicit `isSelected`, like
// `ConnectionPermissionDialog`: base-ui marks the checked radio with
// `data-checked`, so a `data-state=checked` selector would never match. The
// RadioGroup supplies the radio semantics and arrow-key movement.

export type { AgentIdentityMode } from "@ryuhq/core-client/agents";

export const AGENT_IDENTITY_MODE_OPTIONS = {
	managed: {
		title: "Acts as you",
		description: "Works on your behalf with the accounts you've connected.",
		icon: UserIcon,
	},
	individual: {
		title: "Its own identity",
		description:
			"Gets its own accounts and logins, and never touches yours. Models Ryu routes for it run on Ryu credits or a local model, not your provider keys, and engines that use your own sign-in don't start for it.",
		icon: Robot01Icon,
	},
	mixed: {
		title: "Both",
		description:
			"Has its own accounts, and can also use the ones of yours you allow. Its engine runs in a sandbox that hides Ryu's own data.",
		icon: UserGroupIcon,
	},
} satisfies Record<
	AgentIdentityMode,
	{ description: string; icon: typeof UserIcon; title: string }
>;

/** The order the cards are shown in. */
export const AGENT_IDENTITY_MODE_ORDER: readonly AgentIdentityMode[] = [
	"managed",
	"individual",
	"mixed",
];

export function isAgentIdentityMode(
	value: unknown
): value is AgentIdentityMode {
	return value === "managed" || value === "individual" || value === "mixed";
}

/** Whether the mode lets the agent use the user's own accounts. */
export function modeUsesYourAccounts(mode: AgentIdentityMode): boolean {
	return mode !== "individual";
}

/** Whether the mode gives the agent accounts of its own. */
export function modeHasOwnAccounts(mode: AgentIdentityMode): boolean {
	return mode !== "managed";
}

/**
 * Whether an agent's engine is a remote A2A peer (`a2a:<peer>`). Such an agent
 * runs on another node under that node's accounts, so its identity mode and
 * account access describe nothing it does here. Mirrors Core's
 * `agent_access::is_remote_peer_agent`.
 */
export function isRemotePeerEngine(engine: string | null | undefined): boolean {
	return engine?.trim().startsWith("a2a:") ?? false;
}

/** What the Identity section says instead of the choice for a remote peer. */
export const REMOTE_PEER_IDENTITY_NOTE = {
	title: "Runs on another node",
	description:
		"This agent is a remote A2A peer. It works with the accounts set up on that node, and Ryu reaches it with the credential you saved for the peer in A2A settings. None of your accounts here are handed to it, so there's no identity or account access to choose. Only an agent that acts as you with no account limit can hand work to it.",
} as const;

/**
 * The Identity section of a remote A2A peer: a note in place of the three
 * cards, so the editor never offers a choice that changes nothing.
 */
export function AgentRemotePeerIdentityNote() {
	return (
		<div
			className="flex items-start gap-3 rounded-2xl border border-border/70 p-4"
			data-identity-mode="remote-peer"
			role="note"
		>
			<span
				aria-hidden="true"
				className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-muted text-foreground/80"
			>
				<HugeiconsIcon icon={Globe02Icon} size={22} />
			</span>
			<div className="flex min-w-0 flex-col gap-1">
				<span className="font-medium text-sm">
					{REMOTE_PEER_IDENTITY_NOTE.title}
				</span>
				<span className="text-muted-foreground text-xs leading-relaxed">
					{REMOTE_PEER_IDENTITY_NOTE.description}
				</span>
			</div>
		</div>
	);
}

export interface AgentIdentityModePickerProps {
	"aria-label"?: string;
	disabled?: boolean;
	onChange: (mode: AgentIdentityMode) => void;
	size?: "hero" | "compact";
	value: AgentIdentityMode;
}

export function AgentIdentityModePicker({
	"aria-label": ariaLabel = "How should this agent work?",
	disabled = false,
	onChange,
	size = "compact",
	value,
}: AgentIdentityModePickerProps) {
	const baseId = useId();
	const hero = size === "hero";

	return (
		<RadioGroup
			aria-label={ariaLabel}
			className={cn("grid gap-3 sm:grid-cols-3", hero && "sm:gap-4")}
			disabled={disabled}
			onValueChange={(next) => {
				if (isAgentIdentityMode(next)) {
					onChange(next);
				}
			}}
			value={value}
		>
			{AGENT_IDENTITY_MODE_ORDER.map((mode) => {
				const option = AGENT_IDENTITY_MODE_OPTIONS[mode];
				const id = `${baseId}-${mode}`;
				const descriptionId = `${id}-description`;
				const isSelected = value === mode;
				return (
					<label
						className={cn(
							"relative flex cursor-pointer flex-col rounded-2xl border transition-colors has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/30",
							hero
								? "min-h-48 items-center gap-3 px-5 py-6 text-center"
								: "items-start gap-2 p-4 text-left",
							isSelected
								? "border-primary/60 bg-primary/5"
								: "border-border/70 hover:bg-muted/40",
							disabled && "cursor-not-allowed opacity-60"
						)}
						data-identity-mode={mode}
						htmlFor={id}
						key={mode}
					>
						<RadioGroupItem
							aria-describedby={descriptionId}
							className="absolute top-3 right-3"
							id={id}
							value={mode}
						/>
						<span
							aria-hidden="true"
							className={cn(
								"flex items-center justify-center rounded-2xl",
								hero ? "size-14" : "size-10",
								isSelected
									? "bg-primary/10 text-primary"
									: "bg-muted text-foreground/80"
							)}
						>
							<HugeiconsIcon icon={option.icon} size={hero ? 28 : 22} />
						</span>
						<span
							className={cn("font-medium", hero ? "text-base" : "pr-6 text-sm")}
						>
							{option.title}
						</span>
						<span
							className="text-muted-foreground text-xs leading-relaxed"
							id={descriptionId}
						>
							{option.description}
						</span>
					</label>
				);
			})}
		</RadioGroup>
	);
}
