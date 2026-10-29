import {
	RyuAppMain,
	RyuAppShell,
	RyuAppToolbar,
} from "@ryu/blocks/companion/app-ui.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { type ComponentType, useState } from "react";
import { createRoot } from "react-dom/client";
import "./app-reuse-proof.css";

const mode = new URLSearchParams(location.search).get("app") ?? "slides";
const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
async function mountProof() {
	let Surface: ComponentType<{
		close(): void;
		submit<Submission>(value: Submission): Promise<void>;
	}>;
	if (mode === "slides") {
		const { ExportDialog } = await import(
			"../../../../apps-store/slides/ui/src/components/ExportDialog.tsx"
		);
		Surface = ({ close, submit }) => (
			<ExportDialog onClose={close} onExport={submit} />
		);
	} else if (mode === "pull-requests") {
		const { StackDialog } = await import(
			"../../../../apps-store/pull-requests/ui/src/App.tsx"
		);
		Surface = ({ close, submit }) => (
			<StackDialog
				currentNumber={101}
				mode="create"
				onClose={close}
				onSubmit={async (value) => {
					await submit(value);
					return true;
				}}
			/>
		);
	} else if (mode === "feedback-board") {
		const { SubmitDialog } = await import(
			"../../../../apps-store/feedback-board/ui/src/public/PublicBoard.tsx"
		);
		Surface = ({ close, submit }) => (
			<SubmitDialog
				busy={false}
				onClose={close}
				onSubmit={async (value) => {
					await submit(value);
					close();
				}}
			/>
		);
	} else if (mode === "teams") {
		const { DeleteDialog } = await import(
			"../../../../apps-store/teams/ui/src/App.tsx"
		);
		Surface = ({ close, submit }) => (
			<DeleteDialog
				busy={false}
				onCancel={close}
				onConfirm={() => {
					void submit("confirmed");
					close();
				}}
				team={{
					id: "test-team",
					name: "Test group",
					coordination: "broadcast",
					members: [],
				}}
			/>
		);
	} else if (mode === "rooms") {
		const { RoomWorkbench } = await import(
			"../../../../apps-store/rooms/ui/src/RoomWorkbench.tsx"
		);
		Surface = ({ close }) => (
			<RoomWorkbench
				activeOrigin={null}
				initialJoinUrl="https://example.invalid/#test"
				onRoomChanged={() => {}}
				onRoomClosed={close}
				room={{
					contract: "rooms/1",
					currentRun: null,
					engine: "mesh-llm",
					id: "fixture",
					messages: [],
					modelId: "fixture-model",
					participants: [],
					schemaVersion: 1,
					status: "idle",
					updatedAt: "2026-09-06T00:00:00Z",
				}}
			/>
		);
	} else {
		const { AssetPicker } = await import(
			"../../../../apps-store/canvas/ui/src/AssetPicker.tsx"
		);
		Surface = ({ close, submit }) => (
			<AssetPicker
				onClose={close}
				onSelect={(value) => {
					void submit(value);
				}}
				open
			/>
		);
	}
	function Proof() {
		const [open, setOpen] = useState(false);
		const [result, setResult] = useState("No mutation");
		const [fail, setFail] = useState(false);
		return (
			<RyuAppShell>
				<RyuAppToolbar title={`App interaction fixture: ${mode}`} />
				<RyuAppMain>
					<p>
						This harness renders the actual app component with isolated
						callbacks.
					</p>
					<Button onClick={() => setOpen(true)}>Open dialog</Button>
					<label>
						<input
							checked={fail}
							onChange={(event) => setFail(event.target.checked)}
							type="checkbox"
						/>{" "}
						Simulate failure
					</label>
					<output aria-label="Mutation result">{result}</output>
					{open ? (
						<Surface
							close={() => setOpen(false)}
							submit={async (value) => {
								if (fail) {
									throw new Error("Fixture request failed. Try again.");
								}
								setResult(JSON.stringify(value));
							}}
						/>
					) : null}
				</RyuAppMain>
			</RyuAppShell>
		);
	}
	createRoot(document.getElementById("root")!).render(<Proof />);
}

void mountProof();
