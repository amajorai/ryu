import { useState } from "react";
import { createRoot } from "react-dom/client";
import { InboxLink } from "@/components/inbox-link.tsx";
import { INBOX_CHANGED_EVENT } from "@/lib/inbox-api.ts";
import "@/index.css";

let serverUnreadCount = 4;
const originalFetch = window.fetch.bind(window);

window.fetch = async (input, init) => {
	const url = typeof input === "string" ? input : input.url;
	if (url.endsWith("/api/inbox/unread-count")) {
		return new Response(
			JSON.stringify({
				counts: {
					all: serverUnreadCount,
					invitations: 0,
					marketing: serverUnreadCount,
					transactional: 0,
				},
			}),
			{
				headers: { "content-type": "application/json" },
				status: 200,
			}
		);
	}
	return originalFetch(input, init);
};

function OrganizationDashboardProof() {
	const [lastAction, setLastAction] = useState("Ready to preview");

	const receiveNotification = () => {
		serverUnreadCount += 1;
		window.dispatchEvent(new Event(INBOX_CHANGED_EVENT));
		setLastAction("Received new notification");
	};

	return (
		<main className="min-h-screen bg-background text-foreground">
			<header className="sticky top-0 z-10 border-border/70 border-b bg-background/90 backdrop-blur-xl">
				<div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-6 py-3">
					<a className="font-semibold tracking-tight" href="/dashboard">
						Ryu
					</a>
					<div className="flex items-center gap-3">
						<span className="hidden text-muted-foreground text-sm sm:inline">
							Atlas organization
						</span>
						<InboxLink />
					</div>
				</div>
			</header>

			<div className="mx-auto w-full max-w-6xl px-6 py-8">
				<nav
					aria-label="Organization navigation"
					className="mb-8 flex items-center gap-1.5 overflow-x-auto pb-1"
				>
					<span className="mr-3 shrink-0 font-medium text-sm">Atlas</span>
					{["Products", "Features", "Config", "Dashboard", "Audit log"].map(
						(label) => (
							<a
								aria-current={label === "Dashboard" ? "page" : undefined}
								className={
									label === "Dashboard"
										? "shrink-0 rounded-full bg-foreground px-3 py-1 font-medium text-background text-sm"
										: "shrink-0 rounded-full px-3 py-1 font-medium text-foreground/60 text-sm"
								}
								href="#dashboard"
								key={label}
							>
								{label}
							</a>
						)
					)}
				</nav>

				<section
					aria-labelledby="org-dashboard-title"
					className="space-y-6"
					data-testid="org-dashboard"
					id="dashboard"
				>
					<div className="flex flex-wrap items-end justify-between gap-4">
						<div>
							<p className="font-mono text-muted-foreground text-xs uppercase tracking-[0.16em]">
								Atlas organization
							</p>
							<h1
								className="mt-2 font-semibold text-3xl tracking-tight"
								id="org-dashboard-title"
							>
								Aggregation dashboard
							</h1>
							<p className="mt-2 max-w-2xl text-muted-foreground text-sm leading-6">
								Eval, budget, and audit summaries across every gateway reporting
								into this organization.
							</p>
						</div>
						<div className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1.5 font-medium text-emerald-700 text-xs dark:text-emerald-300">
							Dashboard live
						</div>
					</div>

					<div className="grid gap-4 sm:grid-cols-3">
						{[
							["Requests", "24,680"],
							["Error rate", "0.8%"],
							["Monthly spend", "$184.20"],
						].map(([label, value]) => (
							<div
								className="rounded-2xl border bg-card p-5 shadow-sm"
								key={label}
							>
								<p className="text-muted-foreground text-xs">{label}</p>
								<p className="mt-2 font-medium font-mono text-2xl tabular-nums">
									{value}
								</p>
							</div>
						))}
					</div>

					<div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
						<div className="rounded-2xl border bg-card p-5 shadow-sm">
							<p className="font-medium text-sm">Gateway activity</p>
							<p className="mt-1 text-muted-foreground text-xs">
								Requests and response health over the current billing period.
							</p>
							<div className="mt-8 flex h-24 items-end gap-2">
								{[42, 57, 48, 76, 64, 83, 72, 92, 80, 96].map(
									(height, index) => (
										<div
											className="flex-1 rounded-t-md bg-primary/70"
											key={`${height}-${index}`}
											style={{ height: `${height}%` }}
										/>
									)
								)}
							</div>
						</div>
						<div className="rounded-2xl border bg-card p-5 shadow-sm">
							<p className="font-medium text-sm">Shared budgets</p>
							<p className="mt-1 text-muted-foreground text-xs">
								Spend caps across the organization.
							</p>
							<div className="mt-8 space-y-4">
								{[
									["Production", "72%"],
									["Evaluation", "41%"],
								].map(([label, width]) => (
									<div key={label}>
										<div className="mb-1 flex justify-between text-xs">
											<span>{label}</span>
											<span className="text-muted-foreground">{width}</span>
										</div>
										<div className="h-2 overflow-hidden rounded-full bg-secondary">
											<div
												className="h-full rounded-full bg-primary"
												style={{ width }}
											/>
										</div>
									</div>
								))}
							</div>
						</div>
					</div>
				</section>

				<section
					className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-primary/20 bg-primary/5 px-4 py-3"
					data-testid="interaction-check"
				>
					<div>
						<p className="font-medium text-sm">Notification bell proof</p>
						<p className="mt-1 text-muted-foreground text-xs">{lastAction}</p>
					</div>
					<button
						aria-label="Simulate new notification"
						className="rounded-lg bg-primary px-3 py-2 font-medium text-primary-foreground text-xs transition-opacity hover:opacity-90"
						onClick={receiveNotification}
						type="button"
					>
						Simulate new notification
					</button>
				</section>
			</div>
		</main>
	);
}

createRoot(document.getElementById("root")!).render(
	<OrganizationDashboardProof />
);
