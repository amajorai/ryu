import { cn } from "@ryu/ui/lib/utils.ts";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MorphingTabSurface } from "../../src/components/layout/MorphingTabSurface.tsx";
import {
	DEFAULT_FLOATING_TABS,
	FLOATING_TABS_KEY,
	useFloatingTabs,
} from "../../src/hooks/useFloatingTabs.ts";
import "../../src/index.css";

const TABS = [
	{ id: "inbox", label: "Inbox", icon: "✦" },
	{ id: "research", label: "Research", icon: "◌" },
	{ id: "drafts", label: "Drafts", icon: "□" },
] as const;

// Each fresh proof session starts from the shipped default, just like a fresh
// profile. The session guard keeps Vite hot updates from resetting an in-flight
// interaction. This is isolated to the harness origin (5177), never the desktop
// app origin.
const PROOF_RESET_KEY = "ryu:floating-tabs-proof-reset";
if (sessionStorage.getItem(PROOF_RESET_KEY) !== "true") {
	localStorage.removeItem(FLOATING_TABS_KEY);
	sessionStorage.setItem(PROOF_RESET_KEY, "true");
}

function PreviewTab({
	active,
	floatingTabs,
	label,
	onClick,
	icon,
}: {
	active: boolean;
	floatingTabs: boolean;
	label: string;
	onClick: () => void;
	icon: string;
}) {
	return (
		<button
			aria-pressed={active}
			className={cn(
				"relative isolate flex h-12 min-w-32 items-center gap-2 px-4 font-medium text-sm transition-colors",
				floatingTabs ? "rounded-full" : "rounded-t-(--radius-xl)",
				floatingTabs
					? active
						? "bg-muted text-foreground"
						: "text-muted-foreground hover:bg-muted/50"
					: active
						? "text-foreground"
						: "text-muted-foreground hover:bg-background/40"
			)}
			data-active={active}
			data-tab-appearance={floatingTabs ? "floating" : "morphing"}
			onClick={onClick}
			type="button"
		>
			<MorphingTabSurface floatingTabs={floatingTabs} isActive={active} />
			<span aria-hidden className="relative z-10 text-base">
				{icon}
			</span>
			<span className="relative z-10">{label}</span>
		</button>
	);
}

function ProofStory() {
	const [activeId, setActiveId] = useState(TABS[1].id);
	const [floatingTabs, setFloatingTabs] = useFloatingTabs();
	const [surfaceCount, setSurfaceCount] = useState(0);

	useEffect(() => {
		const update = () =>
			setSurfaceCount(
				document.querySelectorAll('[data-tab-surface="morphing"]').length
			);
		update();
		const observer = new MutationObserver(update);
		observer.observe(document.body, { childList: true, subtree: true });
		return () => observer.disconnect();
	}, []);

	const defaultOnPassed = DEFAULT_FLOATING_TABS && floatingTabs;
	const morphingOffPassed = !floatingTabs && surfaceCount === 1;
	const proofPassed = defaultOnPassed || morphingOffPassed;

	return (
		<main className="min-h-screen bg-background p-8 text-foreground">
			<div className="mx-auto flex max-w-4xl flex-col gap-6">
				<header className="flex flex-wrap items-start justify-between gap-4">
					<div>
						<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
							React verification artifact
						</p>
						<h1 className="mt-2 font-semibold text-3xl tracking-tight">
							Floating tabs
						</h1>
						<p className="mt-2 max-w-2xl text-muted-foreground text-sm leading-6">
							The shipped default keeps separate pills. Switch it off to let the
							active tab borrow the page surface, with the shared edge morphing
							as you move between tabs.
						</p>
					</div>
					<div
						className={cn(
							"rounded-full border px-3 py-1.5 font-medium text-xs",
							proofPassed
								? "border-success/30 bg-success/10 text-success"
								: "border-warning/30 bg-warning/10 text-warning"
						)}
						data-proof-status={proofPassed ? "pass" : "pending"}
						data-testid="proof-status"
					>
						{proofPassed ? "PASS · live interaction" : "PENDING"}
					</div>
				</header>

				<section className="rounded-2xl border bg-card p-5 shadow-sm">
					<div className="flex flex-wrap items-center justify-between gap-4">
						<div>
							<p className="font-semibold text-sm">Settings → General → Tabs</p>
							<p className="mt-1 text-muted-foreground text-xs">
								Floating tabs is on when the switch is checked.
							</p>
						</div>
						<button
							aria-checked={floatingTabs}
							className={cn(
								"flex items-center gap-3 rounded-full border px-3 py-2 font-medium text-sm transition-colors",
								floatingTabs
									? "border-primary/40 bg-primary/10"
									: "border-border bg-muted/50"
							)}
							data-testid="floating-tabs-toggle"
							onClick={() => setFloatingTabs(!floatingTabs)}
							role="switch"
							type="button"
						>
							<span
								aria-hidden
								className={cn(
									"relative h-5 w-9 rounded-full p-0.5 transition-colors",
									floatingTabs ? "bg-primary" : "bg-muted-foreground/40"
								)}
							>
								<span
									className={cn(
										"block size-4 rounded-full bg-background shadow-sm transition-transform",
										floatingTabs ? "translate-x-4" : "translate-x-0"
									)}
								/>
							</span>
							Floating tabs {floatingTabs ? "On" : "Off"}
						</button>
					</div>
				</section>

				<section className="rounded-2xl border bg-card p-5 shadow-sm">
					<div className="mb-4 flex items-center justify-between gap-4">
						<div>
							<p className="font-semibold text-sm">Desktop tab strip</p>
							<p className="mt-1 text-muted-foreground text-xs">
								Click a tab to watch the shared active surface move.
							</p>
						</div>
						<code className="rounded-md bg-muted px-2 py-1 text-muted-foreground text-xs">
							{floatingTabs ? "floating" : "morphing"}
						</code>
					</div>
					<div className="overflow-hidden rounded-xl border bg-muted/70">
						<div
							className="flex min-h-14 items-end gap-1 border-border/60 border-b px-2 pt-2"
							data-tab-rail
						>
							{TABS.map((tab) => (
								<PreviewTab
									active={tab.id === activeId}
									floatingTabs={floatingTabs}
									icon={tab.icon}
									key={tab.id}
									label={tab.label}
									onClick={() => setActiveId(tab.id)}
								/>
							))}
						</div>
						<div className="min-h-52 bg-background p-6">
							<p className="font-medium text-sm">
								{TABS.find((tab) => tab.id === activeId)?.label} page
							</p>
							<p className="mt-2 max-w-lg text-muted-foreground text-sm leading-6">
								{floatingTabs
									? "The selected tab remains a distinct floating pill above the page."
									: "The selected tab shares the page color and becomes its rounded top edge."}
							</p>
						</div>
					</div>
				</section>

				<dl className="grid gap-3 sm:grid-cols-3">
					<div className="rounded-xl border bg-card p-4">
						<dt className="text-muted-foreground text-xs">Default</dt>
						<dd
							className="mt-1 font-medium text-sm"
							data-testid="proof-default"
						>
							{DEFAULT_FLOATING_TABS ? "Floating tabs On" : "Unexpected off"}
						</dd>
					</div>
					<div className="rounded-xl border bg-card p-4">
						<dt className="text-muted-foreground text-xs">Persisted key</dt>
						<dd className="mt-1 font-mono text-sm">{FLOATING_TABS_KEY}</dd>
					</div>
					<div className="rounded-xl border bg-card p-4">
						<dt className="text-muted-foreground text-xs">Morph surface</dt>
						<dd
							className="mt-1 font-medium text-sm"
							data-testid="proof-surface"
						>
							{floatingTabs
								? "Hidden while floating"
								: `${surfaceCount} active shared surface`}
						</dd>
					</div>
				</dl>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<ProofStory />);
}
