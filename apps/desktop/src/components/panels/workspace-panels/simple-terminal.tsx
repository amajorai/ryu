import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import { invoke } from "@tauri-apps/api/core";
import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import type { TerminalCommandRequest } from "@/src/store/useDockPanelRequestStore.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import panelStyles from "../WorkspacePanels.module.css";

const PATH_SEPARATOR_RE = /[\\/]/;

// ── Embedded terminal ─────────────────────────────────────────────────────────

interface TerminalLine {
	text: string;
	type: "prompt" | "output" | "error";
}

export function SimpleTerminal({
	cwd,
	initialCommand,
	initialCommandNonce,
}: {
	cwd?: string | null;
	initialCommand?: TerminalCommandRequest;
	initialCommandNonce?: number;
}) {
	const tl = useLiteralMessages();
	const [lines, setLines] = useState<TerminalLine[]>([
		{
			type: "output",
			text: cwd
				? tl("Terminal — {cwd}\nType a command and press Enter.", { cwd })
				: "Terminal\nType a command and press Enter.",
		},
	]);
	const [input, setInput] = useState("");
	const [running, setRunning] = useState(false);
	const [history, setHistory] = useState<string[]>([]);
	const [histIdx, setHistIdx] = useState(-1);
	const [currentCwd, setCurrentCwd] = useState(cwd ?? "");
	const consumedInitialCommand = useRef<number | null>(null);
	const terminalShell = useWorkspaceStore((s) => s.terminalShell);
	const outputRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		setCurrentCwd(cwd ?? "");
	}, [cwd]);

	useEffect(() => {
		if (outputRef.current) {
			outputRef.current.scrollTop = outputRef.current.scrollHeight;
		}
		// `lines`/`running` are load-bearing: they are the only things that change
		// as output arrives, so without them the terminal pins to its first frame
		// and never follows new output.
	}, [lines, running]);

	const promptLabel = currentCwd
		? `${currentCwd.split(PATH_SEPARATOR_RE).at(-1) ?? currentCwd} $ `
		: "$ ";

	const runCommand = useCallback(
		async (cmd: string, request?: TerminalCommandRequest) => {
			const commandCwd = request ? (request.cwd ?? "") : currentCwd;
			const commandPrompt = commandCwd
				? `${commandCwd.split(PATH_SEPARATOR_RE).at(-1) ?? commandCwd} $ `
				: "$ ";
			if (!cmd.trim()) {
				setLines((prev) => [...prev, { type: "prompt", text: commandPrompt }]);
				return;
			}
			setLines((prev) => [
				...prev,
				{ type: "prompt", text: `${commandPrompt}${cmd}` },
			]);
			setRunning(true);
			const shellArg = request
				? request.shell
				: terminalShell === "auto"
					? null
					: terminalShell;
			try {
				const result = await invoke<{
					stdout: string;
					stderr: string;
					code: number;
				}>("shell_execute", {
					command: cmd,
					cwd: commandCwd || null,
					env: request?.env,
					shell: shellArg,
				});
				const next: TerminalLine[] = [];
				if (result.stdout?.trim()) {
					next.push({ type: "output", text: result.stdout.trimEnd() });
				}
				if (result.stderr?.trim()) {
					next.push({ type: "error", text: result.stderr.trimEnd() });
				}
				setLines((prev) => [...prev, ...next]);
			} catch (e) {
				setLines((prev) => [...prev, { type: "error", text: String(e) }]);
			}
			setRunning(false);
		},
		[currentCwd, terminalShell]
	);

	useEffect(() => {
		if (
			!(initialCommand && initialCommandNonce !== undefined) ||
			consumedInitialCommand.current === initialCommandNonce
		) {
			return;
		}
		consumedInitialCommand.current = initialCommandNonce;
		void runCommand(initialCommand.command, initialCommand);
	}, [initialCommand, initialCommandNonce, runCommand]);

	const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter") {
			const cmd = input.trim();
			if (cmd) {
				setHistory((prev) => [cmd, ...prev.slice(0, 99)]);
			}
			setHistIdx(-1);
			setInput("");
			runCommand(cmd);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			const idx = Math.min(histIdx + 1, history.length - 1);
			setHistIdx(idx);
			if (idx >= 0) {
				setInput(history[idx]);
			}
		} else if (e.key === "ArrowDown") {
			e.preventDefault();
			const idx = Math.max(histIdx - 1, -1);
			setHistIdx(idx);
			setInput(idx >= 0 ? history[idx] : "");
		} else if (e.key === "l" && e.ctrlKey) {
			e.preventDefault();
			setLines([]);
		}
	};

	return (
		// click-to-focus on a container is intentional
		<div
			className={cn(
				"flex h-full flex-col bg-sidebar text-sidebar-foreground",
				panelStyles.codeFont
			)}
			onClick={() => inputRef.current?.focus()}
		>
			<div
				className={cn(
					"min-h-0 flex-1 overflow-auto p-2 font-mono",
					panelStyles.codeMetrics
				)}
				ref={outputRef}
			>
				{lines.map((line, i) => {
					let lineClassName = "text-foreground";
					if (line.type === "prompt") {
						lineClassName = "text-primary";
					} else if (line.type === "error") {
						lineClassName = "text-status-destructive";
					}
					return (
						// stable sequential terminal lines
						<div className={lineClassName} key={i}>
							<pre className="whitespace-pre-wrap font-mono">
								{line.text || " "}
							</pre>
						</div>
					);
				})}
				{running && (
					<div
						className={cn(
							"animate-skeleton font-mono text-muted-foreground",
							panelStyles.codeSize
						)}
					>
						...
					</div>
				)}
			</div>
			<div
				className={cn(
					"flex shrink-0 items-center px-2 py-1.5 font-mono",
					panelStyles.codeSize
				)}
			>
				<span className="mr-1.5 shrink-0 select-none text-primary">
					{promptLabel}
				</span>
				<input
					aria-label="Terminal input"
					autoCapitalize="none"
					autoComplete="off"
					autoFocus
					className="min-w-0 flex-1 bg-transparent font-mono text-foreground caret-foreground outline-none"
					disabled={running}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={handleKeyDown}
					ref={inputRef}
					spellCheck={false}
					value={input}
				/>
			</div>
		</div>
	);
}
