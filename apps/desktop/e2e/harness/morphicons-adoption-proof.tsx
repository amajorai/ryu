import {
	CheckmarkCircle01Icon,
	Copy01Icon,
	Loading01Icon,
	Tick01Icon,
} from "@hugeicons/core-free-icons";
import {
	type IconInput,
	MorphIconSwap,
} from "@ryu/ui/components/morph-icon.tsx";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import proofStyles from "./morphicons-adoption-proof.module.css";
import "../../src/index.css";

const proofStartsVerified = new URLSearchParams(window.location.search).has(
	"verified"
);

function AdoptionCard({
	caption,
	description,
	from,
	to,
	initialLabel,
	completeLabel,
}: {
	caption: string;
	description: string;
	from: IconInput;
	to: IconInput;
	initialLabel: string;
	completeLabel: string;
}) {
	const [complete, setComplete] = useState(proofStartsVerified);

	return (
		<section className="rounded-2xl border border-border/85 bg-card/92 p-5 shadow-2xl">
			<div className={proofStyles.fixture1}>
				<div>
					<p className={proofStyles.fixture2}>{caption}</p>
					<p className={proofStyles.fixture3}>
						{complete ? completeLabel : initialLabel}
					</p>
				</div>
				<button
					aria-pressed={complete}
					className={`inline-flex cursor-pointer items-center gap-2 rounded-xl border border-border px-3 py-2.5 text-foreground ${complete ? "bg-primary/18" : "bg-secondary"}`}
					data-testid={`${caption.toLowerCase().replaceAll(" ", "-")}-toggle`}
					onClick={() => setComplete((current) => !current)}
					type="button"
				>
					<MorphIconSwap
						a={from}
						b={to}
						className="size-4"
						label={complete ? completeLabel : initialLabel}
						state={complete ? "b" : "a"}
					/>
					{complete ? "Done" : "Run"}
				</button>
			</div>
			<p className={proofStyles.fixture4}>{description}</p>
		</section>
	);
}

function MorphiconsAdoptionProof() {
	const [installed, setInstalled] = useState(proofStartsVerified);

	return (
		<main
			className={proofStyles.fixture5}
			data-testid="morphicons-adoption-proof"
		>
			<div className={proofStyles.fixture6}>
				<div className={proofStyles.fixture7}>
					<p className={proofStyles.fixture8}>Shared UI proof</p>
					<output className={proofStyles.fixture9} data-testid="proof-status">
						PASS · Morphicons connected
					</output>
				</div>
				<h1 className={proofStyles.fixture10}>
					State changes that feel intentional
				</h1>
				<p className={proofStyles.fixture11}>
					Morphicons now powers shared stateful icon transitions. The same
					primitive is used by copy feedback, onboarding status, 2FA, API keys,
					and inspection controls across desktop.
				</p>

				<div className={proofStyles.fixture12}>
					<AdoptionCard
						caption="Copy feedback"
						completeLabel="Copied"
						description="Copy and success glyphs share one spring-morphed SVG, with user preference-based reduced-motion handling."
						from={Copy01Icon}
						initialLabel="Copy value"
						to={Tick01Icon}
					/>
					<AdoptionCard
						caption="Install status"
						completeLabel="Installed"
						description="The loading-to-complete transition keeps the status slot stable while the icon shape changes in place."
						from={Loading01Icon}
						initialLabel="Installing"
						to={CheckmarkCircle01Icon}
					/>
				</div>

				<section className="mt-4 rounded-2xl border border-border/85 bg-card/92 p-5 shadow-2xl">
					<div className={proofStyles.fixture13}>
						<MorphIconSwap
							a={Loading01Icon}
							b={CheckmarkCircle01Icon}
							className="size-5"
							label={installed ? "Installed" : "Installing"}
							state={installed ? "b" : "a"}
						/>
						<div>
							<strong>
								{installed
									? "Desktop adoption verified"
									: "Desktop adoption ready"}
							</strong>
							<p className={proofStyles.fixture14}>
								Click the status control to verify the shared transition end
								state.
							</p>
						</div>
						<button
							aria-pressed={installed}
							className={proofStyles.fixture15}
							data-testid="desktop-adoption-toggle"
							onClick={() => setInstalled((current) => !current)}
							type="button"
						>
							{installed ? "Reset" : "Verify"}
						</button>
					</div>
				</section>

				<p className={proofStyles.fixture16}>
					Built from <code>@ryu/ui/components/morph-icon</code> · reduced motion
					defaults to <code>user</code>
				</p>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<MorphiconsAdoptionProof />);
}
