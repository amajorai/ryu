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

import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import proofStyles from "./codex-quota-reset-watch-proof.module.css";

type CheckState = "baseline" | "unchanged" | "changed" | "outage";

const SOURCE_URL = "https://codex-resets.com/";

interface CheckStatePresentation {
	body: string;
	label: string;
	title: string;
	tone: string;
}
const states = {
	baseline: {
		body: "The current snapshot is stored. No notification is sent for the first check.",
		label: "BASELINE",
		tone: "var(--codex-quota-state-tone-1)",
		title: "Baseline recorded",
	},
	unchanged: {
		body: "The normalized forecast matches the last snapshot. The 30-minute check stays quiet.",
		label: "NO CHANGE",
		tone: "var(--codex-quota-state-tone-2)",
		title: "No alert",
	},
	changed: {
		body: "A monitored signal changed. The agent reports old/new values and sends notify.desktop.",
		label: "MATERIAL CHANGE",
		tone: "var(--codex-quota-state-tone-3)",
		title: "Desktop notification sent",
	},
	outage: {
		body: "The public source could not be verified. The agent alerts once, keeps the last good snapshot, and alerts again on recovery.",
		label: "SOURCE OUTAGE",
		tone: "var(--codex-quota-state-tone-4)",
		title: "Verification needed",
	},
} satisfies Record<CheckState, CheckStatePresentation>;

function Metric({ label, value }: { label: string; value: string }) {
	return (
		<div className={proofStyles.fixture1}>
			<div className={proofStyles.fixture2}>{label}</div>
			<div className={proofStyles.fixture3}>{value}</div>
		</div>
	);
}

function App() {
	const [checkState, setCheckState] = useState<CheckState>("changed");
	const activeState = states[checkState];
	const stateButtons = useMemo(
		() =>
			[
				["baseline", "First check"],
				["unchanged", "No change"],
				["changed", "Forecast changed"],
				["outage", "Source outage"],
			] as const,
		[]
	);

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
							<h1 className={proofStyles.fixture9}>Codex Quota Reset Watch</h1>
						</div>
					</div>
					<p className={proofStyles.fixture10}>
						A first-party marketplace agent that checks the public reset
						forecast every 30 minutes, compares it with its last snapshot, and
						tells the user only when something meaningful changes.
					</p>
				</header>

				<section
					aria-label="Template summary"
					className={proofStyles.fixture11}
				>
					<Metric label="Marketplace id" value="ryu/codex-quota-reset-watch" />
					<Metric label="Cadence" value="Every 30m" />
					<Metric label="Tools" value="3 built-ins" />
					<Metric label="Approval" value="Off" />
				</section>

				<section aria-label="Monitoring flow" className={proofStyles.fixture12}>
					<div className={proofStyles.fixture13}>Monitoring loop</div>
					<div className={proofStyles.fixture14}>
						{[
							["01", "Fetch", "web_fetch.get", "Read the public page."],
							[
								"02",
								"Normalize",
								"forecast fields",
								"Ignore the moving checked time.",
							],
							["03", "Compare", "memory.search", "Match the latest snapshot."],
							[
								"04",
								"Alert",
								"notify.desktop",
								"Tell the user on a real change.",
							],
						].map(([number, title, tool, detail]) => (
							<div className={proofStyles.fixture15} key={number}>
								<div className={proofStyles.fixture16}>{number}</div>
								<div className={proofStyles.fixture17}>{title}</div>
								<code className={proofStyles.fixture18}>{tool}</code>
								<div className={proofStyles.fixture19}>{detail}</div>
							</div>
						))}
					</div>
				</section>

				<section aria-label="Observed source" className={proofStyles.fixture20}>
					<div className={proofStyles.fixture21}>
						<div className={proofStyles.fixture22}>Live source snapshot</div>
						<a
							className={proofStyles.fixture23}
							href={SOURCE_URL}
							rel="noopener"
							target="_blank"
						>
							codex-resets.com ↗
						</a>
						<div className={proofStyles.fixture24}>
							<div>
								<div className={proofStyles.fixture25}>Reset likelihood</div>
								<div className={proofStyles.fixture26}>36%</div>
							</div>
							<div className={proofStyles.fixture27}>
								<div className={proofStyles.fixture28}>Do not force it.</div>
								<div className={proofStyles.fixture29}>
									Observed public guidance · last checked 03:48 PM
								</div>
							</div>
						</div>
						<div className={proofStyles.fixture30}>
							The watcher preserves the site's caveat: this is a public
							forecast, not an official OpenAI reset signal.
						</div>
					</div>

					<div className={proofStyles.fixture31}>
						<div className={proofStyles.fixture32}>Alert policy preview</div>
						<div className={proofStyles.fixture33}>Simulate the next check</div>
						<div className={proofStyles.fixture34}>
							{stateButtons.map(([value, label]) => (
								<button
									className={proofStyles.dynamicFixture1}
									key={value}
									onClick={() => setCheckState(value)}
									style={{
										"--fixture-value-1":
											checkState === value
												? "var(--codex-quota-reset-watch-proof-color-1)"
												: "var(--codex-quota-reset-watch-proof-color-2)",
										"--fixture-value-2": `1px solid ${checkState === value ? "var(--codex-quota-reset-watch-proof-color-3)" : "var(--codex-quota-reset-watch-proof-color-4)"}`,
										"--fixture-value-3": "999px",
										"--fixture-value-4":
											checkState === value
												? "var(--codex-quota-reset-watch-proof-color-5)"
												: "var(--codex-quota-reset-watch-proof-color-6)",
										"--fixture-value-5": "pointer",
										"--fixture-value-6": "12px",
										"--fixture-value-7": "7px 10px",
									}}
									type="button"
								>
									{label}
								</button>
							))}
						</div>
						<div
							className={proofStyles.dynamicFixture2}
							data-testid="alert-policy-result"
							style={{
								"--fixture-value-8": `3px solid ${activeState.tone}`,
								"--fixture-value-9": "20px",
								"--fixture-value-10": "13px",
							}}
						>
							<div
								className={proofStyles.dynamicFixture3}
								style={{
									"--fixture-value-11": activeState.tone,
									"--fixture-value-12": "11px",
									"--fixture-value-13": 750,
									"--fixture-value-14": "0.12em",
								}}
							>
								{activeState.label}
							</div>
							<div className={proofStyles.fixture35}>{activeState.title}</div>
							<div className={proofStyles.fixture36}>{activeState.body}</div>
						</div>
					</div>
				</section>

				<section
					aria-label="Verification evidence"
					className={proofStyles.fixture37}
					data-testid="verification-evidence"
				>
					<div className={proofStyles.fixture38}>
						<div className={proofStyles.fixture39}>Verification evidence</div>
						<span className={proofStyles.fixture40} data-testid="proof-status">
							READY
						</span>
					</div>
					<ul className={proofStyles.fixture41}>
						<li>
							✓ First-party seed: <code>ryu/codex-quota-reset-watch</code>
						</li>
						<li>
							✓ Read-only fetch + durable snapshot memory + desktop notification
						</li>
						<li>✓ One enabled background schedule: every 30 minutes</li>
						<li>
							✓ Baseline, unchanged, change, outage, and recovery paths are
							explicit
						</li>
					</ul>
				</section>

				<footer className={proofStyles.fixture42}>
					Forecast source observed in the browser before this proof was
					rendered. The agent never claims an official OpenAI quota reset.
				</footer>
			</div>
		</main>
	);
}

type ProofRuntime = typeof globalThis & {
	__codexQuotaResetWatchRoot?: ReturnType<typeof createRoot>;
};

const proofRootElement = document.getElementById("root");
if (!proofRootElement) {
	throw new Error("Codex Quota Reset Watch proof root is missing");
}

// SAFETY: This fixture installs and reuses only its own optional React root handle below.
const proofRuntime = globalThis as ProofRuntime;
const proofRoot =
	proofRuntime.__codexQuotaResetWatchRoot ?? createRoot(proofRootElement);
proofRuntime.__codexQuotaResetWatchRoot = proofRoot;
proofRoot.render(<App />);
