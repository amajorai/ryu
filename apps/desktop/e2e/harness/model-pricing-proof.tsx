import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ModelHoverPreview } from "@/components/agent-elements/input/model-hover-preview.tsx";
import type { ModelInsight } from "@/src/lib/api/model-insight.ts";
import "../../src/index.css";

// Presentation fixture only. No registry request, wallet or billing acceptance.
const models: ModelInsight[] = [
	{
		aaKeyPresent: false,
		contextTokens: 1_000_000,
		costInputPer1m: 2.5,
		costOutputPer1m: 15,
		description:
			"OpenRouter's current transaction price, including its active promotion.",
		id: "openai/gpt-5.6-sol",
		modalitiesInput: ["text", "image"],
		modalitiesOutput: ["text"],
		name: "GPT-5.6 Sol",
		reasoning: true,
		scoreContext: 5,
		scoreCost: 4,
		scoreIntelligence: 4,
		scoreSpeed: 2,
		source: "openrouter",
	},
	{
		aaKeyPresent: false,
		contextTokens: 200_000,
		costInputPer1m: 3,
		costOutputPer1m: 15,
		description:
			"The same authoritative OpenRouter price feed drives this row.",
		id: "anthropic/claude-sonnet-4",
		modalitiesInput: ["text", "image", "pdf"],
		modalitiesOutput: ["text"],
		name: "Claude Sonnet 4",
		reasoning: true,
		scoreContext: 4,
		scoreCost: 4,
		scoreIntelligence: 4,
		scoreSpeed: 4,
		source: "openrouter",
	},
];

function ModelPricingProof() {
	const [selectedId, setSelectedId] = useState("openai/gpt-5.6-sol");
	const selected = models.find((model) => model.id === selectedId);
	return (
		<main className="min-h-screen bg-background p-8 text-foreground">
			<h1>Model price preview rendering</h1>
			<p>
				Supplied model-insight data exercises the shipping hover preview.
				Registry retrieval and accounting require separate transport tests.
			</p>
			<nav aria-label="Choose fixture insight">
				{models.map((model) => (
					<button
						key={model.id}
						type="button"
						data-testid={`model-row-${model.id}`}
						onClick={() => setSelectedId(model.id)}
					>
						{model.name}
					</button>
				))}
			</nav>
			<section
				data-testid="price-preview"
				aria-label="Selected model price preview"
			>
				{selected ? <ModelHoverPreview insight={selected} /> : null}
			</section>
		</main>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing presentation fixture root");
createRoot(root).render(<ModelPricingProof />);
