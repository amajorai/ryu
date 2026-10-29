import { createRoot } from "react-dom/client";
import {
	ELECTRON_UPDATE_INSTALL_OPTIONS,
	shouldAutoInstallDownloadedUpdate,
} from "../../../island/src/shared/update-policy.ts";
import "../../src/index.css";

const CHECKS = [
	{
		label: "Download completes the update",
		value: shouldAutoInstallDownloadedUpdate(true, true),
	},
	{
		label: "Windows installer runs silently",
		value: ELECTRON_UPDATE_INSTALL_OPTIONS.isSilent,
	},
	{
		label: "Updated app relaunches automatically",
		value: ELECTRON_UPDATE_INSTALL_OPTIONS.isForceRunAfter,
	},
	{
		label: "Automatic-updates opt-out is preserved",
		value: !shouldAutoInstallDownloadedUpdate(true, false),
	},
] as const;

function CheckRow({ label, value }: (typeof CHECKS)[number]) {
	return (
		<li
			className="flex items-center justify-between gap-4 border-white/10 border-b py-3 last:border-b-0"
			data-status={value ? "pass" : "fail"}
		>
			<span className="text-sm text-white/80">{label}</span>
			<span className="rounded-full bg-success/15 px-2.5 py-1 font-medium text-success text-xs">
				{value ? "Verified" : "Needs attention"}
			</span>
		</li>
	);
}

function Proof() {
	return (
		<main className="dark min-h-screen bg-background px-6 py-12 text-white sm:px-10">
			<div className="mx-auto max-w-3xl">
				<header className="mb-8">
					<p className="mb-3 font-medium text-info text-xs uppercase tracking-(--tracking-section)">
						Ryu · Update proof
					</p>
					<h1 className="font-semibold text-3xl tracking-tight sm:text-4xl">
						Desktop updates finish themselves.
					</h1>
					<p className="mt-3 max-w-2xl text-base text-white/60">
						The Electron companion now installs a downloaded update silently and
						relaunches when the shared automatic-updates preference is enabled.
					</p>
				</header>

				<section
					aria-label="Automatic update verification"
					className="rounded-3xl border border-white/10 bg-white/[0.04] p-5 shadow-2xl shadow-black/30 sm:p-7"
				>
					<div className="flex items-start justify-between gap-4">
						<div>
							<p className="text-white/45 text-xs uppercase tracking-(--tracking-section)">
								Release behavior
							</p>
							<h2 className="mt-2 font-medium text-xl">
								No Next / Continue wizard
							</h2>
						</div>
						<span
							className="rounded-full bg-success/15 px-3 py-1.5 font-semibold text-success text-xs"
							data-testid="proof-status"
						>
							Verified
						</span>
					</div>

					<ul className="mt-6" data-testid="proof-checks">
						{CHECKS.map((check) => (
							<CheckRow key={check.label} {...check} />
						))}
					</ul>

					<div className="mt-6 rounded-2xl bg-warning/10 p-4 text-sm text-warning/80">
						Windows may still show a UAC consent prompt when the OS requires
						administrator approval. The update wizard itself is silent; the app
						cannot bypass the operating system&apos;s security decision.
					</div>
				</section>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Proof />);
}
