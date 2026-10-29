// @ts-nocheck - vendored termcn component, see scripts/vendor-termcn.ts
/* @jsxImportSource @opentui/react */
import type { ReactNode } from "react";

import { useTheme } from "@/components/ui/theme-provider";

import { Spinner } from "./spinner";

export type StatusVariant =
	| "success"
	| "error"
	| "warning"
	| "info"
	| "loading"
	| "pending";

const ICONS = {
	error: "✗",
	info: "ℹ",
	pending: "○",
	success: "✓",
	warning: "⚠",
} satisfies Record<Exclude<StatusVariant, "loading">, string>;

export interface StatusMessageProps {
	variant?: StatusVariant;
	children: ReactNode;
	icon?: string;
}

export const StatusMessage = ({
	variant = "info",
	children,
	icon,
}: StatusMessageProps) => {
	const theme = useTheme();

	const variantColor = (() => {
		switch (variant) {
			case "success": {
				return theme.colors.success;
			}
			case "error": {
				return theme.colors.error;
			}
			case "warning": {
				return theme.colors.warning;
			}
			case "loading": {
				return theme.colors.primary;
			}
			case "pending": {
				return theme.colors.mutedForeground;
			}
			default: {
				return theme.colors.info;
			}
		}
	})();

	return (
		<box gap={1} flexDirection="row">
			{variant === "loading" ? (
				<Spinner type="dots" color={variantColor} />
			) : (
				<text fg={variantColor}>{icon ?? ICONS[variant]}</text>
			)}
			<text fg={theme.colors.foreground}>{children}</text>
		</box>
	);
};
