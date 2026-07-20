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
		<section className="flex flex-col gap-3 rounded-2xl bg-white/5 p-3">
			<ul className="flex flex-col gap-3">
				{CAPABILITIES.map((cap) => {
					const value = values[cap.key] ?? null;
					const answered = value !== null;
					return (
						<li className="flex flex-col gap-2" key={cap.key}>
							<div>
								<p className="font-medium text-neutral-100 text-xs">
									{cap.title}
								</p>
								<p className="mt-0.5 text-[11px] text-neutral-400">
									{cap.body}
								</p>
							</div>
							<div className="flex gap-2">
								<Button
									className={
										value === true
											? ""
											: "bg-white/10 text-neutral-100 hover:bg-white/20"
									}
									onClick={() => onSet(cap.key, true)}
									size="xs"
									variant={value === true ? "default" : "ghost"}
								>
									Allow
								</Button>
								<Button
									className={
										value === false
											? "bg-white/15 text-neutral-200"
											: "text-neutral-400 hover:text-neutral-200"
									}
									onClick={() => onSet(cap.key, false)}
									size="xs"
									variant="ghost"
								>
									Decline
								</Button>
								{answered ? (
									<span className="ml-auto self-center text-[11px] text-neutral-500">
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
