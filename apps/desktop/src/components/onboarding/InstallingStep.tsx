// apps/desktop/src/components/onboarding/InstallingStep.tsx

import {
	AlertCircleIcon,
	CheckmarkCircle01Icon,
	Loading01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { NumberPopIn } from "@ryu/ui/components/number-pop-in";
import { useEffect, useRef, useState } from "react";
import {
	fetchCatalog,
	fetchDependencies,
	installMissingDeps,
	installSidecar,
} from "@/src/lib/services-api.ts";

type ItemStatus = "waiting" | "installing" | "done" | "failed";

interface InstallItem {
	displayName: string;
	isDep: boolean;
	name: string;
	status: ItemStatus;
}

interface InstallingStepProps {
	depNames: string[];
	nodeUrl: string;
	onComplete: () => void;
	sidecarNames: string[];
	token: string | null;
}

const DEP_DISPLAY_NAMES: Record<string, string> = {
	git: "Git",
	rust: "Rust",
	npm: "Node.js (npm)",
	python: "Python",
};

export function InstallingStep({
	sidecarNames,
	depNames,
	nodeUrl,
	token,
	onComplete,
}: InstallingStepProps) {
	const [items, setItems] = useState<InstallItem[]>([]);
	const [doneCount, setDoneCount] = useState(0);
	const started = useRef(false);

	useEffect(() => {
		if (started.current) {
			return;
		}
		started.current = true;

		const load = async () => {
			const catalog = await fetchCatalog(nodeUrl, token).catch(() => []);

			const depItems: InstallItem[] = depNames.map((name) => ({
				name,
				displayName: DEP_DISPLAY_NAMES[name] ?? name,
				status: "waiting",
				isDep: true,
			}));

			const sidecarItems: InstallItem[] = sidecarNames.map((name) => {
				const entry = catalog.find((c) => c.name === name);
				return {
					name,
					displayName: entry?.displayName ?? name,
					status: "waiting",
					isDep: false,
				};
			});

			const allItems = [...depItems, ...sidecarItems];
			setItems(allItems);

			let done = 0;

			// Install all selected deps in one batch call, deps run in parallel on the core side
			if (depItems.length > 0) {
				setItems((prev) =>
					prev.map((i) => (i.isDep ? { ...i, status: "installing" } : i))
				);
				try {
					const results = await installMissingDeps(nodeUrl, token);
					// Verify each dep actually installed by checking the results map
					setItems((prev) =>
						prev.map((i) => {
							if (!i.isDep) {
								return i;
							}
							const result = results[i.name];
							const status =
								result === "installed" || result === "already_installed"
									? "done"
									: "failed";
							return { ...i, status };
						})
					);
					// Fall back to polling fetchDependencies for any whose result is missing from response
					const depStatuses = await fetchDependencies(nodeUrl, token).catch(
						() => []
					);
					setItems((prev) =>
						prev.map((i) => {
							if (!i.isDep || i.status !== "installing") {
								return i;
							}
							const found = depStatuses.find((d) => d.name === i.name);
							return { ...i, status: found?.installed ? "done" : "failed" };
						})
					);
				} catch {
					setItems((prev) =>
						prev.map((i) => (i.isDep ? { ...i, status: "failed" } : i))
					);
				}
				done += depItems.length;
				setDoneCount(done);
			}

			// Install sidecars sequentially
			for (const item of sidecarItems) {
				setItems((prev) =>
					prev.map((i) =>
						i.name === item.name && !i.isDep
							? { ...i, status: "installing" }
							: i
					)
				);
				try {
					await installSidecar(nodeUrl, token, item.name);
					await waitForSidecarInstall(nodeUrl, token, item.name);
					setItems((prev) =>
						prev.map((i) =>
							i.name === item.name && !i.isDep ? { ...i, status: "done" } : i
						)
					);
				} catch {
					setItems((prev) =>
						prev.map((i) =>
							i.name === item.name && !i.isDep ? { ...i, status: "failed" } : i
						)
					);
				}
				done++;
				setDoneCount(done);
			}

			setTimeout(onComplete, 800);
		};

		load();
	}, [sidecarNames, depNames, nodeUrl, token, onComplete]);

	const total = items.length;

	return (
		<div className="flex flex-col gap-5">
			<div>
				<h2 className="mb-1 font-semibold text-xl">Setting up Ryu</h2>
				<p className="text-muted-foreground text-sm">
					{doneCount < total ? (
						<>
							<NumberPopIn value={doneCount} /> of {total} ready
						</>
					) : (
						"Everything is ready"
					)}
				</p>
			</div>

			<div className="space-y-1">
				{items.map((item) => (
					<div
						className="flex items-center gap-3 py-1.5"
						key={`${item.isDep ? "dep" : "sidecar"}:${item.name}`}
					>
						<div className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
							{item.status === "waiting" && (
								<div className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30" />
							)}
							{item.status === "installing" && (
								<HugeiconsIcon
									className="h-4 w-4 animate-spin text-primary"
									icon={Loading01Icon}
								/>
							)}
							{item.status === "done" && (
								<HugeiconsIcon
									className="h-4 w-4 text-success"
									icon={CheckmarkCircle01Icon}
								/>
							)}
							{item.status === "failed" && (
								<HugeiconsIcon
									className="h-4 w-4 text-warning"
									icon={AlertCircleIcon}
								/>
							)}
						</div>
						<span
							className={
								item.status === "waiting"
									? "text-muted-foreground/50 text-sm"
									: item.status === "installing"
										? "font-medium text-sm"
										: item.status === "done"
											? "text-sm"
											: "text-sm text-warning"
							}
						>
							{item.status === "installing"
								? `Getting ${item.displayName} ready…`
								: item.status === "done"
									? `${item.displayName} is ready`
									: item.status === "failed"
										? `Something went wrong with ${item.displayName} — retry from Services`
										: item.displayName}
						</span>
					</div>
				))}
			</div>
		</div>
	);
}

async function waitForSidecarInstall(
	nodeUrl: string,
	token: string | null,
	name: string,
	maxWaitMs = 300_000
): Promise<void> {
	const deadline = Date.now() + maxWaitMs;
	while (Date.now() < deadline) {
		await new Promise<void>((r) => setTimeout(r, 2000));
		try {
			const catalog = await fetchCatalog(nodeUrl, token);
			const entry = catalog.find((c) => c.name === name);
			if (!entry || entry.installState === "installed") {
				return;
			}
			if (entry.installState === "failed") {
				throw new Error(`${name} install failed`);
			}
		} catch (err) {
			if (err instanceof Error && err.message.includes("install failed")) {
				throw err;
			}
		}
	}
	throw new Error(`${name} install timed out`);
}
