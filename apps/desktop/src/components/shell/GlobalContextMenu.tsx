import {
	Cancel01Icon,
	Copy01Icon,
	Home01Icon,
	Refresh01Icon,
	Settings01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuPortal,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu";
import { type ReactNode, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

interface GlobalContextMenuProps {
	children: ReactNode;
}

export function GlobalContextMenu({ children }: GlobalContextMenuProps) {
	const navigate = useNavigate();
	const location = useLocation();
	const [showReload, setShowReload] = useState(false);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.ctrlKey || e.metaKey) {
				setShowReload(e.key === "r");
			}
		};
		const handleKeyUp = (e: KeyboardEvent) => {
			if (e.key === "Control" || e.key === "Meta") {
				setShowReload(false);
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		window.addEventListener("keyup", handleKeyUp);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
			window.removeEventListener("keyup", handleKeyUp);
		};
	}, []);

	const handleSettings = () => {
		window.dispatchEvent(new CustomEvent("open-settings"));
	};

	const handleCloseWindow = async () => {
		const { invoke } = await import("@tauri-apps/api/core");
		await invoke("close_main_window");
	};

	const isHomePage = location.pathname === "/";

	return (
		<ContextMenu>
			<ContextMenuTrigger className="h-full w-full">
				{children}
			</ContextMenuTrigger>
			<ContextMenuPortal>
				<ContextMenuContent className="w-48">
					<ContextMenuItem
						className="flex items-center gap-2"
						disabled={isHomePage}
						onClick={() => navigate("/")}
					>
						<HugeiconsIcon className="size-4" icon={Home01Icon} />
						Home
						{isHomePage && (
							<span className="ml-auto text-muted-foreground text-xs">
								Current
							</span>
						)}
					</ContextMenuItem>

					<ContextMenuItem
						className="flex items-center gap-2"
						onClick={handleSettings}
					>
						<HugeiconsIcon className="size-4" icon={Settings01Icon} />
						Settings
					</ContextMenuItem>

					<div className="my-1 h-px bg-border" />

					<ContextMenuItem
						className="flex items-center gap-2"
						onClick={() => navigator.clipboard.writeText(window.location.href)}
					>
						<HugeiconsIcon className="size-4" icon={Copy01Icon} />
						Copy URL
					</ContextMenuItem>

					{showReload && (
						<ContextMenuItem
							className="flex items-center gap-2"
							onClick={() => window.location.reload()}
						>
							<HugeiconsIcon className="size-4" icon={Refresh01Icon} />
							Reload Page
						</ContextMenuItem>
					)}

					<ContextMenuItem
						className="flex items-center gap-2 text-destructive focus:text-destructive"
						onClick={handleCloseWindow}
					>
						<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
						Close Window
					</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenuPortal>
		</ContextMenu>
	);
}
