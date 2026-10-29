import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	SettingsGroup,
	SettingsSection,
} from "@ryu/blocks/desktop/settings-items.tsx";
import {
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { getPreference, setPreference } from "@/src/lib/api/preferences.ts";
import { PanelPageLink, PanelRow, useNodeSurface } from "./NodePanelNav.tsx";
import {
	DEFAULT_WEB_SEARCH_ACCESS_MODE,
	isWebSearchAccessMode,
	parseWebSearchAccessMode,
	WEB_SEARCH_ACCESS_MODE_OPTIONS,
	WEB_SEARCH_ACCESS_MODE_PREF_KEY,
	type WebSearchAccessMode,
} from "./web-search-access.ts";

interface WebSearchAccessMenuProps {
	enabled: boolean;
	target: ApiTarget;
}

export function WebSearchAccessMenu({
	enabled,
	target,
}: WebSearchAccessMenuProps) {
	const queryClient = useQueryClient();
	const surface = useNodeSurface();
	const queryKey = [
		"node-web-search-access-mode",
		target.url,
		target.token ?? null,
		target.userJwt ?? null,
	] as const;
	const query = useQuery({
		enabled,
		queryFn: async () =>
			parseWebSearchAccessMode(
				await getPreference(target, WEB_SEARCH_ACCESS_MODE_PREF_KEY)
			),
		queryKey,
		retry: false,
	});
	const [pendingMode, setPendingMode] = useState<WebSearchAccessMode | null>(
		null
	);
	const [saveFailed, setSaveFailed] = useState(false);
	const selectedMode = query.data ?? DEFAULT_WEB_SEARCH_ACCESS_MODE;
	const visibleMode = pendingMode ?? selectedMode;
	const currentOption = WEB_SEARCH_ACCESS_MODE_OPTIONS.find(
		(option) => option.value === visibleMode
	);
	const disabled = !enabled || query.isLoading || pendingMode !== null;
	const triggerLabel = query.isLoading
		? "Loading…"
		: query.isError
			? "Unavailable"
			: pendingMode
				? "Saving…"
				: (currentOption?.label ?? "Live");

	const selectMode = async (mode: WebSearchAccessMode) => {
		if ((!query.isError && mode === selectedMode) || disabled) {
			return;
		}

		setPendingMode(mode);
		setSaveFailed(false);
		try {
			await setPreference(target, WEB_SEARCH_ACCESS_MODE_PREF_KEY, mode);
			queryClient.setQueryData(queryKey, mode);
		} catch {
			setSaveFailed(true);
		} finally {
			setPendingMode(null);
		}
	};

	const errors = (
		<>
			{query.isError ? (
				<p
					className="type-compact px-2 py-1 text-status-destructive"
					role="status"
				>
					Couldn't load this computer's web search setting.
				</p>
			) : null}
			{saveFailed ? (
				<p
					className="type-compact px-2 py-1 text-status-destructive"
					role="status"
				>
					Couldn't save the web search setting.
				</p>
			) : null}
		</>
	);

	if (surface === "panel") {
		return (
			<PanelPageLink
				disabled={!enabled}
				label="Web search"
				trailing={triggerLabel}
			>
				{/* `SettingsGroup`, not `PanelGroup`: each choice's description is a
				    Settings caption under its own card, exactly as App Settings
				    renders a described row. */}
				<SettingsSection caption="Choose how this computer can access the web.">
					<SettingsGroup>
						{WEB_SEARCH_ACCESS_MODE_OPTIONS.map((option) => (
							<PanelRow
								current={option.value === visibleMode}
								description={option.description}
								disabled={disabled}
								key={option.value}
								onClick={() => {
									void selectMode(option.value);
								}}
								trailing={
									option.value === visibleMode ? (
										<HugeiconsIcon
											aria-label="Selected"
											className="size-4 shrink-0 text-primary"
											icon={Tick02Icon}
											strokeWidth={2.5}
										/>
									) : null
								}
							>
								{option.label}
							</PanelRow>
						))}
					</SettingsGroup>
				</SettingsSection>
				{errors}
			</PanelPageLink>
		);
	}

	return (
		<>
			<DropdownMenuSeparator />
			<DropdownMenuSub>
				<DropdownMenuSubTrigger disabled={!enabled} purpose="layer-selection">
					<span className="text-muted-foreground">Web search</span>
					<span className="ml-auto text-muted-foreground/70">
						{triggerLabel}
					</span>
				</DropdownMenuSubTrigger>
				<DropdownMenuSubContent className="w-72 min-w-72">
					<div className="px-2 pt-1.5 pb-1">
						<p className="font-medium text-xs">Web search</p>
						<p className="type-compact text-muted-foreground/60">
							Choose how this computer can access the web.
						</p>
					</div>
					<DropdownMenuRadioGroup
						onValueChange={(value) => {
							if (isWebSearchAccessMode(value)) {
								void selectMode(value);
							}
						}}
						value={visibleMode}
					>
						{WEB_SEARCH_ACCESS_MODE_OPTIONS.map((option) => (
							<DropdownMenuRadioItem
								className="items-start whitespace-normal"
								disabled={disabled}
								key={option.value}
								value={option.value}
							>
								<span className="flex min-w-0 flex-col gap-0.5">
									<span>{option.label}</span>
									<span className="type-compact font-normal text-muted-foreground leading-tight">
										{option.description}
									</span>
								</span>
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
					{errors}
				</DropdownMenuSubContent>
			</DropdownMenuSub>
		</>
	);
}
