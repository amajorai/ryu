import type { ReactNode } from "react";
import { SettingsCard } from "@/src/components/settings/shared/settings-items.tsx";

/**
 * A plain-sentence load/save notice for a Gateway settings pane: one card, the
 * message on the left and an optional action (usually Retry) on the right.
 *
 * Raw technical detail (a parser message, a zod issue list) never leads: pass
 * it as `detail` to keep it on the `title` attribute only, or as `secondary`
 * when a short request summary must stay readable (a muted line under the
 * sentence, never the headline).
 */
export function SettingsNotice({
	action,
	children,
	detail,
	id,
	role,
	secondary,
}: {
	action?: ReactNode;
	children: ReactNode;
	detail?: string;
	id?: string;
	role?: "alert" | "status";
	secondary?: ReactNode;
}) {
	return (
		<SettingsCard className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-2">
			<div
				className={
					role === "status"
						? "min-w-0 flex-1 text-muted-foreground text-sm"
						: "min-w-0 flex-1 text-sm"
				}
				id={id}
				role={role}
				title={detail}
			>
				{/* The sentence sits in its own element so scoped `getByText` lookups
				    inside the live region find it. */}
				<span>{children}</span>
				{secondary ? (
					<span className="mt-0.5 block break-words text-muted-foreground text-xs">
						{secondary}
					</span>
				) : null}
			</div>
			{action ? <div className="shrink-0">{action}</div> : null}
		</SettingsCard>
	);
}
