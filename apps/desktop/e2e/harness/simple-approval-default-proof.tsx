import { selectSimpleApprovalValue } from "@ryu/blocks/composer/composer-acp-sections.ts";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	type ChatRoutingSelections,
	modelRoutingFieldsForInterface,
} from "../../src/lib/chat-routing.ts";
import "../../src/index.css";

const scenarios = {
	auto: {
		description: "The agent advertises a literal Auto preset.",
		label: "Auto advertised",
		options: [
			{ id: "default", name: "Ask for approval" },
			{ id: "auto", name: "Auto" },
			{ id: "full", name: "Full access" },
		],
	},
	approval: {
		description:
			"No Auto preset is available, so Simple keeps approval explicit.",
		label: "Approval fallback",
		options: [
			{ id: "approval_required", name: "Ask for approval" },
			{ id: "bypass", name: "Bypass permissions" },
		],
	},
	none: {
		description: "No recognizable safe preset is advertised by this agent.",
		label: "Agent default",
		options: [
			{ id: "custom", name: "Managed policy" },
			{ id: "full", name: "Full access" },
		],
	},
} as const;

type ScenarioId = keyof typeof scenarios;

const hiddenSelections: ChatRoutingSelections = {
	acpConfig: { effort: "high", provider: "hidden-provider" },
	acpMode: "bypass",
	acpModel: "hidden-acp-model",
	model: "gpt-5",
};

function Story() {
	const [scenarioId, setScenarioId] = useState<ScenarioId>("auto");
	const scenario = scenarios[scenarioId];
	const selectedMode = useMemo(
		() => selectSimpleApprovalValue(scenario.options),
		[scenario.options]
	);
	const fields = useMemo(
		() =>
			modelRoutingFieldsForInterface("simple", {
				...hiddenSelections,
				simpleApprovalDefaults: {
					config: selectedMode ? { approval_policy: selectedMode } : {},
					mode: selectedMode,
				},
			}),
		[selectedMode]
	);

	return (
		<main className="min-h-screen bg-background px-6 py-10 text-foreground">
			<div className="mx-auto max-w-5xl space-y-6">
				<header className="space-y-2">
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
						Completed feature proof
					</p>
					<h1 className="font-semibold text-3xl tracking-tight">
						Simple mode · safe agent defaults
					</h1>
					<p className="max-w-3xl text-muted-foreground text-sm">
						Simple keeps the selected agent and hides model controls. When an
						ACP agent advertises Auto, it is selected quietly; otherwise Simple
						falls back to approval or leaves the agent/Core default in force.
					</p>
				</header>

				<section className="rounded-2xl border bg-card p-5 shadow-sm">
					<div className="flex flex-wrap items-center justify-between gap-4">
						<div>
							<p className="font-medium">Advertised permission presets</p>
							<p className="mt-1 text-muted-foreground text-xs">
								The default is derived only from values the agent exposes.
							</p>
						</div>
						<div
							aria-label="Proof scenario"
							className="flex gap-2"
							role="group"
						>
							{Object.entries(scenarios).map(([id, option]) => (
								<button
									className={`rounded-lg px-3 py-2 text-sm ${scenarioId === id ? "bg-primary text-primary-foreground" : "bg-muted"}`}
									data-testid={`scenario-${id}`}
									key={id}
									onClick={() =>
										setScenarioId(
											/* SAFETY: Object.entries reads the exact private authored scenarios keys auto/approval/none; no code mutates that catalog, and ScenarioId is its native keyof domain. */ id as ScenarioId
										)
									}
									type="button"
								>
									{option.label}
								</button>
							))}
						</div>
					</div>

					<div className="mt-5 grid gap-3 md:grid-cols-3">
						{scenario.options.map((option) => (
							<div
								className="rounded-xl border bg-muted/35 p-3"
								key={option.id}
							>
								<p className="font-mono text-muted-foreground text-xs">
									{option.id}
								</p>
								<p className="mt-1 font-medium text-sm">{option.name}</p>
							</div>
						))}
					</div>

					<div className="mt-5 grid gap-4 md:grid-cols-2">
						<div className="rounded-xl border border-primary/30 bg-primary/5 p-4">
							<p className="text-muted-foreground text-xs">
								Derived Simple default
							</p>
							<p
								className="mt-2 font-semibold text-xl"
								data-testid="derived-default"
							>
								{selectedMode ?? "Agent/Core default"}
							</p>
							<p className="mt-2 text-muted-foreground text-xs">
								{scenario.description}
							</p>
						</div>
						<div className="rounded-xl border bg-muted/35 p-4">
							<p className="text-muted-foreground text-xs">Selected agent</p>
							<p className="mt-2 font-semibold text-xl">Ryu</p>
							<p className="mt-2 text-muted-foreground text-xs">
								The Simple default never swaps the user-selected agent to the
								separate
								<code>auto</code> routing sentinel.
							</p>
						</div>
					</div>
				</section>

				<section
					className="rounded-2xl border bg-card p-5 shadow-sm"
					data-testid="request-boundary"
				>
					<div className="flex flex-wrap items-center justify-between gap-3">
						<div>
							<p className="font-medium">Request boundary</p>
							<p className="mt-1 text-muted-foreground text-xs">
								Hidden model, effort, and permissive pins stay out of Simple
								requests.
							</p>
						</div>
						<span className="rounded-full bg-success/10 px-3 py-1 font-medium text-success text-xs dark:text-success">
							Safe fields only
						</span>
					</div>
					<pre
						className="mt-4 overflow-auto rounded-xl border bg-muted/40 p-4 font-mono text-xs"
						data-testid="routing-fields"
					>
						{JSON.stringify(fields, null, 2)}
					</pre>
				</section>

				<p className="text-muted-foreground text-xs" data-testid="proof-status">
					Proof status: advertised Auto → Auto; no Auto → approval fallback; no
					safe preset → agent/Core default.
				</p>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
