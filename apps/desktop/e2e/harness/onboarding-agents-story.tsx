// Standalone browser story for the onboarding `agents` step — the "Add your
// agents" screen — rendered straight from `@ryu/blocks/desktop/onboarding`.
//
// WHY IT EXISTS. This step went missing in the field: the container gated
// `setPhase("agents")` on the agent catalog returning something, so one 401 from
// a Core that had just minted its node token emptied both buckets and the step
// was dropped from the wizard with no error and no log. The container fix is
// "always show the step"; the view half of that fix is the FAILED column below —
// a lookup that could not answer must still render the curated rows plus an
// inline retry, never an empty screen and never no screen.
//
// The four columns are the states the step can be in: a healthy detection (rows
// under "Found on your system"), a failed lookup (curated rows + notice), a
// retry in flight (the notice's button busy and disabled), and the one genuinely
// empty case — every curated agent already added — which must explain itself
// rather than render a header over nothing.

import {
	type OnboardingAgentOption,
	OnboardingView,
} from "@ryu/blocks/desktop/onboarding.tsx";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

const agent = (
	id: string,
	name: string,
	detected: boolean | null
): OnboardingAgentOption => ({
	description: null,
	detected,
	id,
	installHint: null,
	name,
});

/** The curated set the container falls back to when the catalog is unreachable —
 *  the same ids/names as `SUGGESTED_AGENTS` in `OnboardingPage.tsx`. */
const CURATED: OnboardingAgentOption[] = [
	agent("acp:claude", "Claude Code", null),
	agent("acp:codex", "Codex", null),
	agent("acp:cursor", "Cursor", null),
	agent("acp:gemini", "Gemini CLI", null),
	agent("acp:opencode", "opencode", null),
	agent("acp:copilot", "GitHub Copilot CLI", null),
];

const DETECTED: OnboardingAgentOption[] = [
	agent("acp:claude", "Claude Code", true),
	agent("acp:opencode", "opencode", true),
];

function Column({
	agents = [],
	dark,
	label,
	retrying = false,
	suggested = [],
	unavailable = false,
}: {
	agents?: OnboardingAgentOption[];
	dark: boolean;
	label: string;
	retrying?: boolean;
	suggested?: OnboardingAgentOption[];
	unavailable?: boolean;
}) {
	// Counted, not asserted on a spy: the spec presses Retry and reads this back,
	// which proves the notice's button is wired rather than decorative.
	const [retries, setRetries] = useState(0);
	const [selected, setSelected] = useState<ReadonlySet<string>>(
		new Set(agents.map((a) => a.id))
	);
	return (
		<div
			className={`${dark ? "dark" : ""} flex-1 bg-background text-foreground`}
			data-testid={`column-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`}
		>
			<p className="p-4 font-medium text-muted-foreground text-xs uppercase tracking-widest">
				{label}
			</p>
			<p data-testid="retry-count">{retries}</p>
			<p data-testid="selected-count">{selected.size}</p>
			<OnboardingView
				agents={agents}
				agentsRetrying={retrying}
				agentsUnavailable={unavailable}
				isDesktop
				onRetryAgents={() => setRetries((n) => n + 1)}
				onToggleAgent={(id) =>
					setSelected((prev) => {
						const next = new Set(prev);
						if (next.has(id)) {
							next.delete(id);
						} else {
							next.add(id);
						}
						return next;
					})
				}
				selected={selected}
				step="agents"
				subtitle="Pick any you'd like to set up, and install more later"
				suggestedAgents={suggested}
				title="Add your agents"
			/>
		</div>
	);
}

createRoot(document.getElementById("root")!).render(
	<div className="flex min-h-screen">
		<Column agents={DETECTED} dark={false} label="Detected" suggested={[]} />
		<Column dark label="Failed" suggested={CURATED} unavailable />
		<Column dark label="Retrying" retrying suggested={CURATED} unavailable />
		<Column dark={false} label="Empty" suggested={[]} />
	</div>
);
