"use client";

import {
	SlidersHorizontalIcon,
	Tick02Icon,
	Unlink01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { BrowserRuntimeStatus } from "@ryu/browser-local-ai";
import { Button } from "@ryu/ui/components/button";
import { Checkbox } from "@ryu/ui/components/checkbox";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover";
import { Separator } from "@ryu/ui/components/separator";
import { cn } from "@ryu/ui/lib/utils";
import type { SyntheticEvent } from "react";
import { useEffect, useId, useState } from "react";
import { ASSISTANT_POPUP_LAYER } from "./skin.ts";

export type AssistantMode = "browser" | "node" | "guest";

export const DEFAULT_NODE_URL = "http://127.0.0.1:7980";

/**
 * Each runtime's description is also its privacy disclosure: where a prompt goes
 * and what is kept. It lives here, one tap from the header, instead of a footer
 * under every conversation.
 */
const MODE_OPTIONS: readonly {
	description: string;
	id: AssistantMode;
	label: string;
}[] = [
	{
		description:
			"Answers run in this tab with a small local model. No prompt is sent to Ryu servers.",
		id: "browser",
		label: "Browser",
	},
	{
		description:
			"No API key. Prompts go through Ryu's hosted gateway, which screens them for safety and enforces guest limits. Page context is not sent.",
		id: "guest",
		label: "Ryu guest",
	},
	{
		description:
			"Your Ryu Core. Questions go directly from this tab to your node and stay out of its chat history.",
		id: "node",
		label: "Local node",
	},
];

/** Origins Core allows by default (apps/core/src/server/mod.rs CORS list). */
const CORE_DEFAULT_ORIGINS = new Set([
	"http://localhost:3001",
	"http://127.0.0.1:3001",
	"http://localhost:4000",
	"http://127.0.0.1:4000",
	"https://ryuhq.com",
	"https://www.ryuhq.com",
	"https://docs.ryuhq.com",
]);

/** Only a site outside Core's default list has to be added to Core's allowlist. */
function needsCoreAllowlist(): boolean {
	if (typeof window === "undefined") {
		return false;
	}
	return !CORE_DEFAULT_ORIGINS.has(window.location.origin);
}

function statusLabel(status: BrowserRuntimeStatus | undefined): string {
	if (!status || status.status === "not-prepared") {
		return "Not downloaded";
	}
	if (status.status === "preparing") {
		return status.progress == null
			? "Preparing"
			: `Downloading ${Math.round(status.progress)}%`;
	}
	if (status.status === "ready") {
		return "Ready in this browser";
	}
	return "Could not prepare";
}
/** A checked row in the settings popover, on the menu item's geometry. */
function SettingsChoice({
	checked,
	description,
	disabled,
	label,
	onSelect,
}: {
	checked: boolean;
	description?: string;
	disabled?: boolean;
	label: string;
	onSelect: () => void;
}) {
	return (
		<button
			aria-checked={checked}
			className={cn(
				"flex min-h-8 w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-sm outline-none transition-colors duration-(--duration-fast)",
				"hover:bg-foreground/10 focus-visible:bg-foreground/10 disabled:pointer-events-none disabled:opacity-50"
			)}
			disabled={disabled}
			onClick={onSelect}
			role="radio"
			type="button"
		>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="truncate font-medium" title={label}>
					{label}
				</span>
				{description ? (
					<span className="text-detail text-muted-foreground">
						{description}
					</span>
				) : null}
			</span>
			<HugeiconsIcon
				className={cn(
					"mt-0.5 size-4 shrink-0 text-muted-foreground",
					!checked && "invisible"
				)}
				icon={Tick02Icon}
			/>
		</button>
	);
}

export interface RuntimeSettingsProps {
	busy: boolean;
	/** False when the host site has no guest chat lane configured. */
	guestAvailable: boolean;
	mode: AssistantMode;
	nodeConnected: boolean;
	/** The connected node's one-line summary, shown on the Local node choice. */
	nodeSummary?: string;
	onDisconnect: () => void;
	onModeChange: (mode: AssistantMode) => void;
}

function choiceDescription(
	option: (typeof MODE_OPTIONS)[number],
	unavailable: boolean,
	nodeSummary: string | undefined
): string {
	if (unavailable) {
		return "Not available on this site";
	}
	return option.id === "node" && nodeSummary
		? `${nodeSummary}. ${option.description}`
		: option.description;
}

/** Runtime choices, laid out like Desktop's Agent · Model menu. */
export function RuntimeSettingsMenu({
	busy,
	guestAvailable,
	mode,
	nodeConnected,
	nodeSummary,
	onDisconnect,
	onModeChange,
}: RuntimeSettingsProps) {
	return (
		<>
			<div aria-label="Assistant runtime" role="radiogroup">
				<p className="flex h-7 items-center px-2 text-detail text-muted-foreground">
					Runtime
				</p>
				{MODE_OPTIONS.map((option) => {
					const unavailable = option.id === "guest" && !guestAvailable;
					return (
						<SettingsChoice
							checked={mode === option.id}
							description={choiceDescription(option, unavailable, nodeSummary)}
							disabled={busy || (unavailable && mode !== option.id)}
							key={option.id}
							label={option.label}
							onSelect={() => onModeChange(option.id)}
						/>
					);
				})}
			</div>
			{mode === "node" && nodeConnected ? (
				<>
					<Separator className="mx-2 my-1 w-auto" />
					<button
						className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm outline-none transition-colors duration-(--duration-fast) hover:bg-foreground/10 focus-visible:bg-foreground/10 disabled:pointer-events-none disabled:opacity-50"
						disabled={busy}
						onClick={onDisconnect}
						type="button"
					>
						<HugeiconsIcon
							className="size-4 shrink-0 text-muted-foreground"
							icon={Unlink01Icon}
						/>
						Disconnect this tab
					</button>
				</>
			) : null}
		</>
	);
}

/**
 * The header's settings control, in the same slot as Desktop's floating Ask Ryu
 * (where it opens the Agent · Model menu). Here it picks the runtime and shows
 * each runtime's privacy note. A popover rather than a dropdown menu so it can
 * portal above the public launcher's layer.
 */
export function RuntimeSettings({
	onDisconnect,
	onModeChange,
	...props
}: RuntimeSettingsProps) {
	const [open, setOpen] = useState(false);
	return (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger
				render={
					<Button
						aria-label="Assistant settings"
						size="icon-sm"
						title="Assistant settings"
						variant="ghost-muted"
					>
						<HugeiconsIcon className="size-4" icon={SlidersHorizontalIcon} />
					</Button>
				}
			/>
			<PopoverContent
				align="end"
				className="w-72 p-1.5"
				data-lenis-prevent=""
				data-ryu-assistant-widget="true"
				onMouseDown={(event) => event.stopPropagation()}
				positionerClassName={ASSISTANT_POPUP_LAYER}
				spacing="dense-menu"
			>
				<RuntimeSettingsMenu
					{...props}
					onDisconnect={() => {
						onDisconnect();
						setOpen(false);
					}}
					onModeChange={(mode) => {
						onModeChange(mode);
						setOpen(false);
					}}
				/>
			</PopoverContent>
		</Popover>
	);
}

function SetupHeading({ status, title }: { status: string; title: string }) {
	return (
		<div className="flex items-center justify-between gap-3">
			<p className="font-medium text-foreground text-sm">{title}</p>
			<span className="shrink-0 text-muted-foreground text-xs">{status}</span>
		</div>
	);
}

function SetupCheckbox({
	checked,
	disabled,
	label,
	onChange,
}: {
	checked: boolean;
	disabled: boolean;
	label: string;
	onChange: (value: boolean) => void;
}) {
	const id = useId();
	return (
		<div className="flex items-center gap-2">
			<Checkbox
				checked={checked}
				disabled={disabled}
				id={id}
				onCheckedChange={(next) => onChange(next === true)}
			/>
			<Label className="font-normal text-muted-foreground text-sm" htmlFor={id}>
				{label}
			</Label>
		</div>
	);
}

export interface RuntimeSetupProps {
	allowRemote: boolean;
	browserStatus: BrowserRuntimeStatus | undefined;
	busy: boolean;
	mode: AssistantMode;
	nodeToken: string;
	nodeUrl: string;
	onAllowRemoteChange: (value: boolean) => void;
	onBrowserPrepare: () => void;
	onConnect: (event: SyntheticEvent<HTMLFormElement>) => void;
	onNodeTokenChange: (value: string) => void;
	onNodeUrlChange: (value: string) => void;
	onRememberNodeChange: (value: boolean) => void;
	rememberNode: boolean;
}

/**
 * Runtime setup, shown in the composer's own card (the slot Desktop uses for its
 * permission prompt) until the selected runtime can answer. Nothing is stacked
 * under the composer, so the surface keeps Desktop's two islands: transcript and
 * composer.
 */
export function RuntimeSetupPrompt({
	allowRemote,
	browserStatus,
	busy,
	mode,
	nodeToken,
	nodeUrl,
	onAllowRemoteChange,
	onBrowserPrepare,
	onConnect,
	onNodeTokenChange,
	onNodeUrlChange,
	onRememberNodeChange,
	rememberNode,
}: RuntimeSetupProps) {
	const addressId = useId();
	const tokenId = useId();
	// Read after mount so server and first client render agree.
	const [showAllowlistNote, setShowAllowlistNote] = useState(false);
	useEffect(() => {
		setShowAllowlistNote(needsCoreAllowlist());
	}, []);

	if (mode === "browser") {
		return (
			<div
				className="flex flex-col gap-3 p-3 text-left"
				data-testid="assistant-runtime-setup"
			>
				<div className="flex flex-col gap-1">
					<SetupHeading
						status={statusLabel(browserStatus)}
						title="Download the browser model"
					/>
					<p className="text-detail text-muted-foreground">
						A small model runs in this tab. No prompt is sent to Ryu.
					</p>
				</div>
				<div className="flex justify-end">
					<Button
						disabled={busy}
						onClick={onBrowserPrepare}
						size="sm"
						variant="mono"
					>
						{busy ? "Preparing…" : "Download local model"}
					</Button>
				</div>
			</div>
		);
	}

	return (
		<form
			className="flex flex-col gap-3 p-3 text-left"
			data-testid="assistant-runtime-setup"
			onSubmit={onConnect}
		>
			<div className="flex flex-col gap-1">
				<SetupHeading status="Not connected" title="Core address" />
				<p className="text-detail text-muted-foreground">
					Messages go straight to your Core and stay out of its history.
				</p>
			</div>
			<div className="flex flex-col gap-1">
				<Label
					className="font-normal text-muted-foreground text-sm"
					htmlFor={addressId}
				>
					Address
				</Label>
				<Input
					aria-label="Ryu Core address"
					disabled={busy}
					id={addressId}
					onChange={(event) => onNodeUrlChange(event.target.value)}
					placeholder={DEFAULT_NODE_URL}
					size="compact"
					spellCheck={false}
					type="url"
					value={nodeUrl}
				/>
			</div>
			<div className="flex flex-col gap-1">
				<Label
					className="font-normal text-muted-foreground text-sm"
					htmlFor={tokenId}
				>
					Access token
				</Label>
				<Input
					aria-label="Ryu Core access token"
					autoComplete="off"
					disabled={busy}
					id={tokenId}
					onChange={(event) => onNodeTokenChange(event.target.value)}
					placeholder="From Desktop's connection settings"
					size="compact"
					title="Ryu Desktop shows it in its connection settings. Standalone Core saves it in its data folder."
					type="password"
					value={nodeToken}
				/>
			</div>
			<SetupCheckbox
				checked={allowRemote}
				disabled={busy}
				label="This Core is on another computer I trust."
				onChange={onAllowRemoteChange}
			/>
			<SetupCheckbox
				checked={rememberNode}
				disabled={busy}
				label="Keep me connected in this tab."
				onChange={onRememberNodeChange}
			/>
			<div className="flex items-center justify-between gap-3">
				<p className="text-detail text-muted-foreground">
					{showAllowlistNote ? "Your Core needs to allow this website." : null}
				</p>
				<Button
					className="shrink-0"
					disabled={busy}
					size="sm"
					type="submit"
					variant="mono"
				>
					{busy ? "Testing…" : "Test & connect"}
				</Button>
			</div>
		</form>
	);
}
