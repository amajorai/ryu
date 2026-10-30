// apps/desktop/src/components/panels/SessionBoxPanel.tsx
//
// The "Box screen" workspace tab: the live screen of THIS conversation's
// session Box (or one of its sub-agent Boxes), next to the chat.
//
// A session Box is the conversation's hands: computer use, the browser and
// cloud tasks run on its own virtual desktop instead of the node's shared one.
// This panel only projects Core's state and asks Core for screen grants:
//
// - Hosted nodes answer with a DIRECT grant. The viewer dials the Box ingress
//   with the single-use token in a WebSocket subprotocol, so video never
//   crosses the node.
// - Self-hosted nodes answer with a RELAY grant. The viewer takes a one-use
//   Core ticket for the `session-box` route and dials Core, which bridges.
//
// Every (re)connect mints a new grant. Asking for a parked Box's screen
// resumes it.
//
// The screen opens VIEW-ONLY: the grant asks for a `viewOnly` token, so the
// Box service drops every input message. Input only reaches the Box after an
// explicit "Take control", which reconnects with an interactive grant for
// that one Box. Switching Boxes, or "Stop control", goes back to watching. The node's own desktop stays in the Virtual Desktop panel.

import { CLOUD_TASKS_BOX_BACKEND_FLAG } from "@ryu/auth/lib/feature-flags";
import { VncCanvas } from "@ryu/blocks/session-box/vnc-canvas.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useState } from "react";
import {
	BoxCostChip,
	BoxCreditBanner,
} from "@/src/components/chat/BoxCostChip.tsx";
import { useFeatureFlag } from "@/src/hooks/useFeatureFlag.ts";
import {
	openSessionBoxScreen,
	SESSION_BOX_QUERY_KEY,
	useSessionBox,
	useSessionBoxScreenRequest,
} from "@/src/hooks/useSessionBox.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	connectSessionBoxScreen,
	extendSessionBox,
	resumeSessionBox,
	type SessionBoxState,
	type SessionBoxView,
	sessionBoxErrorMessage,
	sessionBoxKey,
	stopSessionBox,
} from "@/src/lib/api/session-box.ts";
import { clearMediaSource, publishMediaSource } from "@/src/lib/media-pip.ts";

const STATE_LABELS: Record<SessionBoxState, string> = {
	provisioning: "Starting",
	ready: "Running",
	parked: "Parked",
	stopped: "Stopped",
	error: "Error",
};

const STATE_DOTS: Record<SessionBoxState, string> = {
	provisioning: "bg-warning",
	ready: "bg-success",
	parked: "bg-muted-foreground/40",
	stopped: "bg-muted-foreground/40",
	error: "bg-destructive",
};

/** How much one Extend adds to a running session Box's lifetime. */
const EXTEND_SECONDS = 60 * 60;

/** The page origin, sent for clients whose requests carry no `Origin` header. */
function pageOrigin(): string | null {
	try {
		const origin = window.location.origin;
		return origin && origin !== "null" ? origin : null;
	} catch {
		return null;
	}
}

function boxLabel(view: SessionBoxView): string {
	return view.child === null ? "This session" : `Sub-agent ${view.child}`;
}

function Notice({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground text-xs">
			{children}
		</div>
	);
}

export interface SessionBoxPanelProps {
	/** Connect only while the tab is visible. */
	active?: boolean;
	conversationId: string;
	target: ApiTarget;
}

export function SessionBoxPanel({
	active = true,
	conversationId,
	target,
}: SessionBoxPanelProps) {
	const tl = useLiteralMessages();
	const enabled = useFeatureFlag(CLOUD_TASKS_BOX_BACKEND_FLAG);
	const queryClient = useQueryClient();
	const selectId = useId();
	const { data: status, isPending } = useSessionBox(
		target,
		conversationId,
		enabled
	);
	const request = useSessionBoxScreenRequest(conversationId);
	const [child, setChild] = useState<number | null>(request?.child ?? null);
	// The key of the Box the user took control of. Every other Box, and this
	// one until the user asks, is watched view-only.
	const [controlledKey, setControlledKey] = useState<string | null>(null);
	const [connection, setConnection] = useState(0);
	const [pending, setPending] = useState(false);

	useEffect(() => {
		if (request) {
			setChild(request.child);
		}
	}, [request]);

	const boxes: SessionBoxView[] = status
		? [...(status.box ? [status.box] : []), ...status.children]
		: [];
	const selected =
		boxes.find((view) => view.child === child) ?? boxes[0] ?? null;
	const key = sessionBoxKey(conversationId, selected?.child ?? null);
	const mediaSourceId = `session-box:${target.url}:${key}`;
	const viewOnly = controlledKey !== key;

	const connect = useCallback(
		() =>
			connectSessionBoxScreen(target, key, {
				viewOnly,
				origin: pageOrigin(),
			}).catch((failure: unknown) => {
				throw new Error(sessionBoxErrorMessage(failure));
			}),
		[key, target, viewOnly]
	);

	const invalidate = () => {
		Promise.resolve(
			queryClient.invalidateQueries({
				queryKey: [SESSION_BOX_QUERY_KEY, target.url],
			})
		).catch(() => undefined);
	};

	const runAction = async (action: "stop" | "resume" | "extend") => {
		setPending(true);
		try {
			if (action === "stop") {
				await stopSessionBox(target, key);
				toast.success("Box parked. Its work is saved.");
			} else if (action === "extend") {
				const until = await extendSessionBox(target, key, EXTEND_SECONDS);
				toast.success(
					until
						? tl("Box extended until {time}.", {
								time: new Date(until).toLocaleTimeString(),
							})
						: "Box extended."
				);
			} else {
				await resumeSessionBox(target, key);
				setConnection((value) => value + 1);
			}
			invalidate();
		} catch (failure) {
			toast.error(sessionBoxErrorMessage(failure));
		} finally {
			setPending(false);
		}
	};

	if (!enabled) {
		return <Notice>Box screens are not available for this account.</Notice>;
	}
	if (isPending && status === undefined) {
		return <Notice>Loading this session's Box…</Notice>;
	}
	if (!selected) {
		return (
			<Notice>
				<p className="max-w-xs">
					This conversation has no Box yet. One starts when the agent uses the
					computer or the browser, runs a cloud task, or runs sub-agents in
					parallel.
				</p>
			</Notice>
		);
	}

	const state = selected.state;
	const live = state === "ready";
	const parked = state === "parked" || state === "stopped";
	let body: React.ReactNode;
	if (live && selected.desktop?.ready !== false) {
		body = (
			<VncCanvas
				active={active}
				connect={connect}
				key={`${key}:${connection}`}
				mediaSourceId={mediaSourceId}
				onPreviewClear={clearMediaSource}
				onPreviewFrame={(frame) =>
					publishMediaSource({ ...frame, kind: "desktop" })
				}
				title={tl("{boxName} · Box screen", { boxName: boxLabel(selected) })}
				viewOnly={viewOnly}
			/>
		);
	} else if (live) {
		body = <Notice>The Box's screen is starting…</Notice>;
	} else if (state === "provisioning") {
		body = <Notice>Starting this session's Box…</Notice>;
	} else if (parked) {
		body = (
			<Notice>
				<p className="max-w-xs">
					This Box is parked. Its work is saved, and it resumes on the next task
					or when you resume it here.
				</p>
				<Button
					disabled={pending}
					onClick={() => runAction("resume")}
					size="sm"
					type="button"
					variant="secondary"
				>
					{pending ? "Resuming…" : "Resume Box"}
				</Button>
			</Notice>
		);
	} else {
		body = <Notice>This Box hit an error and is not running.</Notice>;
	}

	return (
		<div className="flex h-full min-h-0 flex-col" data-session-box-key={key}>
			<div className="flex shrink-0 flex-wrap items-center gap-2 border-border border-b bg-sidebar px-2 py-1.5">
				{boxes.length > 1 ? (
					<>
						<label className="sr-only" htmlFor={selectId}>
							Box
						</label>
						<select
							className="max-w-36 rounded-lg border bg-background px-1.5 py-0.5 text-xs"
							id={selectId}
							onChange={(event) =>
								setChild(
									event.target.value === "" ? null : Number(event.target.value)
								)
							}
							value={selected.child === null ? "" : String(selected.child)}
						>
							{boxes.map((view) => (
								<option
									key={view.child ?? "session"}
									value={view.child === null ? "" : String(view.child)}
								>
									{boxLabel(view)}
								</option>
							))}
						</select>
					</>
				) : (
					<span className="min-w-0 truncate text-muted-foreground text-xs">
						{boxLabel(selected)}
					</span>
				)}
				<span
					aria-hidden
					className={`size-1.5 shrink-0 rounded-full ${state ? STATE_DOTS[state] : "bg-muted-foreground/40"}`}
				/>
				<span className="text-muted-foreground text-xs" role="status">
					{state ? STATE_LABELS[state] : "Unknown"}
				</span>
				<BoxCostChip box={selected} />
				<div className="ms-auto flex items-center gap-0.5">
					<Button
						aria-pressed={!viewOnly}
						disabled={!live}
						onClick={() => setControlledKey(viewOnly ? key : null)}
						size="sm"
						title={
							viewOnly
								? "Send your mouse and keyboard to this Box"
								: "Go back to watching without input"
						}
						type="button"
						variant="ghost"
					>
						{viewOnly ? "Take control" : "Stop control"}
					</Button>
					<Button
						disabled={!live}
						onClick={() => setConnection((value) => value + 1)}
						size="sm"
						type="button"
						variant="ghost"
					>
						Reconnect
					</Button>
					{live && selected.expiresAt ? (
						<Button
							disabled={pending}
							onClick={() => runAction("extend")}
							size="sm"
							title={tl("Runs until {time}", {
								time: new Date(selected.expiresAt).toLocaleTimeString(),
							})}
							type="button"
							variant="ghost"
						>
							Extend 1 h
						</Button>
					) : null}
					{live || state === "provisioning" ? (
						<Button
							disabled={pending}
							onClick={() => runAction("stop")}
							size="sm"
							type="button"
							variant="ghost"
						>
							{pending ? "Parking…" : "Park"}
						</Button>
					) : null}
				</div>
			</div>
			<div className="shrink-0 px-2 pt-1 empty:hidden">
				<BoxCreditBanner box={selected} />
			</div>
			<div className="relative min-h-0 flex-1 bg-black">{body}</div>
		</div>
	);
}

/**
 * The sub-agent Boxes of a conversation, for the Subagents tab. Each row opens
 * that child's screen in the Box screen tab. Renders nothing without children.
 */
export function SessionBoxChildScreens({
	conversationId,
	target,
}: {
	conversationId: string;
	target: ApiTarget;
}) {
	const enabled = useFeatureFlag(CLOUD_TASKS_BOX_BACKEND_FLAG);
	const { data: status } = useSessionBox(target, conversationId, enabled);
	const children = enabled ? (status?.children ?? []) : [];
	if (children.length === 0) {
		return null;
	}
	return (
		<section
			aria-label="Sub-agent screens"
			className="flex shrink-0 flex-col gap-1 border-border border-b px-3 py-2"
		>
			<h3 className="font-medium text-muted-foreground text-xs">
				Sub-agent screens
			</h3>
			<ul className="flex flex-col gap-1">
				{children.map((view) => (
					<li
						className="flex min-w-0 items-center gap-2 text-xs"
						key={view.child ?? view.id ?? "child"}
					>
						<span className="min-w-0 flex-1 truncate">{boxLabel(view)}</span>
						<span className="text-muted-foreground">
							{view.state ? STATE_LABELS[view.state] : "Unknown"}
						</span>
						<BoxCostChip box={view} />
						<Button
							onClick={() => openSessionBoxScreen(conversationId, view.child)}
							size="sm"
							type="button"
							variant="ghost"
						>
							View screen
						</Button>
					</li>
				))}
			</ul>
		</section>
	);
}
