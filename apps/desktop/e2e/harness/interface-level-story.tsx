import proofStyles from "./interface-level-story.module.css";
// Standalone browser story for the REAL `InterfaceLevelMenuItem` — the account
// menu's inline Interface mode switch — mounted inside a real account-shaped
// `DropdownMenu`.
//
// Two things need a browser to be true, and neither is typecheckable:
//
//   1. The Google gradient is painted and animated on the checked switch, not
//      merely present as a class name.
//   2. A switch hosted in the account menu stays open after a click, so changing
//      the mode does not dismiss the menu before the user can inspect it.
//
// The story also reads back localStorage, because moving this switch is supposed
// to WRITE the prefs it implies (Detail level, run stats) rather than shadow
// them — see `src/lib/interface-level.ts`.

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { InterfaceLevelMenuItem } from "../../src/components/layout/InterfaceLevelMenuItem.tsx";
import { SIDEBAR_MODE_KEY } from "../../src/hooks/useSidebarMode.ts";
import { responseModeForInterface } from "../../src/lib/chat-routing.ts";
import {
	getInterfaceLevelServerSnapshot,
	getInterfaceLevelSnapshot,
	INTERFACE_LEVEL_KEY,
	subscribeInterfaceLevel,
} from "../../src/lib/interface-level.ts";
import "../../src/index.css";

/** The keys the switch writes, echoed into the DOM for the spec to read. */
const WATCHED = [
	INTERFACE_LEVEL_KEY,
	SIDEBAR_MODE_KEY,
	"ryu:hide-tool-detail",
	"ryu:expand-commands",
	"ryu:inference-stats",
] as const;

function StoredPrefs() {
	// Re-read on every mode change — the same store the menu item writes through.
	const level = useSyncExternalStore(
		subscribeInterfaceLevel,
		getInterfaceLevelSnapshot,
		getInterfaceLevelServerSnapshot
	);
	return (
		<dl>
			{WATCHED.map((key) => (
				<div key={key}>
					<dt>{key}</dt>
					<dd data-testid={key}>{localStorage.getItem(key) ?? "unset"}</dd>
				</div>
			))}
			<div>
				<dt>response_mode</dt>
				<dd data-testid="ryu:response-mode">
					{responseModeForInterface(level)}
				</dd>
			</div>
		</dl>
	);
}

function Story() {
	return (
		<div className={proofStyles.fixture1}>
			<DropdownMenu>
				<DropdownMenuTrigger>Account</DropdownMenuTrigger>
				<DropdownMenuContent className="min-w-64">
					<InterfaceLevelMenuItem />
				</DropdownMenuContent>
			</DropdownMenu>
			<StoredPrefs />
		</div>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
