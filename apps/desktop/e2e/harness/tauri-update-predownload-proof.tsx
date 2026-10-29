import { UpdatesView } from "@ryu/blocks/desktop/updates.tsx";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
	APP_UPDATE_DOWNLOAD_ARIA_LABEL,
	APP_UPDATE_DOWNLOAD_DESCRIPTION,
	APP_UPDATE_DOWNLOAD_TITLE,
	APP_UPDATE_INSTALL_ACTION,
} from "../../src/components/updater/app-update-policy.ts";
import "../../src/index.css";

const BASE_LOG = [
	"check → eligible v9.9.9",
	"prepare → signature verified",
	"ready → waiting for user",
];

function TauriUpdatePredownloadProof() {
	const [complete, setComplete] = useState(false);
	const log = complete
		? [...BASE_LOG, "install → explicit user action"]
		: BASE_LOG;

	return (
		<main className="min-h-screen bg-muted/30 px-6 py-10 text-foreground">
			<div className="mx-auto max-w-5xl space-y-6">
				<header className="flex items-end justify-between gap-6">
					<div>
						<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
							Ryu desktop · Tauri
						</p>
						<h1 className="mt-2 font-semibold text-3xl tracking-tight">
							App Settings
						</h1>
						<p className="mt-2 text-muted-foreground text-sm">
							Updates download ahead of time. Installation waits for you.
						</p>
					</div>
					<div
						className="rounded-full border bg-background px-3 py-1.5 font-medium text-sm shadow-sm"
						data-testid="proof-status"
					>
						{complete ? "Complete" : "Ready"}
					</div>
				</header>

				<div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
					<section className="rounded-2xl border bg-background p-6 shadow-sm">
						<UpdatesView
							automaticUpdateAriaLabel={APP_UPDATE_DOWNLOAD_ARIA_LABEL}
							automaticUpdateDescription={APP_UPDATE_DOWNLOAD_DESCRIPTION}
							automaticUpdateTitle={APP_UPDATE_DOWNLOAD_TITLE}
							autoUpdate={true}
							installPreparedDisabled={complete}
							installPreparedLabel={APP_UPDATE_INSTALL_ACTION}
							onCheck={() => undefined}
							onInstallPreparedUpdate={() => setComplete(true)}
							onToggle={() => undefined}
							preparedUpdateNotice="v9.9.9 is downloaded and signature-verified. Install it when you're ready."
							productName="Ryu"
							version="0.2.0"
						/>
					</section>

					<aside className="rounded-2xl border bg-background p-5 shadow-sm">
						<div className="flex items-center justify-between gap-3">
							<div>
								<p className="font-medium text-sm">Update activity</p>
								<p className="mt-1 text-muted-foreground text-xs">
									Native updater log
								</p>
							</div>
							<span className="size-2 rounded-full bg-success" />
						</div>
						<ol className="mt-5 space-y-3" data-testid="proof-log">
							{log.map((entry, index) => (
								<li className="flex gap-3 text-sm" key={entry}>
									<span className="type-compact flex size-5 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-muted-foreground">
										{index + 1}
									</span>
									<span>{entry}</span>
								</li>
							))}
						</ol>
						<div className="mt-5 rounded-xl bg-muted/60 p-3 text-muted-foreground text-xs leading-relaxed">
							No install or restart occurs before the explicit action.
						</div>
					</aside>
				</div>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<TauriUpdatePredownloadProof />);
}
