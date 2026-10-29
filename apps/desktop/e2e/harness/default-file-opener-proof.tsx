import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
	DEFAULT_FILE_OPENER_VALUES,
	type DefaultFileOpener,
	normalizeDefaultFileOpener,
} from "../../src/lib/default-file-opener.ts";
import proofStyles from "./default-file-opener-proof.module.css";

const SHELL_STORAGE_KEY = "ryu_workspace_terminal_shell";
const OPENER_STORAGE_KEY = "ryu_workspace_default_file_opener";
const FILE_MANAGER_NAME = navigator.userAgent.includes("Mac")
	? "Finder"
	: navigator.userAgent.includes("Windows")
		? "Explorer"
		: "Files";

const FILE_OPENER_LABELS = {
	system: `OS default (${FILE_MANAGER_NAME})`,
	vscode: "VS Code",
	cursor: "Cursor",
	zed: "Zed",
} satisfies Record<DefaultFileOpener, string>;

function readShell(): string {
	return localStorage.getItem(SHELL_STORAGE_KEY) ?? "auto";
}

function Proof() {
	const [shell, setShell] = useState(readShell);
	const [fileOpener, setFileOpener] = useState<DefaultFileOpener>(() =>
		normalizeDefaultFileOpener(localStorage.getItem(OPENER_STORAGE_KEY))
	);
	const [status, setStatus] = useState(
		"Defaults loaded: OS shell and OS file opener"
	);

	const updateShell = (value: string) => {
		localStorage.setItem(SHELL_STORAGE_KEY, value);
		setShell(value);
		setStatus(`Saved shell: ${value === "auto" ? "OS default" : value}`);
	};

	const updateFileOpener = (value: DefaultFileOpener) => {
		localStorage.setItem(OPENER_STORAGE_KEY, value);
		setFileOpener(value);
		setStatus(`Saved file opener: ${FILE_OPENER_LABELS[value]}`);
	};

	const reset = () => {
		localStorage.removeItem(SHELL_STORAGE_KEY);
		localStorage.removeItem(OPENER_STORAGE_KEY);
		setShell("auto");
		setFileOpener("system");
		setStatus("Defaults restored: OS shell and OS file opener");
	};

	return (
		<main className={proofStyles.fixture1}>
			<section className={proofStyles.fixture2}>
				<p className={proofStyles.fixture3}>Desktop settings · React proof</p>
				<h1 className={proofStyles.fixture4}>General settings</h1>
				<p className={proofStyles.fixture5}>
					The defaults used by terminal commands and the workspace file tree.
				</p>

				<div className={proofStyles.fixture6}>
					<label className={proofStyles.fixture7}>
						<span className={proofStyles.fixture8}>Default shell</span>
						<span className={proofStyles.fixture9}>
							OS default follows the platform shell.
						</span>
						<select
							aria-label="Default shell"
							onChange={(event) => updateShell(event.target.value)}
							value={shell}
						>
							<option value="auto">OS default</option>
							<option value="bash">Bash</option>
							<option value="zsh">Zsh</option>
							<option value="fish">Fish</option>
						</select>
					</label>

					<label className={proofStyles.fixture10}>
						<span className={proofStyles.fixture11}>Default file opener</span>
						<span className={proofStyles.fixture12}>
							The file tree Open action uses the OS default or an installed
							editor.
						</span>
						<select
							aria-label="Default file opener"
							onChange={(event) =>
								updateFileOpener(normalizeDefaultFileOpener(event.target.value))
							}
							value={fileOpener}
						>
							{DEFAULT_FILE_OPENER_VALUES.map((value) => (
								<option key={value} value={value}>
									{FILE_OPENER_LABELS[value]}
								</option>
							))}
						</select>
					</label>
				</div>

				<div className={proofStyles.fixture13}>
					<button onClick={reset} type="button">
						Reset to OS defaults
					</button>
					<output aria-live="polite" data-testid="proof-status">
						{status}
					</output>
				</div>
			</section>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Proof />);
}
