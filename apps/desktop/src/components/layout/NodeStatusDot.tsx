import { cn } from "@/lib/utils.ts";

/** Reachability dot for a computer: muted while unknown, success when online,
 *  warning when offline. Matches the computer selector's rows. */
export function NodeStatusDot({
	online,
	className,
}: {
	online: boolean | null;
	className?: string;
}) {
	const label = online === null ? "Checking" : online ? "Online" : "Offline";
	return (
		<span
			aria-label={label}
			className={cn(
				"size-2 shrink-0 rounded-full",
				online === null
					? "bg-muted-foreground/40"
					: online
						? "bg-success"
						: "bg-warning",
				className
			)}
			data-online={online === null ? "unknown" : String(online)}
			role="img"
		/>
	);
}
