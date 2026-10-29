import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/inter";
import { createRoot } from "react-dom/client";
import { CrashBoundary } from "../../src/components/CrashBoundary.tsx";
import { installConsoleCapture } from "../../src/lib/console-buffer.ts";
import "../../src/index.css";

const RECOVER_ON_RELOAD_KEY = "crash-boundary-proof-recover-on-reload";

declare global {
	interface Window {
		__crashBoundaryProof: {
			allowRecovery: boolean;
			mountCount: number;
		};
	}
}

const theme = new URLSearchParams(window.location.search).get("theme");
document.documentElement.classList.toggle("dark", theme === "dark");
window.__crashBoundaryProof = {
	allowRecovery: sessionStorage.getItem(RECOVER_ON_RELOAD_KEY) === "true",
	mountCount: 0,
};
installConsoleCapture();
console.warn("Crash boundary proof console breadcrumb");

function CrashingChild() {
	const proof = window.__crashBoundaryProof;
	proof.mountCount += 1;
	if (!proof.allowRecovery) {
		throw new Error("Crash boundary visual proof");
	}
	return (
		<main className="grid min-h-screen place-items-center bg-background text-foreground">
			<p data-testid="recovered-child">The app recovered after remount.</p>
			<p className="sr-only" data-testid="child-mount-count">
				{proof.mountCount}
			</p>
		</main>
	);
}

const rootElement = document.getElementById("root");
if (!rootElement) {
	throw new Error("Crash boundary proof root is missing");
}

createRoot(rootElement).render(
	<CrashBoundary>
		<CrashingChild />
	</CrashBoundary>
);

document.body.setAttribute("data-harness-ready", "1");
