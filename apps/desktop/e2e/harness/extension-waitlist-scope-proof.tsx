import { ExtensionWaitlistGate } from "@extension/components/WaitlistGate.tsx";
import {
	Home01Icon,
	Message01Icon,
	Settings01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Logo } from "@ryu/ui/components/logo.tsx";
import { createRoot } from "react-dom/client";
import "../../../extension/entrypoints/popup/style.css";
import "./extension-waitlist-scope-proof.css";
import styles from "./extension-waitlist-scope-proof.module.css";

const root = document.getElementById("root");
if (!root) {
	throw new Error("Waitlist proof root element not found");
}

createRoot(root).render(
	<ExtensionWaitlistGate>
		<main className={styles.waitlistScopeProofWorkspace}>
			<aside aria-label="Workspace navigation" className={styles.proofSidebar}>
				<Logo size="34px" variant="outline" />
				<nav>
					<a aria-current="page" href="#home">
						<HugeiconsIcon aria-hidden="true" icon={Home01Icon} size={16} />
						<span>Home</span>
					</a>
					<a href="#chat">
						<HugeiconsIcon aria-hidden="true" icon={Message01Icon} size={16} />
						<span>Chat</span>
					</a>
				</nav>
				<a className={styles.proofSettings} href="#settings">
					<HugeiconsIcon aria-hidden="true" icon={Settings01Icon} size={16} />
					<span>Settings</span>
				</a>
			</aside>
			<section className={styles.proofMain}>
				<header className={styles.proofHeader}>
					<span>Workspace</span>
					<span className={styles.proofNodeStatus}>Local node · Connected</span>
				</header>
				<div className={styles.proofContent}>
					<div>
						<p className={styles.proofEyebrow}>YOUR WORKSPACE</p>
						<h1>Workspace unlocked</h1>
						<p className={styles.proofCopy}>
							The server is in managed-only mode, so this local node can bypass
							the waitlist.
						</p>
					</div>
					<section
						aria-label="Start a conversation"
						className={styles.proofChatCard}
					>
						<div className={styles.proofCardMark}>
							<HugeiconsIcon
								aria-hidden="true"
								icon={Message01Icon}
								size={16}
							/>
						</div>
						<div>
							<h2>Start with Ryu</h2>
							<p>Ask a question or start a new project.</p>
						</div>
						<button className={styles.proofNewChat} type="button">
							New chat
						</button>
					</section>
				</div>
			</section>
		</main>
	</ExtensionWaitlistGate>
);
