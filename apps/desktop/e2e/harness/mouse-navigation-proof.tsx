import {
	ArrowLeft01Icon,
	ArrowRight01Icon,
	ComputerIcon,
	Home01Icon,
	Message01Icon,
	Settings01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { useMouseNavigationButtons } from "../../src/hooks/useMouseNavigationButtons.ts";
import "../../src/index.css";

const PAGES = [
	{ icon: Home01Icon, label: "Home" },
	{ icon: Message01Icon, label: "Agents" },
	{ icon: ComputerIcon, label: "Spaces" },
] as const;

const MOUSE_EVENT_SEQUENCE = [
	"pointerdown",
	"mousedown",
	"pointerup",
	"mouseup",
	"auxclick",
] as const;

function dispatchMouseButton(button: number): boolean {
	let nativeNavigationPrevented = true;
	for (const type of MOUSE_EVENT_SEQUENCE) {
		const event = new MouseEvent(type, {
			bubbles: true,
			button,
			cancelable: true,
		});
		if (window.dispatchEvent(event)) {
			nativeNavigationPrevented = false;
		}
	}
	return nativeNavigationPrevented;
}

function ProofStory() {
	const [activeIndex, setActiveIndex] = useState(2);
	const [actionCount, setActionCount] = useState(0);
	const [lastInput, setLastInput] = useState("Awaiting a mouse button");
	const [nativeNavigationPrevented, setNativeNavigationPrevented] =
		useState(false);

	const goBack = useCallback(() => {
		setActiveIndex((current) => Math.max(0, current - 1));
		setActionCount((current) => current + 1);
	}, []);
	const goForward = useCallback(() => {
		setActiveIndex((current) => Math.min(PAGES.length - 1, current + 1));
		setActionCount((current) => current + 1);
	}, []);
	useMouseNavigationButtons(goBack, goForward);

	const simulateMouseButton = (button: number, label: string) => {
		setLastInput(`${label} · button ${button}`);
		setNativeNavigationPrevented(dispatchMouseButton(button));
	};

	const activePage = PAGES[activeIndex];
	const proofPassed =
		actionCount >= 2 && activeIndex === 2 && nativeNavigationPrevented;

	return (
		<main className="min-h-screen bg-background text-foreground">
			<div className="mx-auto flex min-h-screen max-w-5xl flex-col px-8 py-10">
				<header className="flex items-start justify-between gap-6">
					<div>
						<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
							Ryu desktop interaction proof
						</p>
						<h1 className="mt-3 font-semibold text-3xl tracking-tight">
							Mouse back and forward buttons
						</h1>
						<p className="mt-3 max-w-2xl text-muted-foreground text-sm leading-6">
							Dedicated X1/X2 buttons follow the same tab history as the
							navigation cluster, including WebView event paths that expose more
							than one DOM event for a single click.
						</p>
					</div>
					<div
						className={`rounded-full border px-3 py-1.5 font-medium text-xs ${
							proofPassed
								? "border-success/30 bg-success/10 text-success"
								: "border-warning/30 bg-warning/10 text-warning"
						}`}
						data-proof-status={proofPassed ? "pass" : "pending"}
						data-testid="proof-status"
					>
						{proofPassed ? "PASS · live interaction" : "PENDING"}
					</div>
				</header>

				<div className="mt-10 grid flex-1 gap-5 lg:grid-cols-[220px_1fr]">
					<aside className="rounded-2xl border bg-card p-3 shadow-sm">
						<div className="flex items-center gap-2 px-3 py-3 font-semibold text-sm">
							<div className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
								<span aria-hidden>R</span>
							</div>
							Ryu
						</div>
						<nav aria-label="Navigation sidebar" className="mt-4 space-y-1">
							{PAGES.map((page, index) => (
								<button
									className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${
										index === activeIndex
											? "bg-primary/10 font-medium text-primary"
											: "text-muted-foreground hover:bg-muted/60"
									}`}
									key={page.label}
									onClick={() => setActiveIndex(index)}
									type="button"
								>
									<HugeiconsIcon className="size-4" icon={page.icon} />
									{page.label}
								</button>
							))}
						</nav>
						<div className="mt-8 border-border/70 border-t pt-4">
							<div className="flex items-center gap-3 px-3 py-2 text-muted-foreground text-xs">
								<HugeiconsIcon className="size-4" icon={Settings01Icon} />
								Settings
							</div>
						</div>
					</aside>

					<section className="flex min-h-[520px] flex-col overflow-hidden rounded-2xl border bg-card shadow-sm">
						<div className="flex items-center gap-1 border-border/70 border-b px-4 py-3">
							<button
								aria-label="Go back"
								className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
								disabled={activeIndex === 0}
								onClick={goBack}
								type="button"
							>
								<HugeiconsIcon className="size-4" icon={ArrowLeft01Icon} />
							</button>
							<button
								aria-label="Go forward"
								className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
								disabled={activeIndex === PAGES.length - 1}
								onClick={goForward}
								type="button"
							>
								<HugeiconsIcon className="size-4" icon={ArrowRight01Icon} />
							</button>
							<div className="ml-3 border-border/70 border-l pl-3 font-medium text-sm">
								{activePage.label}
							</div>
						</div>

						<div className="flex flex-1 flex-col justify-between p-8">
							<div>
								<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
									Active page
								</p>
								<h2
									className="mt-3 font-semibold text-4xl tracking-tight"
									data-testid="active-page"
								>
									{activePage.label}
								</h2>
								<p className="mt-3 max-w-xl text-muted-foreground text-sm leading-6">
									The sidebar and the mouse navigation buttons share one history
									stack. A physical back button moves here exactly like the
									top-left arrow.
								</p>
							</div>

							<div className="grid gap-4 xl:grid-cols-2">
								<div className="rounded-xl border bg-muted/35 p-5">
									<p className="font-semibold text-sm">Mouse buttons</p>
									<p className="mt-1 text-muted-foreground text-xs">
										Replay the native X1/X2 event path.
									</p>
									<div className="mt-4 flex flex-wrap gap-2">
										<button
											className="rounded-lg border bg-background px-3 py-2 font-medium text-sm transition-colors hover:bg-muted"
											data-testid="mouse-back"
											onClick={() =>
												simulateMouseButton(3, "Mouse back button")
											}
											type="button"
										>
											Back button
										</button>
										<button
											className="rounded-lg border bg-background px-3 py-2 font-medium text-sm transition-colors hover:bg-muted"
											data-testid="mouse-forward"
											onClick={() =>
												simulateMouseButton(4, "Mouse forward button")
											}
											type="button"
										>
											Forward button
										</button>
									</div>
								</div>
								<div className="rounded-xl border bg-muted/35 p-5">
									<p className="font-semibold text-sm">Last input</p>
									<p
										className="mt-1 font-mono text-muted-foreground text-xs"
										data-testid="last-input"
									>
										{lastInput}
									</p>
									<p
										className="mt-4 font-medium text-sm"
										data-testid="native-default"
									>
										{nativeNavigationPrevented
											? "Native navigation prevented"
											: "Native navigation pending"}
									</p>
								</div>
							</div>
						</div>
					</section>
				</div>

				<div className="mt-5 grid gap-4 sm:grid-cols-3">
					<div className="rounded-xl border bg-card p-4">
						<p className="text-muted-foreground text-xs">Event path</p>
						<p className="mt-2 font-mono text-sm">
							pointerdown → mousedown → pointerup → mouseup → auxclick
						</p>
					</div>
					<div className="rounded-xl border bg-card p-4">
						<p className="text-muted-foreground text-xs">Navigation actions</p>
						<p
							className="mt-2 font-mono text-sm"
							data-testid="navigation-count"
						>
							{actionCount} {actionCount === 1 ? "action" : "actions"}
						</p>
					</div>
					<div className="rounded-xl border bg-card p-4">
						<p className="text-muted-foreground text-xs">Button mapping</p>
						<p className="mt-2 font-mono text-sm">3 = back · 4 = forward</p>
					</div>
				</div>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<ProofStory />);
}
