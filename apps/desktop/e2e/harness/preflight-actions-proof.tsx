import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/inter";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { createRoot } from "react-dom/client";
import { PreflightDiagnosticsActions } from "../../src/components/shell/PreflightActions.tsx";
import {
	initCrashReporting,
	setCrashReportingEnabled,
} from "../../src/lib/crash.ts";
import "../../src/index.css";

initCrashReporting();
setCrashReportingEnabled(
	new URLSearchParams(location.search).get("mode") !== "disabled"
);
const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing root");
}
createRoot(root).render(
	<main className="flex min-h-screen items-center justify-center bg-background p-8 text-foreground">
		<section className="flex w-full max-w-xl flex-col gap-6 rounded-xl border bg-card p-8">
			<div className="space-y-2">
				<h1 className="font-semibold text-2xl">System health</h1>
				<p className="text-muted-foreground text-sm">
					Collect diagnostics for this node or report an issue.
				</p>
			</div>
			<PreflightDiagnosticsActions
				target={{ url: location.origin, token: null, userJwt: null }}
			/>
		</section>
		<Toaster position="bottom-right" theme="system" />
	</main>
);
