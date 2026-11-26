"use client";

import {
	ArrowDown01Icon,
	ArrowUp01Icon,
	DragDropVerticalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useReorderShift } from "@ryu/ui/hooks/use-reorder-shift.tsx";
import { useEffect, useId, useRef, useState } from "react";
import type {
	OAuthAccountPoolPolicy,
	PiAccount,
	PiProvider,
} from "@/src/lib/api/pi-config.ts";
import { moveBy, moveOnto, orderByPriority } from "./credential-order.ts";

type Rules = OAuthAccountPoolPolicy["accounts"];
type Rule = Rules[string];

interface Props {
	accounts: PiAccount[];
	capabilities: NonNullable<PiProvider["accountRouting"]>;
	/** Last characters of each API key, by account id. */
	hints?: Record<string, string>;
	/** The user moved a row; `order` lists every account, first to try first. */
	onOrder: (order: string[]) => void;
	onRule: (accountId: string, change: Partial<Rule>) => void;
	providerId: string;
	/** The draft rules; the saved priorities give the first order. */
	rules: Rules;
	saving: boolean;
}

/**
 * The provider's credentials as one ordered list. A row moves by dragging its
 * handle (mouse, pen or finger), with its arrow buttons, or with the up and
 * down arrow keys while the handle has focus.
 */
export function AccountOrderList({
	accounts,
	capabilities,
	hints,
	onOrder,
	onRule,
	providerId,
	rules,
	saving,
}: Props) {
	const tl = useLiteralMessages();
	const listId = useId();
	const ids = accounts.map((account) => account.accountId);
	const [order, setOrder] = useState(() => orderByPriority(ids, rules));
	const [draggingId, setDraggingId] = useState<string | null>(null);
	const [overId, setOverId] = useState<string | null>(null);
	const [announcement, setAnnouncement] = useState("");
	const touchPointer = useRef<number | null>(null);
	const focusAfterMove = useRef<string | null>(null);
	const shift = useReorderShift({ activeId: draggingId, axis: "y", overId });

	// Accounts can be added or removed while the list is open: keep the known
	// rows where they are and put new ones at the end.
	const shown = [
		...order.filter((id) => ids.includes(id)),
		...ids.filter((id) => !order.includes(id)),
	];
	const byId = new Map(accounts.map((account) => [account.accountId, account]));
	const mixedKinds = new Set(accounts.map((account) => account.kind)).size > 1;

	useEffect(() => {
		if (focusAfterMove.current) {
			document.getElementById(focusAfterMove.current)?.focus();
			focusAfterMove.current = null;
		}
	});

	const handleId = (accountId: string) => `${listId}-handle-${accountId}`;
	const commit = (next: string[], moved: string) => {
		setOrder(next);
		onOrder(next);
		setAnnouncement(
			tl("{label} is now {position} of {total}", {
				label: byId.get(moved)?.label ?? moved,
				position: next.indexOf(moved) + 1,
				total: next.length,
			})
		);
	};
	const nudge = (accountId: string, delta: -1 | 1) => {
		const next = moveBy(shown, accountId, delta);
		if (next.join("\u0000") === shown.join("\u0000")) {
			return;
		}
		focusAfterMove.current = handleId(accountId);
		commit(next, accountId);
	};
	const endDrag = () => {
		touchPointer.current = null;
		setDraggingId(null);
		setOverId(null);
	};
	const hover = (accountId: string, clientX: number, clientY: number) => {
		const resolved = shift.resolveOver(accountId, clientX, clientY);
		setOverId((previous) => (previous === resolved ? previous : resolved));
	};
	const drop = (fallbackTarget: string | null) => {
		const target = overId ?? fallbackTarget;
		if (draggingId && target && target !== draggingId) {
			commit(moveOnto(shown, draggingId, target), draggingId);
		}
		endDrag();
	};
	const rowUnder = (clientX: number, clientY: number) =>
		document
			.elementFromPoint(clientX, clientY)
			?.closest<HTMLElement>("[data-credential-row]")?.dataset.credentialRow;

	if (shown.length === 0) {
		return null;
	}
	return (
		<div>
			<p className="font-medium text-sm">Accounts</p>
			<ul className="m-0 list-none p-0" data-slot="credential-order">
				{shown.map((accountId, index) => {
					const account = byId.get(accountId);
					if (!account) {
						return null;
					}
					const rule: Rule = rules[accountId] ?? {
						enabled: true,
						priority: 0,
					};
					const names = { label: account.label, provider: providerId };
					const hint = hints?.[accountId];
					const isDragging = draggingId === accountId;
					const isDragOver =
						overId === accountId &&
						draggingId !== null &&
						!isDragging &&
						!shift.previewing;
					const dropBelow =
						isDragOver &&
						draggingId !== null &&
						shown.indexOf(draggingId) < index;
					let kindText: string | null = null;
					if (hint) {
						kindText = tl("Key ending in {hint}", { hint });
					} else if (mixedKinds) {
						kindText =
							account.kind === "api_key"
								? tl("API key")
								: tl("Subscription account");
					}
					return (
						<li
							className={`relative flex flex-wrap items-center gap-2 border-border border-b py-2 last:border-b-0 ${isDragging ? "opacity-50" : ""}`}
							data-credential-row={accountId}
							key={accountId}
							onDragOver={(event) => {
								if (draggingId) {
									event.preventDefault();
									if (event.dataTransfer) {
										event.dataTransfer.dropEffect = "move";
									}
									hover(accountId, event.clientX, event.clientY);
								}
							}}
							onDrop={(event) => {
								event.preventDefault();
								drop(accountId);
							}}
							ref={shift.register(accountId)}
							style={shift.styleFor(accountId)}
						>
							{isDragOver ? (
								<div
									className={`reorder-drop-indicator pointer-events-none absolute inset-x-1 z-10 h-0.5 bg-primary ${dropBelow ? "bottom-0" : "top-0"}`}
								/>
							) : null}
							<button
								aria-label={tl(
									"Drag {label} to change the order, or press the up or down arrow key",
									{ label: account.label }
								)}
								className="flex size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground hover:bg-muted active:cursor-grabbing"
								draggable
								id={handleId(accountId)}
								onDragEnd={endDrag}
								onDragStart={(event) => {
									if (event.dataTransfer) {
										event.dataTransfer.effectAllowed = "move";
										event.dataTransfer.setData("text/plain", accountId);
									}
									setDraggingId(accountId);
								}}
								onKeyDown={(event) => {
									if (event.key === "ArrowUp") {
										event.preventDefault();
										nudge(accountId, -1);
									} else if (event.key === "ArrowDown") {
										event.preventDefault();
										nudge(accountId, 1);
									}
								}}
								onPointerCancel={endDrag}
								onPointerDown={(event) => {
									// A mouse uses the browser's own drag. A finger or a pen does
									// not start one, so follow the pointer here.
									if (event.pointerType === "mouse") {
										return;
									}
									touchPointer.current = event.pointerId;
									try {
										// Keep the moves coming to the handle while the finger
										// travels over other rows.
										event.currentTarget.setPointerCapture(event.pointerId);
									} catch {
										// The pointer is already gone; the drag ends on its own.
									}
									setOverId(null);
									setDraggingId(accountId);
								}}
								onPointerMove={(event) => {
									if (touchPointer.current !== event.pointerId) {
										return;
									}
									const hovered = rowUnder(event.clientX, event.clientY);
									if (hovered && shown.includes(hovered)) {
										hover(hovered, event.clientX, event.clientY);
									}
								}}
								onPointerUp={(event) => {
									if (touchPointer.current === event.pointerId) {
										drop(null);
									}
								}}
								type="button"
							>
								<HugeiconsIcon className="size-4" icon={DragDropVerticalIcon} />
							</button>
							<span
								aria-hidden="true"
								className="w-4 shrink-0 text-end text-detail text-muted-foreground tabular-nums"
							>
								{index + 1}
							</span>
							<span className="flex min-w-24 flex-1 items-baseline gap-2 overflow-hidden">
								<span className="truncate text-sm" title={account.label}>
									{account.label}
								</span>
								{kindText ? (
									<span
										className="shrink-0 text-detail text-muted-foreground"
										data-slot="credential-kind"
									>
										{kindText}
									</span>
								) : null}
							</span>
							<Label
								htmlFor={`oauth-enabled-${accountId}`}
								id={`oauth-enabled-label-${accountId}`}
								size="compact"
							>
								Use
								<span className="sr-only">
									{" "}
									{tl("{label} for {provider}", names)}
								</span>
							</Label>
							<Switch
								aria-labelledby={`oauth-enabled-label-${accountId}`}
								checked={rule.enabled}
								id={`oauth-enabled-${accountId}`}
								onCheckedChange={(enabled) => onRule(accountId, { enabled })}
							/>
							<Label htmlFor={`oauth-priority-${accountId}`} size="compact">
								Priority
							</Label>
							<Input
								aria-label={tl("Priority for {label} on {provider}", names)}
								className="w-16"
								id={`oauth-priority-${accountId}`}
								max={100}
								min={0}
								onChange={(event) =>
									onRule(accountId, { priority: Number(event.target.value) })
								}
								type="number"
								value={rule.priority}
							/>
							{capabilities.quotaObservations ? (
								<div className="space-y-1">
									<Label
										htmlFor={`oauth-account-drain-${accountId}`}
										size="compact"
									>
										Drain override (%)
									</Label>
									<Input
										aria-label={tl(
											"Drain override for {label} on {providerId}",
											{ label: account.label, providerId }
										)}
										className="w-36"
										disabled={saving}
										id={`oauth-account-drain-${accountId}`}
										max={100}
										min={0}
										onChange={(event) =>
											onRule(accountId, {
												drainThresholdPercent:
													event.target.value === ""
														? null
														: Number(event.target.value),
											})
										}
										placeholder="Provider default"
										step={1}
										type="number"
										value={rule.drainThresholdPercent ?? ""}
									/>
								</div>
							) : null}
							<Button
								aria-label={tl("Move {label} up", { label: account.label })}
								disabled={index === 0}
								onClick={() => nudge(accountId, -1)}
								size="icon-sm"
								type="button"
								variant="ghost"
							>
								<HugeiconsIcon className="size-4" icon={ArrowUp01Icon} />
							</Button>
							<Button
								aria-label={tl("Move {label} down", { label: account.label })}
								disabled={index === shown.length - 1}
								onClick={() => nudge(accountId, 1)}
								size="icon-sm"
								type="button"
								variant="ghost"
							>
								<HugeiconsIcon className="size-4" icon={ArrowDown01Icon} />
							</Button>
						</li>
					);
				})}
			</ul>
			<p aria-live="polite" className="sr-only" data-slot="order-announcement">
				{announcement}
			</p>
			<p className="mt-2 text-detail text-muted-foreground">
				{tl(
					"Rows are tried from top to bottom. Drag a row or use its arrows to change the order. Two rows with the same priority number share work."
				)}{" "}
				{capabilities.quotaObservations
					? tl(
							"Lower priority numbers are tried first. Blank inherits the provider drain point; 0 disables proactive drain. Fully exhausted accounts remain unavailable."
						)
					: tl("Lower priority numbers are tried first.")}
			</p>
		</div>
	);
}
