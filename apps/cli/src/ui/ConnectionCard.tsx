/* @jsxImportSource @opentui/react */
// Guided "Core is not reachable" state (opencode's reconnecting card): names the
// node, lists what the user can do about it, and shows a muted auto-retry
// countdown driven by the shared health poller (core/useCoreHealth.ts).
//
// ConnectionCard is presentational; CoreConnectionCard wires it to CoreContext,
// the shared health poller and the product mode. Keys are bound by the hosting
// surface (Home binds s/r; Chat binds neither because its composer owns
// printable keys), so the card lists s/r only when the host says they are live.

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { isLocal } from "../core/bootstrap.ts";
import { useCore } from "../core/CoreContext.tsx";
import { useCoreHealth } from "../core/CoreHealthContext.tsx";
import { displayHostPort } from "../core/native-errors.ts";
import { useCliProductMode } from "../core/ProductModeContext.tsx";

/** Headline for an unreachable node: local nodes "aren't running", remote ones
 * "aren't reachable". */
export function connectionHeadline(url: string): string {
	const where = displayHostPort(url);
	return isLocal(url)
		? `Core isn't running at ${where}`
		: `Core isn't reachable at ${where}`;
}

/** "retrying in Ns…" for a scheduled retry, or "retrying…" when it is due. */
export function retryCountdown(nextRetryAt: number, now: number): string {
	const seconds = Math.ceil((nextRetryAt - now) / 1000);
	return seconds > 0 ? `retrying in ${seconds}s…` : "retrying…";
}

interface ConnectionAction {
	key: string;
	label: string;
}

export interface ConnectionCardProps {
	/** False while a text field owns typing: s/r are not bound then. */
	keysActive: boolean;
	nextRetryAt: number | null;
	/** Latest start-Core progress line (also shown after a failed start). */
	progress: string | null;
	showStart: boolean;
	showSwitchNode: boolean;
	starting: boolean;
	url: string;
}

export function ConnectionCard({
	keysActive,
	nextRetryAt,
	progress,
	showStart,
	showSwitchNode,
	starting,
	url,
}: ConnectionCardProps) {
	const theme = useTheme();
	const [now, setNow] = useState(() => Date.now());

	// Tick once a second while a retry is scheduled so the countdown moves.
	useEffect(() => {
		if (nextRetryAt === null) {
			return;
		}
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [nextRetryAt]);

	const actions: ConnectionAction[] = [];
	if (keysActive && showStart) {
		actions.push({ key: "s", label: "start Core" });
	}
	if (showSwitchNode) {
		actions.push({ key: "^N", label: "switch node" });
	}
	if (keysActive) {
		actions.push({ key: "r", label: "retry" });
	}

	let status = "checking…";
	if (starting && progress) {
		status = progress;
	} else if (nextRetryAt !== null) {
		status = retryCountdown(nextRetryAt, now);
	}

	// Without live keys (Chat) the card stays compact: actions and the "open Home"
	// pointer share one row, and the spinner line already says it auto-retries.
	return (
		<box flexShrink={0}>
			<Card borderColor={theme.colors.warning} bordered>
				<text fg={theme.colors.warning}>
					<b>{connectionHeadline(url)}</b>
				</text>
				{!starting && progress ? (
					<text fg={theme.colors.mutedForeground}>{progress}</text>
				) : null}
				<box flexDirection="row" gap={2} paddingTop={keysActive ? 1 : 0}>
					{actions.map((action) => (
						<text fg={theme.colors.mutedForeground} key={action.key}>
							<span fg={theme.colors.primary}>
								<b>{action.key}</b>
							</span>{" "}
							{action.label}
						</text>
					))}
					{!keysActive && showStart ? (
						<text fg={theme.colors.mutedForeground}>
							open Home to start Core
						</text>
					) : null}
				</box>
				<box flexDirection="row" gap={1}>
					<Spinner color={theme.colors.mutedForeground} />
					<text fg={theme.colors.mutedForeground}>{status}</text>
				</box>
			</Card>
		</box>
	);
}

/** ConnectionCard for the active node, fed by the shared health poller. */
export function CoreConnectionCard({ keysActive }: { keysActive: boolean }) {
	const { url } = useCore();
	const health = useCoreHealth();
	const { effectiveMode } = useCliProductMode();
	return (
		<ConnectionCard
			keysActive={keysActive}
			nextRetryAt={health?.nextRetryAt ?? null}
			progress={health?.startProgress ?? null}
			showStart={health?.canStart ?? false}
			showSwitchNode={effectiveMode !== "bot"}
			starting={health?.starting ?? false}
			url={url}
		/>
	);
}
