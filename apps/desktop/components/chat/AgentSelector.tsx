import {
	ArrowDown01Icon,
	Download01Icon,
	Tick01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu";
import { Spinner } from "@ryu/ui/components/spinner";
import {
	type MouseEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { AgentLogo, normalizeEngine } from "@/src/lib/agent-logos.tsx";
import { type AgentSummary, fetchAgents } from "@/src/lib/api/agents.ts";
import {
	type CatalogItem,
	fetchCatalog,
	installSidecar,
} from "@/src/lib/services-api.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

interface AgentSelectorProps {
	onChange: (agentId: string) => void;
	value: string | null;
}

export function AgentSelector({ value, onChange }: AgentSelectorProps) {
	const activeNode = useNodeStore((s) => s.getActiveNode());
	const [catalog, setCatalog] = useState<CatalogItem[]>([]);
	const [external, setExternal] = useState<AgentSummary[]>([]);
	const [installing, setInstalling] = useState<Set<string>>(new Set());
	const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const load = useCallback(async () => {
		try {
			const [items, agents] = await Promise.all([
				fetchCatalog(activeNode.url, activeNode.token),
				fetchAgents({ url: activeNode.url, token: activeNode.token }),
			]);
			setCatalog(items.filter((i) => i.category === "agent"));
			// Only show ACP agents (id starts with "acp:") in the external section
			setExternal(agents.filter((a) => a.id.startsWith("acp:")));
		} catch {
			// core not running yet
		}
	}, [activeNode.url, activeNode.token]);

	useEffect(() => {
		load();
	}, [load]);

	// Poll every 2s while any sidecar install is in progress
	useEffect(() => {
		const hasInstalling =
			catalog.some((i) => i.installState === "installing") ||
			installing.size > 0;
		if (hasInstalling) {
			pollingRef.current = setInterval(load, 2000);
		} else if (pollingRef.current) {
			clearInterval(pollingRef.current);
			pollingRef.current = null;
		}
		return () => {
			if (pollingRef.current) {
				clearInterval(pollingRef.current);
				pollingRef.current = null;
			}
		};
	}, [catalog, installing.size, load]);

	const handleInstall = async (e: MouseEvent, name: string) => {
		e.stopPropagation();
		setInstalling((prev) => new Set(prev).add(name));
		try {
			await installSidecar(activeNode.url, activeNode.token, name);
		} catch {
			// polling reflects final state
		} finally {
			setInstalling((prev) => {
				const next = new Set(prev);
				next.delete(name);
				return next;
			});
			load();
		}
	};

	const handleSelect = (id: string) => {
		localStorage.setItem("ryu_default_agent", id);
		onChange(id);
	};

	// Sidecar agents split by install state
	const installedSidecars = catalog.filter(
		(i) => i.installState === "installed"
	);
	const availableSidecars = catalog.filter(
		(i) => i.installState !== "installed"
	);

	// External ACP agents split by detection
	const detectedExternal = external.filter((a) => a.installed === true);
	const undetectedExternal = external.filter((a) => a.installed !== true);

	// Resolve display label for trigger
	const externalMatch = external.find((a) => a.id === value);
	const catalogMatch = catalog.find((i) => i.name === value);
	const triggerLabel =
		externalMatch?.name ?? catalogMatch?.displayName ?? value ?? "Select agent";

	const hasAnyInstalled =
		detectedExternal.length > 0 || installedSidecars.length > 0;

	return (
		<DropdownMenu>
			<DropdownMenuTrigger className="inline-flex h-7 select-none items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 font-medium text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50">
				<AgentLogo
					className="size-3.5 shrink-0"
					engine={normalizeEngine(
						externalMatch?.id ?? catalogMatch?.name ?? null
					)}
				/>
				{triggerLabel}
				<HugeiconsIcon
					className="size-3.5 text-muted-foreground"
					icon={ArrowDown01Icon}
				/>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-72" side="bottom">
				{/* ── Installed/detected agents ─────────────────────────────── */}
				{hasAnyInstalled && (
					<DropdownMenuGroup>
						<DropdownMenuLabel>Installed</DropdownMenuLabel>
						{detectedExternal.map((agent) => (
							<DropdownMenuItem
								key={agent.id}
								onClick={() => handleSelect(agent.id)}
							>
								<AgentLogo
									className="size-4 shrink-0"
									engine={normalizeEngine(agent.id)}
								/>
								<div className="flex min-w-0 flex-1 flex-col">
									<span className="font-medium">{agent.name}</span>
									{agent.description && (
										<span className="truncate text-muted-foreground text-xs">
											{agent.description}
										</span>
									)}
								</div>
								{value === agent.id && (
									<HugeiconsIcon
										className="ml-auto size-3.5 shrink-0 text-muted-foreground"
										icon={Tick01Icon}
									/>
								)}
							</DropdownMenuItem>
						))}
						{installedSidecars.map((agent) => (
							<DropdownMenuItem
								key={agent.name}
								onClick={() => handleSelect(agent.name)}
							>
								<AgentLogo className="size-4 shrink-0" engine={agent.name} />
								<div className="flex min-w-0 flex-1 flex-col">
									<span className="font-medium">{agent.displayName}</span>
									{agent.description && (
										<span className="truncate text-muted-foreground text-xs">
											{agent.description}
										</span>
									)}
								</div>
								{value === agent.name && (
									<HugeiconsIcon
										className="ml-auto size-3.5 shrink-0 text-muted-foreground"
										icon={Tick01Icon}
									/>
								)}
							</DropdownMenuItem>
						))}
					</DropdownMenuGroup>
				)}

				{/* ── External ACP agents not yet detected ─────────────────── */}
				{undetectedExternal.length > 0 && (
					<>
						{hasAnyInstalled && <DropdownMenuSeparator />}
						<DropdownMenuGroup>
							<DropdownMenuLabel>External agents (via npx)</DropdownMenuLabel>
							{undetectedExternal.map((agent) => (
								<DropdownMenuItem
									key={agent.id}
									onClick={() => handleSelect(agent.id)}
								>
									<AgentLogo
										className="size-4 shrink-0 opacity-50"
										engine={normalizeEngine(agent.id)}
									/>
									<div className="flex min-w-0 flex-1 flex-col">
										<span className="font-medium">{agent.name}</span>
										{agent.description && (
											<span className="truncate text-muted-foreground text-xs">
												{agent.description}
											</span>
										)}
										{agent.installHint && (
											<span className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/70">
												{agent.installHint}
											</span>
										)}
									</div>
									{value === agent.id && (
										<HugeiconsIcon
											className="ml-auto size-3.5 shrink-0 text-muted-foreground"
											icon={Tick01Icon}
										/>
									)}
								</DropdownMenuItem>
							))}
						</DropdownMenuGroup>
					</>
				)}

				{/* ── Sidecar agents available to install ──────────────────── */}
				{availableSidecars.length > 0 && (
					<>
						{(hasAnyInstalled || undetectedExternal.length > 0) && (
							<DropdownMenuSeparator />
						)}
						<DropdownMenuGroup>
							<DropdownMenuLabel>Available to install</DropdownMenuLabel>
							{availableSidecars.map((agent) => {
								const isInstalling =
									installing.has(agent.name) ||
									agent.installState === "installing";
								return (
									<DropdownMenuItem
										className="justify-between"
										closeOnClick={false}
										key={agent.name}
									>
										<AgentLogo
											className="size-4 shrink-0 opacity-50"
											engine={agent.name}
										/>
										<div className="flex min-w-0 flex-1 flex-col">
											<span className="font-medium">{agent.displayName}</span>
											{agent.description && (
												<span className="truncate text-muted-foreground text-xs">
													{agent.description}
												</span>
											)}
										</div>
										{isInstalling ? (
											<Spinner className="ml-2 size-3.5 shrink-0" />
										) : (
											<Button
												className="ml-2 shrink-0"
												onClick={(e: MouseEvent) =>
													handleInstall(e, agent.name)
												}
												size="xs"
												variant="outline"
											>
												<HugeiconsIcon icon={Download01Icon} />
												Install
											</Button>
										)}
									</DropdownMenuItem>
								);
							})}
						</DropdownMenuGroup>
					</>
				)}

				{catalog.length === 0 && external.length === 0 && (
					<div className="py-4 text-center text-muted-foreground text-sm">
						No agents found
					</div>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
