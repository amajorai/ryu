// @ts-nocheck - vendored termcn component, see scripts/vendor-termcn.ts
/* @jsxImportSource @opentui/react */

import { useKeyboard } from "@opentui/react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { z } from "zod";
import { useTheme } from "@/components/ui/theme-provider";
import { terminalTextPrimitiveSchema } from "./terminal-text-contracts.ts";

export type ChatRole = "user" | "assistant" | "system" | "error";

export interface ChatMessageProps {
	sender: ChatRole;
	name?: string;
	timestamp?: Date;
	streaming?: boolean;
	collapsed?: boolean;
	children?: ReactNode;
}

const formatTime = (date: Date): string =>
	date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const wrapPlainChildren = (node: ReactNode): ReactNode => {
	const textNode = terminalTextPrimitiveSchema.safeParse(node);
	return textNode.success ? <text>{textNode.data}</text> : node;
};

export const ChatMessage = ({
	sender,
	name,
	timestamp,
	streaming = false,
	collapsed: initialCollapsed = false,
	children,
}: ChatMessageProps) => {
	const theme = useTheme();
	const [isCollapsed, setIsCollapsed] = useState(initialCollapsed);
	const [dotFrame, setDotFrame] = useState(0);

	useEffect(() => {
		if (!streaming) {
			return;
		}
		const id = setInterval(() => setDotFrame((f) => (f + 1) % 4), 400);
		return () => clearInterval(id);
	}, [streaming]);

	useKeyboard((key) => {
		if (initialCollapsed && (key.name === "return" || key.name === " ")) {
			setIsCollapsed((c) => !c);
		}
	});

	const roleColor = {
		assistant: theme.colors.success ?? "green",
		error: theme.colors.error ?? "red",
		system: theme.colors.mutedForeground,
		user: theme.colors.primary,
	} satisfies Record<ChatRole, string>;

	const roleLabel = {
		assistant: "assistant",
		error: "error",
		system: "system",
		user: "user",
	} satisfies Record<ChatRole, string>;

	const color = roleColor[sender];

	const dots = ["", "●", "●●", "●●●"][dotFrame] ?? "";

	const textChildren = z.string().safeParse(children);
	const childrenText = textChildren.success ? textChildren.data : "";
	const firstLine = childrenText.split("\n")[0] ?? "";

	const renderContent = () => {
		if (streaming) {
			return (
				<box>
					{children ? (
						wrapPlainChildren(children)
					) : (
						<text fg={color}>{dots}</text>
					)}
				</box>
			);
		}
		if (isCollapsed) {
			return (
				<box>
					<text fg="#666">{`${firstLine.slice(0, 60)}${firstLine.length > 60 || childrenText.includes("\n") ? "..." : ""}`}</text>
				</box>
			);
		}
		return <box>{wrapPlainChildren(children)}</box>;
	};

	return (
		<box flexDirection="column" marginBottom={1}>
			<box gap={1}>
				<text fg={color}>
					<b>{name ?? roleLabel[sender]}</b>
				</text>
				{timestamp && (
					<text fg={theme.colors.mutedForeground}>{formatTime(timestamp)}</text>
				)}
				{isCollapsed && !streaming && <text fg="#666">[expand]</text>}
			</box>

			{renderContent()}
		</box>
	);
};
