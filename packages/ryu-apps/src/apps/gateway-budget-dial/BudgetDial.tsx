// Gateway Budget Dial widget (spec §6 app 8, ranks 8/S).
//
// Reads the `ryu.gateway.budget` tool output — spend vs limit with a per-model
// breakdown — and renders a radial spend meter plus a draggable cap slider. The
// dragged cap is persisted to `widgetState` (survives reload, D4); confirming it
// dispatches a governed HITL policy write via `callTool('ryu.gateway.budget.set')`
// (the real Gateway rule write lands in B2, this B1 slice drives the pipe end to
// end against the stub provider). "Ask the agent" hands control back to the model
// via `sendFollowUpMessage`.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRyuGlobal } from "../../shared/useRyuGlobal";

/** The `ryu.gateway.budget.set` tool wire id the host pins to this widget's server. */
const BUDGET_SET_TOOL = "ryu.gateway.budget.set";

/** Ring geometry (donut gauge). */
const DIAL_SIZE = 180;
const DIAL_CENTER = DIAL_SIZE / 2;
const DIAL_RADIUS = 72;
const DIAL_CIRCUMFERENCE = 2 * Math.PI * DIAL_RADIUS;

/** Fraction of the cap above which the ring warns before it overruns. */
const WARN_FRACTION = 0.9;

interface ModelBreakdown {
	model: string;
	cost: number;
	calls: number;
}

interface BudgetOutput {
	spent: number;
	limit: number;
	currency: string;
	projected: number;
	breakdown_by_model: ModelBreakdown[];
}

interface BudgetInput {
	scope?: "user" | "org" | "session";
	period?: "day" | "month";
}

interface WidgetStateShape {
	draftCap?: number;
}

type RpcErrorLike = { code?: string; message?: string };

type SubmitState =
	| { kind: "idle" }
	| { kind: "pending" }
	| { kind: "success"; message: string }
	| { kind: "error"; message: string };

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function asBudgetOutput(value: unknown): BudgetOutput | null {
	if (!value || typeof value !== "object") {
		return null;
	}
	const raw = value as Record<string, unknown>;
	if (!(isFiniteNumber(raw.spent) && isFiniteNumber(raw.limit))) {
		return null;
	}
	const breakdown = Array.isArray(raw.breakdown_by_model)
		? (raw.breakdown_by_model as unknown[])
				.map((entry) => {
					if (!entry || typeof entry !== "object") {
						return null;
					}
					const e = entry as Record<string, unknown>;
					if (typeof e.model !== "string" || !isFiniteNumber(e.cost)) {
						return null;
					}
					return {
						model: e.model,
						cost: e.cost,
						calls: isFiniteNumber(e.calls) ? e.calls : 0,
					} satisfies ModelBreakdown;
				})
				.filter((entry): entry is ModelBreakdown => entry !== null)
		: [];
	return {
		spent: raw.spent,
		limit: raw.limit,
		currency: typeof raw.currency === "string" ? raw.currency : "USD",
		projected: isFiniteNumber(raw.projected) ? raw.projected : raw.spent,
		breakdown_by_model: breakdown,
	};
}

function makeMoneyFormatter(currency: string): Intl.NumberFormat {
	try {
		return new Intl.NumberFormat(undefined, {
			style: "currency",
			currency,
			maximumFractionDigits: 2,
		});
	} catch {
		return new Intl.NumberFormat(undefined, {
			style: "currency",
			currency: "USD",
			maximumFractionDigits: 2,
		});
	}
}

/** A point on the dial ring for a given fraction (0 at 12 o'clock, clockwise). */
function ringPoint(fraction: number, radius: number): { x: number; y: number } {
	const angle = fraction * 2 * Math.PI - Math.PI / 2;
	return {
		x: DIAL_CENTER + radius * Math.cos(angle),
		y: DIAL_CENTER + radius * Math.sin(angle),
	};
}

function roundStep(max: number): number {
	if (max <= 10) {
		return 0.5;
	}
	if (max <= 100) {
		return 1;
	}
	if (max <= 1000) {
		return 5;
	}
	return 25;
}

function Skeleton() {
	return (
		<div aria-busy="true" className="gbd-skeleton">
			<div className="gbd-skeleton-block gbd-skeleton-dial" />
			<div className="gbd-skeleton-block" style={{ width: "60%" }} />
			<div className="gbd-skeleton-block" style={{ width: "80%" }} />
			<div className="gbd-skeleton-block" style={{ width: "45%" }} />
		</div>
	);
}

export function BudgetDial() {
	const toolOutput = useRyuGlobal("toolOutput");
	const toolInput = useRyuGlobal("toolInput") as BudgetInput | undefined;
	const widgetState = useRyuGlobal("widgetState") as
		| WidgetStateShape
		| undefined
		| null;
	// Theme is applied to `data-theme` by WidgetRoot so tokens.css resolves; read it
	// too so a re-theme re-renders this subtree.
	useRyuGlobal("theme");

	const budget = useMemo(() => asBudgetOutput(toolOutput), [toolOutput]);

	const [draftCap, setDraftCap] = useState<number | null>(null);
	const [submit, setSubmit] = useState<SubmitState>({ kind: "idle" });

	// Initialise the draft cap from persisted widgetState, else the live limit, once
	// the budget output arrives. Re-syncs if the server pushes a new limit.
	useEffect(() => {
		if (!budget) {
			return;
		}
		const persisted = widgetState?.draftCap;
		setDraftCap((current) => {
			if (current !== null) {
				return current;
			}
			return isFiniteNumber(persisted) ? persisted : budget.limit;
		});
	}, [budget, widgetState?.draftCap]);

	const money = useMemo(
		() => makeMoneyFormatter(budget?.currency ?? "USD"),
		[budget?.currency],
	);

	const onDrag = useCallback((next: number) => {
		setDraftCap(next);
		setSubmit({ kind: "idle" });
		// Persist the dragged cap so it survives reload (D4). Best-effort.
		void window.ryu?.setWidgetState({ draftCap: next });
	}, []);

	const scope = toolInput?.scope ?? "user";
	const period = toolInput?.period ?? "month";

	const onConfirm = useCallback(async () => {
		if (draftCap === null) {
			return;
		}
		setSubmit({ kind: "pending" });
		try {
			await window.ryu?.callTool(BUDGET_SET_TOOL, {
				scope,
				limit: draftCap,
				period,
			});
			setSubmit({
				kind: "success",
				message: `Budget cap updated to ${money.format(draftCap)} per ${period}.`,
			});
		} catch (error) {
			const err = error as RpcErrorLike;
			const code = typeof err?.code === "string" ? err.code : "server_error";
			const message =
				typeof err?.message === "string" && err.message.length > 0
					? err.message
					: "The budget rule could not be saved.";
			setSubmit({ kind: "error", message: `${message} (${code})` });
		}
	}, [draftCap, scope, period, money]);

	const onAskAgent = useCallback(() => {
		if (!budget) {
			return;
		}
		const overrun = budget.projected > budget.limit;
		const prompt = overrun
			? `My ${scope} spend is projected to reach ${money.format(budget.projected)} against a ${money.format(budget.limit)} ${period} cap. What should I cut back on?`
			: `Explain my ${scope} Gateway spend of ${money.format(budget.spent)} this ${period} and which models are driving it.`;
		void window.ryu?.sendFollowUpMessage({ prompt });
	}, [budget, scope, period, money]);

	if (toolOutput === undefined || toolOutput === null) {
		return <Skeleton />;
	}

	if (!budget) {
		return (
			<p className="gbd-empty">
				No budget data is available for this scope yet.
			</p>
		);
	}

	const cap = draftCap ?? budget.limit;
	const spentFraction = cap > 0 ? Math.min(budget.spent / cap, 1) : 0;
	const spentRatio = cap > 0 ? budget.spent / cap : 0;
	const projectedOverrun = budget.projected > cap;
	const tone = projectedOverrun
		? "over"
		: spentRatio >= WARN_FRACTION
			? "warn"
			: "ok";

	const maxCap = Math.max(
		budget.limit * 2,
		budget.projected * 1.25,
		budget.spent * 1.25,
		1,
	);
	const step = roundStep(maxCap);
	const capChanged = Math.abs(cap - budget.limit) >= step / 2;

	const projPoint = ringPoint(
		cap > 0 ? Math.min(budget.projected / cap, 1) : 0,
		DIAL_RADIUS,
	);
	const capMarkInner = ringPoint(1, DIAL_RADIUS - 9);
	const capMarkOuter = ringPoint(1, DIAL_RADIUS + 9);

	const models = [...budget.breakdown_by_model].sort((a, b) => b.cost - a.cost);
	const maxModelCost = models.reduce((m, e) => Math.max(m, e.cost), 0);
	const pctLabel = `${Math.round(spentRatio * 100)}%`;

	return (
		<div className="gbd">
			<header className="gbd-header">
				<h2 className="gbd-title">Gateway budget</h2>
				<span className="gbd-scope">
					{scope} · {period}
				</span>
			</header>

			<section className="gbd-meter">
				<meter
					aria-label={`Gateway spend: ${money.format(budget.spent)} of ${money.format(cap)} cap`}
					className="gbd-sr-only"
					max={cap || 1}
					min={0}
					value={Math.min(budget.spent, cap || budget.spent)}
				>
					{money.format(budget.spent)} of {money.format(cap)}
				</meter>
				<svg
					aria-hidden="true"
					className="gbd-dial"
					focusable="false"
					height={DIAL_SIZE}
					viewBox={`0 0 ${DIAL_SIZE} ${DIAL_SIZE}`}
					width={DIAL_SIZE}
				>
					<circle
						className="gbd-dial-track"
						cx={DIAL_CENTER}
						cy={DIAL_CENTER}
						r={DIAL_RADIUS}
					/>
					<circle
						className="gbd-dial-value"
						cx={DIAL_CENTER}
						cy={DIAL_CENTER}
						data-tone={tone}
						r={DIAL_RADIUS}
						strokeDasharray={`${DIAL_CIRCUMFERENCE * spentFraction} ${DIAL_CIRCUMFERENCE}`}
						transform={`rotate(-90 ${DIAL_CENTER} ${DIAL_CENTER})`}
					/>
					<line
						className="gbd-dial-cap"
						x1={capMarkInner.x}
						x2={capMarkOuter.x}
						y1={capMarkInner.y}
						y2={capMarkOuter.y}
					/>
					{projectedOverrun ? null : (
						<line
							className="gbd-dial-proj"
							x1={DIAL_CENTER}
							x2={projPoint.x}
							y1={DIAL_CENTER}
							y2={projPoint.y}
						/>
					)}
					<text
						className="gbd-dial-center-primary"
						dominantBaseline="middle"
						textAnchor="middle"
						x={DIAL_CENTER}
						y={DIAL_CENTER - 6}
					>
						{money.format(budget.spent)}
					</text>
					<text
						className="gbd-dial-center-secondary"
						dominantBaseline="middle"
						textAnchor="middle"
						x={DIAL_CENTER}
						y={DIAL_CENTER + 16}
					>
						{pctLabel} of {money.format(cap)}
					</text>
				</svg>

				<div className="gbd-summary">
					<div>
						<div className="gbd-stat-label">Spent</div>
						<div className="gbd-stat-value">{money.format(budget.spent)}</div>
					</div>
					<div>
						<div className="gbd-stat-label">Projected</div>
						<div className="gbd-stat-value" data-over={projectedOverrun}>
							{money.format(budget.projected)}
						</div>
					</div>
					<div>
						<div className="gbd-stat-label">Current cap</div>
						<div className="gbd-stat-value">{money.format(budget.limit)}</div>
					</div>
				</div>
			</section>

			<section className="gbd-control">
				<div className="gbd-control-row">
					<label className="gbd-control-label" htmlFor="gbd-cap">
						New cap
					</label>
					<span className="gbd-control-value">{money.format(cap)}</span>
				</div>
				<input
					aria-valuetext={money.format(cap)}
					className="gbd-slider"
					id="gbd-cap"
					max={maxCap}
					min={0}
					onChange={(event) => onDrag(Number(event.target.value))}
					step={step}
					type="range"
					value={cap}
				/>
				<div className="gbd-actions">
					<button
						className="gbd-btn"
						data-variant="primary"
						disabled={!capChanged || submit.kind === "pending"}
						onClick={onConfirm}
						type="button"
					>
						{submit.kind === "pending" ? "Saving…" : "Confirm new cap"}
					</button>
					<button className="gbd-btn" onClick={onAskAgent} type="button">
						Ask the agent
					</button>
				</div>
				{submit.kind === "error" ? (
					<p className="gbd-status" data-kind="error" role="alert">
						{submit.message}
					</p>
				) : null}
				{submit.kind === "success" ? (
					<p className="gbd-status" data-kind="success" role="status">
						{submit.message}
					</p>
				) : null}
			</section>

			<section className="gbd-models">
				<h3 className="gbd-models-title">By model</h3>
				{models.length === 0 ? (
					<p className="gbd-empty">No model spend recorded this period.</p>
				) : (
					models.map((entry) => (
						<div className="gbd-bar-row" key={entry.model}>
							<span className="gbd-bar-name" title={entry.model}>
								{entry.model}
							</span>
							<span className="gbd-bar-cost">{money.format(entry.cost)}</span>
							<div className="gbd-bar-track">
								<div
									className="gbd-bar-fill"
									style={{
										width: `${maxModelCost > 0 ? (entry.cost / maxModelCost) * 100 : 0}%`,
									}}
								/>
							</div>
							<span className="gbd-bar-calls">
								{entry.calls.toLocaleString()} calls
							</span>
						</div>
					))
				)}
			</section>
		</div>
	);
}
