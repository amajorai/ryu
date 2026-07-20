import type React from "react";

type IconProps = React.SVGProps<SVGSVGElement> & {
	className?: string;
};

export function IconSpinner({ className, ...rest }: IconProps) {
	return (
		<svg
			className={
				className ?? "animate-spin text-muted-foreground will-change-transform"
			}
			fill="none"
			height="16"
			viewBox="0 0 24 24"
			width="16"
			{...rest}
		>
			<circle
				cx="12"
				cy="12"
				fill="none"
				opacity={0.2}
				r="10"
				stroke="currentColor"
				strokeLinecap="round"
				strokeWidth="3"
			/>
			<path
				d="M12 2C6.48 2 2 6.48 2 12"
				fill="none"
				stroke="currentColor"
				strokeLinecap="round"
				strokeWidth="3"
			/>
		</svg>
	);
}

export function CheckIcon(props: IconProps) {
	return (
		<svg
			fill="none"
			viewBox="0 0 24 24"
			xmlns="http://www.w3.org/2000/svg"
			{...props}
		>
			<path
				d="M5 12.75L10 19L19 5"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="2"
			/>
		</svg>
	);
}

export function IconArrowRight(props: IconProps) {
	return (
		<svg fill="none" height="24" viewBox="0 0 24 24" width="24" {...props}>
			<path
				d="M14 6L20 12L14 18"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="2"
			/>
			<path
				d="M19 12H4"
				stroke="currentColor"
				strokeLinecap="round"
				strokeWidth="2"
			/>
		</svg>
	);
}

export function IconDoubleChevronRight(props: IconProps) {
	return (
		<svg fill="none" height="16" viewBox="0 0 24 24" width="16" {...props}>
			<path
				d="M6 17L11 12L6 7M13 17L18 12L13 7"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="2"
			/>
		</svg>
	);
}
