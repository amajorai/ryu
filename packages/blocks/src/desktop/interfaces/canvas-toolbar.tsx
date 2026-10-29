import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { Kbd, KbdGroup } from "@ryu/ui/components/kbd.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	Hand,
	Map as MapIcon,
	Maximize,
	Minus,
	MousePointer2,
	Plus,
	RotateCcw,
	StickyNote,
} from "lucide-react";
import type { ReactNode } from "react";

export type CanvasTool = "hand" | "select";

function ToolButton({
	active,
	children,
	className,
	disabled,
	keys,
	label,
	onClick,
}: {
	active?: boolean;
	children: ReactNode;
	className?: string;
	disabled?: boolean;
	keys?: string[];
	label: string;
	onClick: () => void;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						aria-label={label}
						aria-pressed={active}
						className={cn(
							"rounded-lg text-foreground/70 hover:text-foreground [&_svg]:size-4",
							active &&
								"bg-primary/12 text-foreground hover:bg-primary/15 hover:text-foreground",
							className
						)}
						disabled={disabled}
						onClick={onClick}
						size="icon-sm"
						type="button"
						variant="ghost"
					/>
				}
			>
				{children}
			</TooltipTrigger>
			<TooltipContent side="top">
				{label}
				{keys ? (
					<KbdGroup>
						{keys.map((key) => (
							<Kbd key={key}>{key}</Kbd>
						))}
					</KbdGroup>
				) : null}
			</TooltipContent>
		</Tooltip>
	);
}

/**
 * A menu row's shortcut as tldraw prints it: one run of glyphs ("⇧1"), set in
 * the row's own type at a lower strength, not a row of key caps.
 */
function MenuKeys({ keys }: { keys: string }) {
	return (
		<DropdownMenuShortcut className="font-sans text-foreground/50 text-xs tabular-nums tracking-normal">
			{keys}
		</DropdownMenuShortcut>
	);
}

/** Zoom menu rows: the chrome's 12px type, not the menu's default 14px. */
const MENU_ITEM = "h-8 text-xs";

/**
 * The zoom percentage, which opens tldraw's zoom menu: step in and out, jump
 * to 100%, fit the board, or bring the selected sticky up close.
 */
function ZoomMenu({
	canZoomToSelection,
	disabled,
	onFit,
	onResetZoom,
	onZoom,
	onZoomToSelection,
	zoom,
}: {
	canZoomToSelection: boolean;
	disabled: boolean;
	onFit: () => void;
	onResetZoom: () => void;
	onZoom: (direction: -1 | 1) => void;
	onZoomToSelection: () => void;
	zoom: number;
}) {
	const tl = useLiteralMessages();
	const percent = `${Math.round(zoom * 100)}%`;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						aria-label={tl("Zoom {percent}, zoom options", { percent })}
						className="h-8 w-14 rounded-lg px-0 font-medium text-foreground/80 text-xs tabular-nums hover:text-foreground data-[popup-open]:bg-muted data-[popup-open]:text-foreground"
						type="button"
						variant="ghost"
					/>
				}
			>
				{percent}
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="center"
				className="w-52 p-1"
				drawerLabel="Zoom"
				side="top"
				sideOffset={10}
			>
				<DropdownMenuItem
					className={MENU_ITEM}
					closeOnClick={false}
					onClick={() => onZoom(1)}
				>
					Zoom in
					<MenuKeys keys="+" />
				</DropdownMenuItem>
				<DropdownMenuItem
					className={MENU_ITEM}
					closeOnClick={false}
					onClick={() => onZoom(-1)}
				>
					Zoom out
					<MenuKeys keys="−" />
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem className={MENU_ITEM} onClick={onResetZoom}>
					Zoom to 100%
					<MenuKeys keys="⇧0" />
				</DropdownMenuItem>
				<DropdownMenuItem
					className={MENU_ITEM}
					disabled={disabled}
					onClick={onFit}
				>
					Zoom to fit
					<MenuKeys keys="⇧1" />
				</DropdownMenuItem>
				<DropdownMenuItem
					className={MENU_ITEM}
					disabled={!canZoomToSelection}
					onClick={onZoomToSelection}
				>
					Zoom to selection
					<MenuKeys keys="⇧2" />
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function Divider() {
	return <span aria-hidden="true" className="mx-0.5 h-5 w-px bg-border" />;
}

/**
 * The floating dock at the bottom centre, as in tldraw and FigJam: tools on
 * the left, then a new sticky, zoom, fit, layout reset and, last, the minimap
 * toggle (tldraw keeps it with the zoom controls, not floating on its own).
 */
export function CanvasToolbar({
	canReset,
	canZoomToSelection,
	disabled,
	minimap,
	onFit,
	onNewThread,
	onResetLayout,
	onResetZoom,
	onTool,
	onZoom,
	onZoomToSelection,
	tool,
	zoom,
}: {
	canReset: boolean;
	/** The minimap toggle, when the view is wide enough to show one. */
	minimap?: { onToggle: () => void; shown: boolean };
	canZoomToSelection: boolean;
	disabled: boolean;
	onFit: () => void;
	onNewThread: () => void;
	onResetLayout: () => void;
	onResetZoom: () => void;
	onTool: (tool: CanvasTool) => void;
	onZoom: (direction: -1 | 1) => void;
	onZoomToSelection: () => void;
	tool: CanvasTool;
	zoom: number;
}) {
	return (
		<div
			aria-label="Canvas tools"
			className="pointer-events-auto flex h-10 items-center gap-0.5 rounded-xl border border-border bg-card px-1 text-card-foreground shadow-foreground/5 shadow-sm"
			data-testid="canvas-toolbar"
			role="toolbar"
		>
			<ToolButton
				active={tool === "select"}
				keys={["V"]}
				label="Select"
				onClick={() => onTool("select")}
			>
				<MousePointer2 aria-hidden="true" />
			</ToolButton>
			<ToolButton
				active={tool === "hand"}
				keys={["H"]}
				label="Hand"
				onClick={() => onTool("hand")}
			>
				<Hand aria-hidden="true" />
			</ToolButton>
			<Divider />
			<ToolButton
				disabled={disabled}
				keys={["N"]}
				label="New thread"
				onClick={onNewThread}
			>
				<StickyNote aria-hidden="true" />
			</ToolButton>
			<Divider />
			<ToolButton keys={["−"]} label="Zoom out" onClick={() => onZoom(-1)}>
				<Minus aria-hidden="true" />
			</ToolButton>
			<ZoomMenu
				canZoomToSelection={canZoomToSelection}
				disabled={disabled}
				onFit={onFit}
				onResetZoom={onResetZoom}
				onZoom={onZoom}
				onZoomToSelection={onZoomToSelection}
				zoom={zoom}
			/>
			<ToolButton keys={["+"]} label="Zoom in" onClick={() => onZoom(1)}>
				<Plus aria-hidden="true" />
			</ToolButton>
			<Divider />
			<ToolButton
				disabled={disabled}
				keys={["⇧1"]}
				label="Zoom to fit"
				onClick={onFit}
			>
				<Maximize aria-hidden="true" />
			</ToolButton>
			<ToolButton
				className="max-[420px]:hidden"
				disabled={!canReset}
				label="Reset layout"
				onClick={onResetLayout}
			>
				<RotateCcw aria-hidden="true" />
			</ToolButton>
			{minimap ? (
				<>
					<Divider />
					<ToolButton
						active={minimap.shown}
						label="Minimap"
						onClick={minimap.onToggle}
					>
						<MapIcon aria-hidden="true" />
					</ToolButton>
				</>
			) : null}
		</div>
	);
}
