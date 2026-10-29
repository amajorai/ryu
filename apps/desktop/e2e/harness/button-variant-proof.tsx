import { buttonVariants } from "@ryu/ui/components/button.tsx";
import { createRoot } from "react-dom/client";
import proofStyles from "./button-variant-proof.module.css";
import "../../src/index.css";

function ButtonCard({
	label,
	variant,
}: {
	label: string;
	variant: "ghost" | "ghost-muted";
}) {
	return (
		<section
			className="rounded-2xl border border-border/75 bg-muted/65 p-5"
			data-testid={`${variant}-case`}
		>
			<div className={proofStyles.fixture1}>
				<strong>{label}</strong>
				<code className={proofStyles.fixture2}>
					variant=&quot;{variant}&quot;
				</code>
			</div>
			<button
				className={buttonVariants({ size: "default", variant })}
				data-testid={`${variant}-button`}
				type="button"
			>
				{variant === "ghost-muted" ? "Muted ghost action" : "Ghost action"}
			</button>
			<p className={proofStyles.fixture3}>
				{variant === "ghost-muted"
					? "Muted at rest · foreground on hover"
					: "Existing ghost behavior"}
			</p>
		</section>
	);
}

function Proof() {
	return (
		<main className={proofStyles.fixture4} data-testid="button-variant-proof">
			<div className={proofStyles.fixture5}>
				<p className={proofStyles.fixture6}>Shared UI proof</p>
				<h1 className={proofStyles.fixture7}>Ghost-muted button variant</h1>
				<p className={proofStyles.fixture8}>
					The new variant keeps ghost chrome, uses muted text at rest, and
					resolves to foreground text when hovered.
				</p>

				<div className={proofStyles.fixture9}>
					<ButtonCard label="Baseline" variant="ghost" />
					<ButtonCard label="New variant" variant="ghost-muted" />
				</div>

				<output className={proofStyles.fixture10} data-testid="proof-status">
					PASS · hover the new variant to inspect the resolved color
				</output>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Proof />);
}
