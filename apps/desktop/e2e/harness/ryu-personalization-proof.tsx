import {
	type OnboardingAgentOption,
	OnboardingView,
} from "@ryu/blocks/desktop/onboarding.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import {
	RyuOnboardingPersonaProvider,
	useRyuOnboardingPersona,
} from "../../src/components/onboarding/RyuOnboardingPersona.tsx";
import { RyuPersonalizationStep } from "../../src/components/onboarding/RyuPersonalizationStep.tsx";
import "../../src/index.css";

const target = { token: "proof-token", url: "http://127.0.0.1:7980" };

const currentAgent = {
	built_in: true,
	can_create_agents: true,
	chat_model: { engine: "acp:pi", model_id: null },
	composio_actions: [],
	description: "Ryu agent",
	engine: "acp:pi",
	id: "ryu",
	identity_profile_ids: [],
	lifecycle_status: "active",
	locked: false,
	memory: { read_levels: ["user"], space_ids: [], write_enabled: false },
	model: null,
	name: "Ryu",
	orchestrator: true,
	persona: {
		display_name: null,
		tone: null,
		avatar_url: null,
		emoji: null,
		icon: null,
		icon_color: null,
		dicebear: null,
		expressive: null,
		dither: null,
	},
	safety_profile: "autonomous",
	skills: [],
	system_prompt: null,
	title: "",
	tools: ["*"],
	version: "1.0.0",
};

const AgentWriteSchema = z
	.object({
		name: z.string().optional(),
		persona: z
			.object({ expressive: z.json().optional() })
			.catchall(z.json())
			.optional(),
	})
	.catchall(z.json());
interface ProofState {
	agentWrite: z.infer<typeof AgentWriteSchema> | null;
}

declare global {
	interface Window {
		__ryuPersonalizationProof: ProofState;
	}
}

window.__ryuPersonalizationProof = {
	agentWrite: null,
};

const originalFetch = window.fetch.bind(window);
const mockFetch = Object.assign(
	async (
		input: Parameters<typeof window.fetch>[0],
		init?: Parameters<typeof window.fetch>[1]
	) => {
		const url = new URL(
			isNativeText(input)
				? input
				: input instanceof Request
					? input.url
					: input.toString()
		);
		const method = init?.method?.toUpperCase() ?? "GET";
		const respond = <FixturePayload,>(body: FixturePayload) =>
			new Response(JSON.stringify(body), {
				headers: { "Content-Type": "application/json" },
				status: 200,
			});

		if (url.pathname === "/api/agents/ryu") {
			if (method === "PUT") {
				const body = AgentWriteSchema.parse(
					JSON.parse(String(init?.body ?? "{}"))
				);
				window.__ryuPersonalizationProof.agentWrite = body;
				return respond({ agent: { ...currentAgent, ...body } });
			}
			return respond({ agent: currentAgent });
		}

		return originalFetch(input, init);
	},
	{ preconnect: window.fetch.preconnect }
);
window.fetch = mockFetch;

const suggestedAgent: OnboardingAgentOption = {
	description: "An optional coding assistant",
	detected: false,
	id: "acp:codex",
	installHint: null,
	name: "Codex",
};

function Story() {
	const [showAgents, setShowAgents] = useState(false);
	const [saved, setSaved] = useState<ProofState | null>(null);
	const persona = useRyuOnboardingPersona();

	return (
		<main className="h-screen overflow-hidden bg-background text-foreground">
			{showAgents ? (
				<>
					<OnboardingView
						agentAvatarGlyph={persona.avatar}
						agents={[]}
						agentsRetrying={false}
						agentsUnavailable={false}
						isDesktop
						onToggleAgent={() => undefined}
						selected={new Set()}
						step="agents"
						subtitle="Pick any you would like to set up. You can add more later."
						suggestedAgents={[suggestedAgent]}
						title="Add your agents"
					/>
					{saved ? (
						<output
							className="sr-only"
							data-agent-name={String(saved.agentWrite?.name ?? "")}
							data-avatar-kind={String(
								saved.agentWrite?.persona?.expressive ? "expressive" : "other"
							)}
							data-testid="personalization-saved"
						/>
					) : null}
				</>
			) : (
				<RyuPersonalizationStep
					onContinue={() => {
						setSaved(window.__ryuPersonalizationProof);
						setShowAgents(true);
					}}
					onSkip={() => setShowAgents(true)}
					target={target}
				/>
			)}
		</main>
	);
}

createRoot(document.getElementById("root")!).render(
	<RyuOnboardingPersonaProvider>
		<Story />
	</RyuOnboardingPersonaProvider>
);
