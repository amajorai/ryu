import "@fontsource-variable/geist-mono";
import { formatCount, formatCurrency } from "@ryu/ui/lib/number-format.ts";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { DiffStat } from "../../src/components/chat/WorkspacePicker.tsx";
import "../../src/index.css";

function GitLineStatsProof() {
	const [fontFamily, setFontFamily] = useState("pending");
	const [hasMonoFont, setHasMonoFont] = useState(false);

	useEffect(() => {
		const stat = document.querySelector<HTMLElement>(
			'[data-testid="git-line-stat"] > span'
		);
		if (!stat) {
			return;
		}
		const readFont = () => {
			setFontFamily(getComputedStyle(stat).fontFamily);
			setHasMonoFont(stat.classList.contains("font-mono"));
		};
		readFont();
		void document.fonts.ready.then(readFont);
	}, []);

	return (
		<main className="min-h-screen bg-background p-4 text-foreground">
			<div className="flex w-[1200px] max-w-none flex-col gap-4">
				<header className="space-y-1">
					<p className="font-heading font-semibold text-primary text-xs uppercase tracking-(--tracking-section)">
						Ryu · React proof
					</p>
					<h1 className="font-heading font-semibold text-2xl tracking-tight">
						Counts and money use readable compact notation
					</h1>
					<p className="text-muted-foreground text-sm">
						Website and desktop surfaces share comma-separated thousands and a
						lowercase <code>m</code> for millions.
					</p>
				</header>

				<section className="grid gap-3 sm:grid-cols-2">
					<div className="rounded-2xl border bg-card p-3 shadow-sm">
						<p className="text-muted-foreground text-xs">Website surface</p>
						<p className="mt-2 font-mono font-semibold text-2xl tabular-nums">
							{formatCurrency(1_234_567)}
						</p>
						<p className="mt-1 text-muted-foreground text-xs">
							{formatCount(1234)} files · {formatCount(1_234_567)} tokens
						</p>
					</div>

					<div className="rounded-2xl border bg-card p-3 shadow-sm">
						<p className="text-muted-foreground text-xs">Desktop surface</p>
						<div
							className="mt-2 flex min-h-8 items-center rounded-lg bg-muted/50 px-2"
							data-testid="git-line-stat"
						>
							<DiffStat stat={{ deletions: 999_999, insertions: 1_234_567 }} />
						</div>
						<p className="mt-1 text-muted-foreground text-xs">
							+1.2m insertions · −999,999 deletions
						</p>
					</div>
				</section>

				<section className="rounded-2xl border bg-card p-3 shadow-sm">
					<div className="flex items-center justify-between gap-4">
						<div>
							<p className="font-medium text-sm">Rendered verification</p>
							<p className="type-caption mt-1 text-muted-foreground">
								The browser reads the production node after fonts are ready.
							</p>
						</div>
						<output
							className="rounded-full bg-success/10 px-3 py-1.5 font-heading font-semibold text-success text-xs"
							data-testid="proof-status"
						>
							{hasMonoFont ? "Verified" : "Checking"}
						</output>
					</div>
					<dl className="mt-3 grid gap-2 border-border/60 border-t pt-3 text-xs sm:grid-cols-2">
						<div>
							<dt className="text-muted-foreground">Production class</dt>
							<dd
								className="mt-1 font-mono text-foreground"
								data-testid="git-class"
							>
								font-mono · tabular-nums
							</dd>
						</div>
						<div>
							<dt className="text-muted-foreground">Computed family</dt>
							<dd
								className="mt-1 font-mono text-foreground"
								data-testid="git-font-family"
							>
								{fontFamily}
							</dd>
						</div>
					</dl>
				</section>
			</div>
		</main>
	);
}

const proofRoot = document.getElementById("root");
if (!proofRoot) {
	throw new Error("Git line stats proof root is missing");
}

createRoot(proofRoot).render(<GitLineStatsProof />);
