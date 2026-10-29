import { cn } from "@ryu/ui/lib/utils.ts";
import { useId } from "react";

type SpinnerSize = "sm" | "default" | "md" | "lg";
type SpinnerSpeed = "slow" | "normal" | "fast";

const sizeClasses = {
	sm: "size-4",
	default: "size-5",
	md: "size-6",
	lg: "size-8",
} satisfies Record<SpinnerSize, string>;

const speedClasses = {
	slow: "animate-[spin_2s_linear_infinite]",
	normal: "animate-spin",
	fast: "animate-[spin_0.5s_linear_infinite]",
} satisfies Record<SpinnerSpeed, string>;

/** Spell UI's gradient spinner, adapted to the shared Ryu component API. */
function Spinner({
	className,
	size = "sm",
	speed = "normal",
	animated = true,
	presentation = "default",
	...props
}: Omit<React.ComponentProps<"svg">, "strokeWidth"> & {
	animated?: boolean;
	presentation?: "default" | "sidebar-tab";
	size?: SpinnerSize;
	speed?: SpinnerSpeed;
}) {
	const id = useId();
	return (
		<span
			aria-label="Loading"
			className={cn(
				"inline-block",
				sizeClasses[size],
				animated ? speedClasses[speed] : "animate-none",
				presentation === "sidebar-tab" &&
					"transition-[scale,opacity] duration-150 group-hover/row:scale-50 group-hover/row:opacity-0 group-focus-visible/row:scale-50 group-focus-visible/row:opacity-0 group-has-[button:focus-visible]/row:scale-50 group-has-[button:focus-visible]/row:opacity-0",
				className
			)}
			role="status"
		>
			<svg className="size-full" viewBox="0 0 24 24" {...props}>
				<defs>
					<linearGradient
						id={`spinner-gradient-primary-${id}`}
						x1="50%"
						x2="50%"
						y1="5.271%"
						y2="91.793%"
					>
						<stop offset="0%" stopColor="currentColor" />
						<stop offset="100%" stopColor="currentColor" stopOpacity={0.55} />
					</linearGradient>
					<linearGradient
						id={`spinner-gradient-secondary-${id}`}
						x1="50%"
						x2="50%"
						y1="15.24%"
						y2="87.15%"
					>
						<stop offset="0%" stopColor="currentColor" stopOpacity={0} />
						<stop offset="100%" stopColor="currentColor" stopOpacity={0.55} />
					</linearGradient>
				</defs>
				<path
					d="M8.749.021a1.5 1.5 0 0 1 .497 2.958A7.5 7.5 0 0 0 3 10.375a7.5 7.5 0 0 0 7.5 7.5v3c-5.799 0-10.5-4.7-10.5-10.5C0 5.23 3.726.865 8.749.021"
					fill={`url(#spinner-gradient-primary-${id})`}
					transform="translate(1.5 1.625)"
				/>
				<path
					d="M15.392 2.673a1.5 1.5 0 0 1 2.119-.115A10.48 10.48 0 0 1 21 10.375c0 5.8-4.701 10.5-10.5 10.5v-3a7.5 7.5 0 0 0 5.007-13.084a1.5 1.5 0 0 1-.115-2.118"
					fill={`url(#spinner-gradient-secondary-${id})`}
					transform="translate(1.5 1.625)"
				/>
			</svg>
		</span>
	);
}

export { Spinner, type SpinnerSize, type SpinnerSpeed };
