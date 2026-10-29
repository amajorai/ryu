import { DropdownMenuItem } from "@ryu/ui/components/dropdown-menu.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useInterfaceLevel } from "@/src/hooks/useInterfaceLevel.ts";
import { setInterfaceLevel } from "@/src/lib/interface-level.ts";

/**
 * Account-menu item holding the Interface mode switch — the control that
 * decides whether the app shows a chat box or a cockpit (see
 * `@/src/lib/interface-level.ts`). It is intentionally inline in the main
 * account menu: changing modes should be one glance and one click, not a
 * second menu to discover.
 *
 * It lives in the account menu rather than only in Settings because the audience
 * it exists for is exactly the audience that does not open Settings.
 *
 * The switch is deliberately binary: Ryu Work is the focused chat surface and
 * Code exposes the full model, approval, workspace, and transcript controls.
 */
export function InterfaceLevelMenuItem() {
	const level = useInterfaceLevel();
	const isCode = level === "expert";

	return (
		<DropdownMenuItem
			closeOnClick={false}
			onKeyDown={(event) => {
				if (event.key !== " " && event.key !== "Enter") {
					return;
				}
				event.preventDefault();
				event.stopPropagation();
				if (event.target === event.currentTarget) {
					setInterfaceLevel(isCode ? "simple" : "expert");
				}
			}}
			purpose="interface-level"
		>
			<span
				className={cn(
					"shrink-0 text-lg",
					isCode ? "text-muted-foreground" : "font-medium text-foreground"
				)}
			>
				Ryu Work
			</span>
			<Switch
				aria-label="Interface mode"
				checked={isCode}
				onCheckedChange={(checked) =>
					setInterfaceLevel(checked ? "expert" : "simple")
				}
				onClick={(event) => event.stopPropagation()}
				size="sm"
			/>
			<span
				className={cn(
					"shrink-0 text-lg",
					isCode ? "font-medium text-foreground" : "text-muted-foreground"
				)}
			>
				Code
			</span>
		</DropdownMenuItem>
	);
}
