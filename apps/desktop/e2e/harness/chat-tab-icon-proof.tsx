import { Comment02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { TabGlyph } from "../../src/components/layout/TitleBar.tsx";
import "../../src/index.css";

function svgSignature(element: SVGElement | null): string | null {
	return element?.innerHTML ?? null;
}

function ProofArtifact() {
	const [iconsMatch, setIconsMatch] = useState(false);

	useEffect(() => {
		const check = () => {
			const actual = document.querySelector<SVGElement>(
				'[data-testid="actual-chat-icon"] svg'
			);
			const expected = document.querySelector<SVGElement>(
				'[data-testid="expected-chat-icon"] svg'
			);
			const actualSignature = svgSignature(actual);
			const expectedSignature = svgSignature(expected);
			if (actualSignature && expectedSignature) {
				setIconsMatch(actualSignature === expectedSignature);
			}
		};
		check();
		const frame = requestAnimationFrame(check);
		return () => cancelAnimationFrame(frame);
	}, []);

	return (
		<main className="min-h-screen bg-background p-8 text-foreground">
			<div className="mx-auto flex max-w-2xl flex-col gap-6">
				<header>
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
						React verification artifact
					</p>
					<h1 className="mt-2 font-semibold text-3xl tracking-tight">
						Chat tab icon
					</h1>
					<p className="mt-2 text-muted-foreground text-sm">
						The real desktop TabGlyph for <code>/chat</code> is compared with a
						direct <code>Comment02Icon</code> render.
					</p>
				</header>

				<section className="rounded-2xl border bg-card p-6 shadow-sm">
					<div className="flex items-center gap-3 rounded-xl border bg-muted/60 px-4 py-3">
						<span data-testid="actual-chat-icon">
							<TabGlyph className="size-5" logoSize="20px" path="/chat" />
						</span>
						<span className="font-medium">Chat</span>
					</div>

					<div className="mt-6 grid gap-4 sm:grid-cols-2">
						<div className="rounded-xl border p-4">
							<p className="text-muted-foreground text-xs">
								Rendered tab glyph
							</p>
							<div className="mt-3" data-testid="actual-chat-icon-preview">
								<TabGlyph className="size-8" logoSize="32px" path="/chat" />
							</div>
						</div>
						<div className="rounded-xl border p-4">
							<p className="text-muted-foreground text-xs">
								Expected Comment02Icon
							</p>
							<div className="mt-3" data-testid="expected-chat-icon">
								<HugeiconsIcon className="size-8" icon={Comment02Icon} />
							</div>
						</div>
					</div>

					<div
						className={`mt-6 rounded-xl border px-4 py-3 font-medium text-sm ${
							iconsMatch
								? "border-success/30 bg-success/10 text-success"
								: "border-warning/30 bg-warning/10 text-warning"
						}`}
						data-proof-status={iconsMatch ? "pass" : "pending"}
						data-testid="proof-status"
					>
						{iconsMatch ? "PASS · /chat uses Comment02Icon" : "PENDING"}
					</div>
				</section>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<ProofArtifact />);
}
