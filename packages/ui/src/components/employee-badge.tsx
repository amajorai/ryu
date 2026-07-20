import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@ryu/ui/components/avatar.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";

/**
 * Presentational, SSR-safe "company ID badge" for an agent-as-employee.
 *
 * Styled like a laminated corporate ID card: a lanyard notch + accent bar up
 * top, an avatar (or initials fallback), the employee's name and role, a
 * monospace employee id, the hire date, a level chip, and a compact stats row.
 * Pure: no data fetching, no effects, no access to `window`/`document`. All
 * colors come from design tokens so it reads correctly in light and dark.
 */

export interface EmployeeStat {
	label: string;
	value: string;
}

export interface EmployeeBadgeProps {
	avatarUrl?: string;
	employeeId: string;
	hiredAt?: string;
	level: number;
	name: string;
	onClick?: () => void;
	role?: string;
	stats?: EmployeeStat[];
}

const WHITESPACE = /\s+/;
const MAX_INITIALS = 2;
const ID_PREFIX = "EMP-";
const SHORT_ID_LENGTH = 6;

/** Two-letter uppercase initials from a display name, for the avatar fallback. */
export const employeeInitials = (name: string): string => {
	const parts = name.trim().split(WHITESPACE).filter(Boolean);
	if (parts.length === 0) {
		return "?";
	}
	return parts
		.slice(0, MAX_INITIALS)
		.map((part) => part.charAt(0).toUpperCase())
		.join("");
};

/** A stable, human-readable badge id like "EMP-A1B2C3" from an agent id. */
export const formatEmployeeId = (employeeId: string): string => {
	const compact = employeeId.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
	const short = (compact || employeeId).slice(0, SHORT_ID_LENGTH);
	return `${ID_PREFIX}${short || "000000"}`;
};

/** Format a hire date as "Jan 5, 2026"; returns null for missing/invalid input. */
const formatHiredAt = (hiredAt: string | undefined): string | null => {
	if (!hiredAt) {
		return null;
	}
	const date = new Date(hiredAt);
	if (Number.isNaN(date.getTime())) {
		return null;
	}
	return date.toLocaleDateString("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
};

export function EmployeeBadge({
	avatarUrl,
	hiredAt,
	employeeId,
	level,
	name,
	onClick,
	role,
	stats,
}: EmployeeBadgeProps) {
	const initials = employeeInitials(name);
	const hiredLabel = formatHiredAt(hiredAt);
	const badgeId = formatEmployeeId(employeeId);
	const interactive = typeof onClick === "function";

	return (
		<button
			className={cn(
				"group relative flex w-full flex-col overflow-hidden rounded-2xl border bg-card text-left text-card-foreground shadow-sm transition-all",
				interactive &&
					"cursor-pointer hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
			)}
			disabled={!interactive}
			onClick={onClick}
			type="button"
		>
			{/* Lanyard accent bar + notch */}
			<div
				aria-hidden="true"
				className="relative h-2 w-full"
				style={{
					backgroundColor: "var(--primary)",
				}}
			>
				<span className="absolute top-1 left-1/2 h-1.5 w-8 -translate-x-1/2 rounded-full bg-card ring-1 ring-border" />
			</div>

			<div className="flex items-start gap-3 p-4">
				<Avatar className="size-12 ring-1 ring-border" size="lg">
					{avatarUrl ? <AvatarImage alt={name} src={avatarUrl} /> : null}
					<AvatarFallback className="font-semibold text-sm">
						{initials}
					</AvatarFallback>
				</Avatar>

				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="truncate font-semibold text-base leading-tight">
						{name}
					</span>
					{role ? (
						<span className="truncate text-muted-foreground text-xs">
							{role}
						</span>
					) : null}
					<span className="mt-1 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
						{badgeId}
					</span>
				</div>

				<span
					className="flex size-9 shrink-0 flex-col items-center justify-center rounded-full font-semibold text-[10px] leading-none ring-2 ring-inset"
					style={{
						color: "var(--primary)",
						backgroundColor:
							"color-mix(in oklab, var(--primary) 12%, transparent)",
					}}
					title={`Level ${level}`}
				>
					<span className="text-[8px] text-muted-foreground uppercase">
						Lvl
					</span>
					<span className="text-xs tabular-nums">{level}</span>
				</span>
			</div>

			<div className="flex flex-col gap-3 border-t px-4 py-3">
				{hiredLabel ? (
					<span className="text-[11px] text-muted-foreground">
						Hired {hiredLabel}
					</span>
				) : null}

				{stats && stats.length > 0 ? (
					<div className="flex flex-wrap gap-x-4 gap-y-2">
						{stats.map((stat) => (
							<div className="flex flex-col" key={stat.label}>
								<span className="font-semibold text-foreground text-sm tabular-nums">
									{stat.value}
								</span>
								<span className="text-[10px] text-muted-foreground uppercase tracking-wide">
									{stat.label}
								</span>
							</div>
						))}
					</div>
				) : null}
			</div>
		</button>
	);
}
