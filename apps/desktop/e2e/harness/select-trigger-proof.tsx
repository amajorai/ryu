import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { createRoot } from "react-dom/client";
import proofStyles from "./select-trigger-proof.module.css";
import "../../src/index.css";

function ChoiceSelect({
	explicitDefault = false,
}: {
	explicitDefault?: boolean;
}) {
	return (
		<Select defaultValue="project">
			<SelectTrigger
				data-testid={explicitDefault ? "filled-trigger" : "ghost-trigger"}
				variant={explicitDefault ? "default" : undefined}
			>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value="project">Project</SelectItem>
				<SelectItem value="workspace">Workspace</SelectItem>
			</SelectContent>
		</Select>
	);
}

function Proof() {
	return (
		<main className={proofStyles.fixture1} data-testid="select-trigger-proof">
			<div className={proofStyles.fixture2}>
				<p className={proofStyles.fixture3}>Shared UI proof</p>
				<h1 className={proofStyles.fixture4}>Select trigger background</h1>
				<p className={proofStyles.fixture5}>
					The default trigger is transparent at rest and reveals the muted
					surface on hover. An explicit default variant remains filled.
				</p>

				<div className={proofStyles.fixture6}>
					<section
						className="rounded-2xl border border-border/75 bg-muted/65 p-5"
						data-testid="ghost-case"
					>
						<strong>Default</strong>
						<p className={proofStyles.fixture7}>variant omitted → ghost</p>
						<ChoiceSelect />
					</section>
					<section
						className="rounded-2xl border border-border/75 bg-muted/65 p-5"
						data-testid="filled-case"
					>
						<strong>Explicit default</strong>
						<p className={proofStyles.fixture8}>
							variant=&quot;default&quot; → filled
						</p>
						<ChoiceSelect explicitDefault />
					</section>
				</div>

				<output className={proofStyles.fixture9} data-testid="proof-status">
					PASS · default trigger is ghost; hover it to inspect the surface
				</output>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Proof />);
}
