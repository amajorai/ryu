"use client";

// First-run consent card. Shown inside the expanded island until the user
// answers the per-capability prompts. Declining `contextRead` keeps the privacy
// HARD GATE closed: zero requests ever reach Shadow (:3030).
//
// Presentational view: the live island wraps this and supplies the real consent
// values + setter; standalone it renders both prompts unanswered.

import { Button } from "@ryu/ui/components/button";

/** The capabilities the card gates. */
export type IslandConsentKey = "contextRead" | "proactive";

interface CapabilityCopy {
	body: string;
	key: IslandConsentKey;
	title: string;
}

const CAPABILITIES: readonly CapabilityCopy[] = [
	{
		key: "contextRead",
		title: "Read screen context",
		body: "Let Ryu see the active window and on-screen text so it can help with what you are doing. Nothing is captured until you allow this.",
	},
	{
		key: "proactive",
		title: "Proactive suggestions",
		body: "Let Ryu surface suggestions on its own based on your context. Requires screen context.",
	},
] as const;

export interface ConsentCardViewProps {
	onSet?: (key: IslandConsentKey, value: boolean) => void;
	/** Per-capability answer: true allowed, false declined, null unanswered. */
	values?: Partial<Record<IslandConsentKey, boolean | null>>;
}

const noop = (): void => {
	// Static-render default; the live island injects the real consent setter.
};

/** The first-run consent card body (both prompts). */
export function ConsentCardView({
	values = {},
	onSet = noop,
}: ConsentCardViewProps) {
	return (
		<section className="flex flex-col gap-3 rounded-2xl bg-card p-3">
			<ul className="flex flex-col gap-3">
				{CAPABILITIES.map((cap) => {
					const value = values[cap.key] ?? null;
					const answered = value !== null;
					return (
						<li className="flex flex-col gap-2" key={cap.key}>
							<div>
								<p className="font-medium text-foreground text-xs">
									{cap.title}
								</p>
								<p className="type-caption mt-0.5 text-muted-foreground">
									{cap.body}
								</p>
							</div>
							<div className="flex gap-2">
								<Button
									appearance={value === true ? "default" : "island-panel"}
									onClick={() => onSet(cap.key, true)}
									size="xs"
									variant={value === true ? "default" : "ghost"}
								>
									Allow
								</Button>
								<Button
									appearance={
										value === false
											? "island-consent-declined"
											: "island-kind-inactive"
									}
									onClick={() => onSet(cap.key, false)}
									size="xs"
									variant="ghost"
								>
									Decline
								</Button>
								{answered ? (
									<span className="type-caption ml-auto self-center text-muted-foreground">
										{value ? "Allowed" : "Declined"}
									</span>
								) : null}
							</div>
						</li>
					);
				})}
			</ul>
		</section>
	);
}
