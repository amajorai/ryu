// React's style contract includes the exact CSS custom properties consumed below.
declare module "react" {
	interface CSSProperties {
		"--fixture-value-1"?: string | number;
		"--fixture-value-2"?: string | number;
		"--fixture-value-3"?: string | number;
		"--fixture-value-4"?: string | number;
		"--fixture-value-5"?: string | number;
		"--fixture-value-6"?: string | number;
		"--fixture-value-7"?: string | number;
		"--fixture-value-8"?: string | number;
		"--fixture-value-9"?: string | number;
		"--fixture-value-10"?: string | number;
		"--fixture-value-11"?: string | number;
		"--fixture-value-12"?: string | number;
		"--fixture-value-13"?: string | number;
		"--fixture-value-14"?: string | number;
	}
}

import { useState } from "react";
import { createRoot } from "react-dom/client";
import proofStyles from "./usage-pacer-proof.module.css";

type Provider = "claude" | "codex";
type ScenarioId = "normal" | "remaining" | "day" | "hour";

interface Scenario {
	description: string;
	id: ScenarioId;
	label: string;
	model: string;
	remaining: string;
	reset: string;
}

interface Directive {
	acp_config?: Record<string, string>;
	effort?: string;
	kind: "none" | "select_model";
	model?: string;
}

const SCENARIOS: Scenario[] = [
	{
		description:
			"No end-window trigger; the ordinary pacing ladder remains in charge.",
		id: "normal",
		label: "Normal window",
		model: "sonnet",
		remaining: "64%",
		reset: "4d 11h",
	},
	{
		description: "The reverse ladder upgrades the current sonnet turn to opus.",
		id: "remaining",
		label: "20% quota left",
		model: "sonnet",
		remaining: "18%",
		reset: "2d 03h",
	},
	{
		description:
			"Within one day of reset, the ACP fast-mode option is selected.",
		id: "day",
		label: "1 day to reset",
		model: "opus",
		remaining: "42%",
		reset: "18h",
	},
	{
		description:
			"The final hour combines fast mode with high reasoning effort.",
		id: "hour",
		label: "1 hour to reset",
		model: "opus",
		remaining: "5%",
		reset: "45m",
	},
];

interface ProviderPresentation {
	label: string;
	optionId: string;
}
const PROVIDERS = {
	claude: { label: "Claude ACP", optionId: "fast" },
	codex: { label: "Codex ACP", optionId: "fast-mode" },
} satisfies Record<Provider, ProviderPresentation>;

function directiveFor(scenario: ScenarioId, provider: Provider): Directive {
	if (scenario === "normal") {
		return { kind: "none" };
	}

	if (scenario === "remaining") {
		return { kind: "select_model", model: "opus" };
	}

	const directive: Directive = {
		acp_config: { [PROVIDERS[provider].optionId]: "true" },
		kind: "select_model",
		model: "opus",
	};
	if (scenario === "hour") {
		directive.effort = "high";
	}
	return directive;
}

function formatDirective(directive: Directive): string {
	return JSON.stringify(directive, null, 2);
}

function Metric({ label, value }: { label: string; value: string }) {
	return (
		<div className={proofStyles.fixture1}>
			<div className={proofStyles.fixture2}>{label}</div>
			<div className={proofStyles.fixture3}>{value}</div>
		</div>
	);
}

function UsagePacerProof() {
	const [scenarioId, setScenarioId] = useState<ScenarioId>("hour");
	const [provider, setProvider] = useState<Provider>("claude");
	const scenario =
		SCENARIOS.find((item) => item.id === scenarioId) ?? SCENARIOS[0];
	const directive = directiveFor(scenario.id, provider);
	const providerInfo = PROVIDERS[provider];

	return (
		<main className={proofStyles.fixture4}>
			<div className={proofStyles.fixture5}>
				<header>
					<div className={proofStyles.fixture6}>
						<div aria-hidden="true" className={proofStyles.fixture7}>
							↗
						</div>
						<div>
							<div className={proofStyles.fixture8}>
								VERIFIED REACT ARTIFACT
							</div>
							<h1 className={proofStyles.fixture9}>
								Usage Pacer · reverse quota policy
							</h1>
						</div>
					</div>
					<p className={proofStyles.fixture10}>
						When a subscription window is nearly spent or close to reset, the
						plugin can move back up the model ladder and request provider fast
						mode for this turn.
					</p>
				</header>

				<section
					aria-label="Verification summary"
					className={proofStyles.fixture11}
				>
					<Metric label="Hook tests" value="10 / 10 passed" />
					<Metric label="Core route" value="ACP merge passed" />
					<Metric label="Codex ACP" value="fast-mode" />
					<Metric label="Claude ACP" value="fast" />
				</section>

				<section
					aria-label="Usage window scenarios"
					className={proofStyles.fixture12}
				>
					<div className={proofStyles.fixture13}>
						<div>
							<h2 className={proofStyles.fixture14}>Policy simulator</h2>
							<div className={proofStyles.fixture15}>
								Select the usage boundary that the tests exercise.
							</div>
						</div>
						<div className={proofStyles.fixture16}>Upgrade wins fallback</div>
					</div>
					<div className={proofStyles.fixture17}>
						{SCENARIOS.map((item) => {
							const selected = item.id === scenario.id;
							return (
								<button
									aria-pressed={selected}
									className={proofStyles.dynamicFixture1}
									data-testid={`scenario-${item.id}`}
									key={item.id}
									onClick={() => setScenarioId(item.id)}
									style={{
										"--fixture-value-1": selected
											? "var(--usage-pacer-proof-color-1)"
											: "var(--usage-pacer-proof-color-2)",
										"--fixture-value-2": `1px solid ${selected ? "var(--usage-pacer-proof-color-3)" : "var(--usage-pacer-proof-color-4)"}`,
										"--fixture-value-3": "9px",
										"--fixture-value-4": selected
											? "var(--usage-pacer-proof-color-5)"
											: "var(--usage-pacer-proof-color-6)",
										"--fixture-value-5": "pointer",
										"--fixture-value-6": "13px",
										"--fixture-value-7": "9px 12px",
									}}
									type="button"
								>
									{item.label}
								</button>
							);
						})}
					</div>
				</section>

				<section
					aria-label="Selected usage window"
					className={proofStyles.fixture18}
				>
					<div className={proofStyles.fixture19}>
						<div>
							<div className={proofStyles.fixture20}>Current boundary</div>
							<div className={proofStyles.fixture21}>{scenario.label}</div>
							<div className={proofStyles.fixture22}>
								{scenario.description}
							</div>
						</div>
						<div>
							<div className={proofStyles.fixture23}>Quota left</div>
							<strong className={proofStyles.fixture24}>
								{scenario.remaining}
							</strong>
						</div>
						<div>
							<div className={proofStyles.fixture25}>Reset in</div>
							<strong className={proofStyles.fixture26}>
								{scenario.reset}
							</strong>
						</div>
						<div>
							<div className={proofStyles.fixture27}>Current model</div>
							<strong className={proofStyles.fixture28}>
								{scenario.model}
							</strong>
						</div>
					</div>
				</section>

				<section
					aria-label="Provider fast mode"
					className={proofStyles.fixture29}
				>
					<div className={proofStyles.fixture30}>
						<div>
							<h2 className={proofStyles.fixture31}>ACP provider mapping</h2>
							<div className={proofStyles.fixture32}>
								Fast mode is exposed as a provider-specific session config
								option.
							</div>
						</div>
						<div className={proofStyles.fixture33}>
							{(["claude", "codex"] as const).map((item) => {
								const selected = provider === item;
								return (
									<button
										aria-pressed={selected}
										className={proofStyles.dynamicFixture2}
										key={item}
										onClick={() => setProvider(item)}
										style={{
											"--fixture-value-8": selected
												? "var(--usage-pacer-proof-color-7)"
												: "var(--usage-pacer-proof-color-2)",
											"--fixture-value-9": `1px solid ${selected ? "var(--usage-pacer-proof-color-8)" : "var(--usage-pacer-proof-color-4)"}`,
											"--fixture-value-10": "8px",
											"--fixture-value-11": selected
												? "var(--usage-pacer-proof-color-9)"
												: "var(--usage-pacer-proof-color-10)",
											"--fixture-value-12": "pointer",
											"--fixture-value-13": "12px",
											"--fixture-value-14": "8px 10px",
										}}
										type="button"
									>
										{PROVIDERS[item].label}
									</button>
								);
							})}
						</div>
					</div>

					<div className={proofStyles.fixture34}>
						<div className={proofStyles.fixture35}>
							<div className={proofStyles.fixture36}>{providerInfo.label}</div>
							<h3 className={proofStyles.fixture37}>{providerInfo.optionId}</h3>
							<p className={proofStyles.fixture38}>
								Readable rule key <code>fast_mode</code> is translated to the
								adapter's advertised id and sent only for this turn.
							</p>
						</div>
						<div className={proofStyles.fixture39}>
							<div className={proofStyles.fixture40}>
								Selected directive · {scenario.label}
							</div>
							<pre
								className={proofStyles.fixture41}
								data-testid="directive-output"
							>
								{formatDirective(directive)}
							</pre>
						</div>
					</div>
				</section>

				<footer className={proofStyles.fixture42}>
					<strong className={proofStyles.fixture43}>Evidence:</strong> 10 Usage
					Pacer hook tests, the Core ACP merge test, and the existing ACP
					boolean transport test passed. Unknown provider options remain
					best-effort, so an adapter that does not advertise fast mode continues
					normally.
				</footer>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	// SAFETY: This fixture installs and reuses only its own optional React root handle below.
	const globals = globalThis as typeof globalThis & {
		__usagePacerRoot?: ReturnType<typeof createRoot>;
	};
	const reactRoot = globals.__usagePacerRoot ?? createRoot(root);
	globals.__usagePacerRoot = reactRoot;
	reactRoot.render(<UsagePacerProof />);
}
