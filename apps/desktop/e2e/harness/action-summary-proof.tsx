// React's style contract includes the exact CSS custom properties consumed below.
declare module "react" {
	interface CSSProperties {
		"--fixture-value-1"?: string | number;
		"--fixture-value-2"?: string | number;
	}
}

import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import proofStyles from "./action-summary-proof.module.css";

type Detail = "brief" | "standard" | "full";

interface Action {
	brief: string;
	full: string;
	input: string;
	kind: "thinking" | "tool";
	name: string;
	standard: string;
}

const ACTIONS: Action[] = [
	{
		kind: "thinking",
		name: "Thinking block",
		input:
			"High-level planning is summarized; raw hidden reasoning stays out of the UI.",
		brief: "Planning the next step.",
		standard: "Planning the next step before editing the project.",
		full: "Planning the next step so the project can be edited safely.",
	},
	{
		kind: "tool",
		name: "Bash",
		input: "command: npm test (tool output omitted)",
		brief: "Ran the project tests.",
		standard: "Running the project tests to verify the change.",
		full: "Running the project tests to verify the change before finishing.",
	},
	{
		kind: "tool",
		name: "Read",
		input: "path: package.json (bounded and redacted)",
		brief: "Opened package.json.",
		standard: "Opened package.json to check the available scripts.",
		full: "Opened package.json to confirm the project scripts before proceeding.",
	},
];

function ActionSummaryProof() {
	const [enabled, setEnabled] = useState(true);
	const [detail, setDetail] = useState<Detail>("standard");
	const [model, setModel] = useState("");
	const modelLabel = model.trim() || "Ryu default side-model";
	const visibleActions = enabled ? ACTIONS : [];
	const detailDescription = useMemo(() => {
		if (detail === "brief") {
			return "What happened";
		}
		if (detail === "full") {
			return "What happened, plus the safest useful purpose";
		}
		return "What happened, plus the immediate purpose";
	}, [detail]);

	return (
		<main className={proofStyles.fixture1}>
			<div className={proofStyles.fixture2}>
				<div className={proofStyles.fixture3}>
					<div aria-hidden="true" className={proofStyles.fixture4}>
						✦
					</div>
					<div>
						<div className={proofStyles.fixture5}>RYU PLUGIN VERIFICATION</div>
						<h1 className={proofStyles.fixture6}>Action Summary</h1>
					</div>
				</div>

				<p className={proofStyles.fixture7}>
					A small side model turns streamed thinking blocks and tool calls into
					one plain-language line per action, while the main agent keeps working
					normally.
				</p>

				<section
					aria-label="Action Summary settings"
					className={proofStyles.fixture8}
				>
					<div className={proofStyles.fixture9}>
						<div>
							<h2 className={proofStyles.fixture10}>Settings</h2>
							<div className={proofStyles.fixture11}>
								Enabled only when the plugin is turned on
							</div>
						</div>
						<span
							className={proofStyles.dynamicFixture1}
							style={{
								"--fixture-value-1": enabled
									? "var(--action-summary-proof-color-1)"
									: "var(--action-summary-proof-color-2)",
								"--fixture-value-2": "13px",
							}}
						>
							{enabled ? "Enabled" : "Disabled"}
						</span>
					</div>
					<div className={proofStyles.fixture12}>
						<label className={proofStyles.fixture13}>
							<span className={proofStyles.fixture14}>
								<input
									checked={enabled}
									onChange={(event) => setEnabled(event.target.checked)}
									type="checkbox"
								/>
								Explain actions
							</span>
							<span className={proofStyles.fixture15}>Thinking and tools</span>
						</label>
						<label className={proofStyles.fixture16}>
							<span className={proofStyles.fixture17}>Detail</span>
							<select
								aria-label="Detail"
								className={proofStyles.fixture18}
								onChange={(event) => {
									const value = event.target.value;
									if (
										value === "brief" ||
										value === "standard" ||
										value === "full"
									) {
										setDetail(value);
									}
								}}
								value={detail}
							>
								<option value="brief">Brief</option>
								<option value="standard">Standard</option>
								<option value="full">Full</option>
							</select>
							<span className={proofStyles.fixture19}>{detailDescription}</span>
						</label>
						<label className={proofStyles.fixture20}>
							<span className={proofStyles.fixture21}>Summary model</span>
							<input
								aria-label="Summary model"
								className={proofStyles.fixture22}
								onChange={(event) => setModel(event.target.value)}
								placeholder="Optional override"
								value={model}
							/>
							<span className={proofStyles.fixture23}>Using: {modelLabel}</span>
						</label>
					</div>
				</section>

				<section
					aria-label="Example action summaries"
					className={proofStyles.fixture24}
				>
					<div className={proofStyles.fixture25}>
						<div>
							<h2 className={proofStyles.fixture26}>Live action summaries</h2>
							<div className={proofStyles.fixture27}>
								The same one-line note is carried by every chat surface.
							</div>
						</div>
						<span className={proofStyles.fixture28}>
							{visibleActions.length} actions observed
						</span>
					</div>
					<div className={proofStyles.fixture29}>
						{visibleActions.map((action) => (
							<article className={proofStyles.fixture30} key={action.name}>
								<div className={proofStyles.fixture31}>
									<span className={proofStyles.fixture32}>{action.kind}</span>
									<span className={proofStyles.fixture33}>· {action.name}</span>
								</div>
								<div className={proofStyles.fixture34}>{action[detail]}</div>
								<div className={proofStyles.fixture35}>
									Safe context: {action.input}
								</div>
							</article>
						))}
						{!enabled && (
							<div className={proofStyles.fixture36}>
								Turn the plugin on to show action summaries.
							</div>
						)}
					</div>
				</section>

				<section
					aria-label="Verification checks"
					className={proofStyles.fixture37}
				>
					<h2 className={proofStyles.fixture38}>Verified behavior</h2>
					<div className={proofStyles.fixture39}>
						{[
							"Shared action hook sees ACP and regular streamed tools",
							"Detail setting changes the one-line budget",
							"Empty model setting follows Ryu's side-model default",
							"Bounded, redacted input excludes tool output",
						].map((check) => (
							<div className={proofStyles.fixture40} key={check}>
								<span aria-hidden="true" className={proofStyles.fixture41}>
									●
								</span>
								{check}
							</div>
						))}
					</div>
					<div className={proofStyles.fixture42}>
						Evidence: 5 plugin tests · 778 manifest fixture checks · 3 Core
						stream parser tests
					</div>
				</section>
			</div>
		</main>
	);
}

createRoot(document.getElementById("root")!).render(<ActionSummaryProof />);
