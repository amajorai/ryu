// Standalone browser story for the REAL shared queue screen
// (packages/ui/components/waitlist-queue.tsx) — the ONE definition that both
// apps/web's waitlist-view and apps/desktop's WaitlistPage render.
//
// It exists because that screen used to be two hand-written copies that drifted:
// a story that renders the shared component in both themes is the cheapest way
// to see, before shipping, that a change lands on both apps at once.
//
// Not part of the plugin-runtime cert; served by the same harness Vite config
// via its own html entry.

import { WaitlistQueue } from "@ryu/ui/components/waitlist-queue.tsx";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

function Column({ dark, label }: { dark: boolean; label: string }) {
	const [handle, setHandle] = useState("");
	const [reserved, setReserved] = useState<string | null>(null);
	const [applied, setApplied] = useState(false);

	return (
		<div
			className={`${dark ? "dark" : ""} flex-1 bg-background text-foreground`}
		>
			<p className="p-4 font-medium text-muted-foreground text-xs uppercase tracking-widest">
				{label}
			</p>
			<WaitlistQueue
				eta="about 3 weeks"
				handle={handle}
				hasApplied={applied}
				joinedAt="2026-03-14T19:30:00.000Z"
				loaded
				metalTheme={dark ? "dark" : "light"}
				onApply={() => setApplied(true)}
				onBack={() => undefined}
				onChangeHandle={setHandle}
				onCopyReferral={() => undefined}
				onLifetimeAccess={() => undefined}
				onRefresh={() => undefined}
				onReserve={() => setReserved(handle.toLowerCase())}
				onShare={() => undefined}
				onSignOut={() => undefined}
				onUnreserve={() => setReserved(null)}
				onUpgrade={() => undefined}
				position={642}
				referralCount={7}
				referralUrl="https://ryuhq.com/r/ABCD2345"
				reserved={reserved}
				subtitle="Applying is optional, but a complete application can move you up and get you in sooner."
				totalWaiting={18_402}
				userName="Ada Lovelace"
			/>
		</div>
	);
}

createRoot(document.getElementById("root")!).render(
	<div className="flex min-h-screen">
		<Column dark={false} label="Light" />
		<Column dark label="Dark" />
	</div>
);
