"use client";

import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import {
	ToolApproval,
	type ToolApprovalChoice,
	ToolApprovalCode,
} from "@ryu/ui/components/agents/tool-approval.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { memo, useMemo } from "react";
import {
	ENDPOINT_ROW_ID,
	standingChoice,
	summarizePermissionCall,
} from "./permission-call-summary.ts";
import { readPermissionToolFields } from "./permission-contract.ts";
import { type PermissionI18n, readPermissionI18n } from "./permission-i18n.ts";

export { activePermissionSchema } from "./permission-contract.ts";

import type { AcpPermissionOption } from "@/src/lib/api/acp.ts";

export interface ActivePermission {
	options: AcpPermissionOption[];
	requestId: string;
	toolCall: unknown;
}

export interface PermissionPromptProps {
	className?: string;
	embedded?: boolean;
	onRespond: (optionId: string | null) => void;
	permission: ActivePermission;
	/** Show raw tool input for technical interface levels. */
	showTechnicalDetails?: boolean;
}

const ALLOW_KINDS = new Set(["allow_once", "allow_always"]);

function approvalQuestion(title: string, tl: LiteralMessage): string {
	const action = title.trim().replace(/[?!.]+$/u, "");
	if (!action) {
		return tl("Can I run this tool?");
	}
	return tl("Can I {action}?", {
		action: `${action.slice(0, 1).toLowerCase()}${action.slice(1)}`,
	});
}

interface PromptCopy {
	description: string;
	question: string;
	tool: string;
}

/**
 * The prompt's sentences. Ryu's own prompts carry whole localized sentences
 * (`toolCall.i18n`); a third-party agent's prompt keeps its own title inside the
 * localized frame; a prompt with no title gets whole sentences of its own.
 */
function promptCopy(
	i18n: PermissionI18n | null,
	fields: ReturnType<typeof readPermissionToolFields>,
	showTechnicalDetails: boolean,
	tl: LiteralMessage
): PromptCopy {
	const withKind = (text: string) =>
		showTechnicalDetails && fields.kind ? `${fields.kind} · ${text}` : text;
	if (i18n) {
		return {
			description: showTechnicalDetails
				? tl("The agent is asking for permission to do this.")
				: tl("Ryu wants to do this. Review the details before it runs."),
			question: i18n.title,
			tool: withKind(i18n.title),
		};
	}
	const title = fields.title?.trim();
	if (!title) {
		return {
			description: showTechnicalDetails
				? tl("The agent is asking to run a tool.")
				: tl("Ryu wants to run a tool. Review the details before it runs."),
			question: tl("Can I run this tool?"),
			tool: showTechnicalDetails && fields.kind ? fields.kind : tl("Tool"),
		};
	}
	return {
		description: showTechnicalDetails
			? tl("The agent is asking to {title}.", { title })
			: tl("Ryu wants to {title}. Review the details before it runs.", {
					title,
				}),
		question: approvalQuestion(title, tl),
		tool: withKind(title),
	};
}

/**
 * A choice's label: Core's message for Ryu's own prompts, with the one-word
 * "Deny" catalogued here (Core's extractor skips one-word sources); a
 * third-party agent's option keeps its own name.
 */
function optionLabel(
	option: AcpPermissionOption,
	i18n: PermissionI18n | null,
	tl: LiteralMessage
): string {
	if (!i18n) {
		return option.name;
	}
	const label = i18n.optionLabels.get(option.optionId);
	if (label) {
		return label;
	}
	return option.kind === "reject_once" ? tl("Deny") : option.name;
}

function toneForKind(kind: string): ToolApprovalChoice["tone"] {
	if (kind === "allow_once") {
		return "primary";
	}
	if (ALLOW_KINDS.has(kind)) {
		return "secondary";
	}
	return "ghost";
}

/**
 * Inline allow/reject prompt shown in the composer when an ACP agent in a
 * permission-gating mode asks to run a tool (Zed-style). One button per
 * agent-reported option; the chosen option id is sent back to Core to unblock
 * the awaiting turn.
 */
export const PermissionPrompt = memo(function PermissionPrompt({
	embedded = false,
	className,
	permission,
	onRespond,
	showTechnicalDetails = true,
}: PermissionPromptProps) {
	const tl = useLiteralMessages();
	const fields = useMemo(
		() => readPermissionToolFields(permission.toolCall),
		[permission.toolCall]
	);
	const i18n = useMemo(
		() => readPermissionI18n(permission.toolCall, tl),
		[permission.toolCall, tl]
	);
	const copy = promptCopy(i18n, fields, showTechnicalDetails, tl);
	// What the call is: the endpoint and the fields that decide what it does are
	// always on the card, at every interface level (permission-call-summary.ts).
	const summary = useMemo(
		() => summarizePermissionCall(i18n?.detail ?? null, fields.rawInput),
		[fields, i18n]
	);
	const { command } = summary;
	const standing = standingChoice(summary, permission.options);

	const choices = useMemo<ToolApprovalChoice[]>(
		() =>
			permission.options.map((option) => ({
				id: option.optionId,
				label: optionLabel(option, i18n, tl),
				tone: toneForKind(option.kind),
				onSelect: () => onRespond(option.optionId),
			})),
		[i18n, onRespond, permission.options, tl]
	);

	return (
		<div
			className={cn(
				embedded ? "w-full" : "mx-auto mb-1 w-full max-w-[720px] px-3",
				className
			)}
			data-composer-prompt="approval"
		>
			<ToolApproval
				choices={choices}
				description={copy.description}
				parameters={summary.details}
				question={copy.question}
				status="pending"
				title={
					showTechnicalDetails
						? tl("Permission required")
						: tl("Ryu wants to take an action")
				}
				tool={copy.tool}
			>
				{command || summary.call.length > 0 ? (
					<div className="grid gap-2">
						{/* Always show the command: it is what the user is approving, and the
						    title/description above are agent-supplied text. */}
						{command ? (
							<ToolApprovalCode code={command} language="bash" />
						) : null}
						{summary.call.length > 0 ? (
							<dl
								className="grid gap-2 rounded-lg bg-muted p-3"
								data-permission-call=""
							>
								{summary.call.map((row) => (
									<div
										className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] items-start gap-3 text-xs"
										key={row.id}
									>
										<dt className="text-muted-foreground">
											{row.id === ENDPOINT_ROW_ID ? tl("Endpoint") : row.label}
										</dt>
										<dd className="max-h-24 min-w-0 overflow-y-auto break-words font-mono text-foreground">
											{row.value}
										</dd>
									</div>
								))}
							</dl>
						) : null}
						{standing ? (
							<p className="text-status-warning text-xs leading-5">
								{tl(
									"“{choice}” also allows every later call to this endpoint in this chat, with any arguments and without asking again.",
									{ choice: optionLabel(standing, i18n, tl) }
								)}
							</p>
						) : null}
					</div>
				) : null}
			</ToolApproval>
		</div>
	);
});
