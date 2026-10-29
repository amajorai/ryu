"use client";

import { createContext, type ReactNode, useContext } from "react";
import {
	isNativeObjectLike,
	isNativeText,
} from "../lib/native-primitive-observation.ts";
import type { ExpressiveExpressionSelection } from "./expressive.ts";
import type { ExpressiveAnimationSelection } from "./expressive-animation.ts";

export type AvatarConversationState =
	| "idle"
	| "thinking"
	| "responding"
	| "working"
	| "waiting"
	| "error";
const AvatarConversationContext =
	createContext<AvatarConversationState>("idle");
export const useAvatarConversationState = () =>
	useContext(AvatarConversationContext);
export function AvatarConversationProvider({
	state,
	children,
}: {
	state: AvatarConversationState;
	children: ReactNode;
}) {
	return (
		<AvatarConversationContext.Provider value={state}>
			{children}
		</AvatarConversationContext.Provider>
	);
}
export const AVATAR_CONVERSATION_POSES = {
	idle: { expression: "neutral", animation: "idle" },
	thinking: { expression: "curious", animation: "thinking" },
	responding: { expression: "attentive", animation: "idle" },
	working: { expression: "curious", animation: "thinking" },
	waiting: { expression: "attentive", animation: "notify" },
	error: { expression: "scared", animation: "alert" },
} as const satisfies Record<
	AvatarConversationState,
	{
		expression: ExpressiveExpressionSelection;
		animation: ExpressiveAnimationSelection;
	}
>;

/** Use only current conversation signals; completed history does not imply live work. */
export function resolveAvatarConversationState({
	status,
	error,
	pendingQuestion,
	messages,
}: {
	status: string;
	error?: unknown;
	pendingQuestion?: boolean;
	messages: readonly { role: string; parts?: readonly unknown[] }[];
}): AvatarConversationState {
	if (error || status === "error") {
		return "error";
	}
	if (pendingQuestion) {
		return "waiting";
	}
	const last = messages.at(-1);
	const parts = last?.role === "assistant" ? (last.parts ?? []) : [];
	if (
		parts.some((part) => {
			if (!(part && isNativeObjectLike(part))) {
				return false;
			}
			// SAFETY: isNativeObjectLike accepted this unchanged callback value as a non-null native object.
			const objectPart = part as object;
			return "state" in objectPart && objectPart.state === "approval-requested";
		})
	) {
		return "waiting";
	}
	if (status === "submitted") {
		return "thinking";
	}
	if (status !== "streaming") {
		return "idle";
	}
	for (let index = parts.length - 1; index >= 0; index -= 1) {
		const rawPart = parts[index];
		if (!(rawPart && isNativeObjectLike(rawPart))) {
			continue;
		}
		// SAFETY: isNativeObjectLike accepted this unchanged captured part as a non-null native object.
		const part = rawPart as object;
		if (!("type" in part && isNativeText(part.type))) {
			continue;
		}
		if (part.type === "reasoning") {
			return "thinking";
		}
		if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
			return "working";
		}
		if (
			part.type === "text" &&
			"text" in part &&
			isNativeText(part.text) &&
			part.text.trim()
		) {
			return "responding";
		}
	}
	return "thinking";
}

export function avatarStateFromRunStatus(
	status: string | null | undefined
): AvatarConversationState {
	if (status === "failed") {
		return "error";
	}
	if (status === "awaiting_input" || status === "interrupted") {
		return "waiting";
	}
	if (status === "running") {
		return "thinking";
	}
	return "idle";
}
