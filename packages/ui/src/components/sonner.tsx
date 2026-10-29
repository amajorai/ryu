"use client";

import {
	Alert02Icon,
	CheckmarkCircle02Icon,
	InformationCircleIcon,
	Loading03Icon,
	MultiplicationSignCircleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";

interface SonnerStyle extends NonNullable<ToasterProps["style"]> {
	"--border-radius": "var(--radius)";
	"--normal-bg": "var(--popover)";
	"--normal-border": "var(--border)";
	"--normal-text": "var(--popover-foreground)";
}

const Toaster = ({ ...props }: ToasterProps) => {
	const { theme = "system" } = useTheme();

	return (
		<Sonner
			className="group"
			icons={{
				success: (
					<HugeiconsIcon
						className="size-4"
						icon={CheckmarkCircle02Icon}
						strokeWidth={2}
					/>
				),
				info: (
					<HugeiconsIcon
						className="size-4"
						icon={InformationCircleIcon}
						strokeWidth={2}
					/>
				),
				warning: (
					<HugeiconsIcon
						className="size-4"
						icon={Alert02Icon}
						strokeWidth={2}
					/>
				),
				error: (
					<HugeiconsIcon
						className="size-4"
						icon={MultiplicationSignCircleIcon}
						strokeWidth={2}
					/>
				),
				loading: (
					<HugeiconsIcon
						className="size-4 animate-spin"
						icon={Loading03Icon}
						strokeWidth={2}
					/>
				),
			}}
			style={
				// SAFETY: satisfies checks the complete native Toaster style extension with these exact semantic custom properties. React DOM forwards custom names through setProperty; its closed style declaration omits them.
				{
					"--normal-bg": "var(--popover)",
					"--normal-text": "var(--popover-foreground)",
					"--normal-border": "var(--border)",
					"--border-radius": "var(--radius)",
				} satisfies SonnerStyle as ToasterProps["style"]
			}
			theme={
				// SAFETY: next-themes publishes the complete string theme identifier. Sonner resolves only "system" specially and forwards every other identifier unchanged as data-sonner-theme, beyond its declared light/dark/system union.
				theme as ToasterProps["theme"]
			}
			toastOptions={{
				classNames: {
					toast: "cn-toast",
				},
			}}
			{...props}
		/>
	);
};

export { Toaster };
