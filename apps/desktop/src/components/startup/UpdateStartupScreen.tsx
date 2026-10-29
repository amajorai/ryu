import { Logo as OrbLogo } from "@ryu/ui/components/logo.tsx";
import type { UpdateStartupStatus } from "../../hooks/useUpdateStartupHealth.ts";

export function UpdateStartupScreen({
	status,
}: {
	status: Exclude<UpdateStartupStatus, "ready">;
}) {
	const failed = status === "failed";
	return (
		<div className="flex size-full flex-col items-center justify-center gap-5 px-6 text-center">
			<OrbLogo size="56px" variant={failed ? "outline-static" : "shimmer"} />
			<div aria-live="polite" className="max-w-sm space-y-2" role="status">
				<p className="font-medium text-foreground">
					{failed ? "Update verification stopped" : "Verifying your update"}
				</p>
				<p className="text-muted-foreground text-sm">
					{failed
						? "Ryu is keeping your work closed. Update recovery may reopen the previous version."
						: "Ryu will open your work when the app and runtime checks finish."}
				</p>
			</div>
		</div>
	);
}
