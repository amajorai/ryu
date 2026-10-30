/* @jsxImportSource @opentui/react */

import { useKeyboard } from "@opentui/react";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { request } from "@ryuhq/core-client/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useCore } from "../../core/CoreContext.tsx";
import { useCliProductMode } from "../../core/ProductModeContext.tsx";
import { tf } from "../../i18n/translate.ts";
import {
	canonical,
	confirmsSection,
	LABELS,
	type PolicyValue,
	policyBooleanMapSchema,
	policyBooleanSchema,
	policyCatalogSchema,
	policyJsonSchema,
	policyPreferenceSchema,
	policyRecordSchema,
	policyRestartSchema,
	policyStringSchema,
	record,
	SECTIONS,
	type Section,
	type Snapshot,
	validate,
} from "./advanced-policy-model.ts";

export function GatewayAdvancedPolicy({
	onEditingChange,
}: {
	onEditingChange: (editing: boolean) => void;
}) {
	const { target } = useCore();
	const { checkConsoleAccess } = useCliProductMode();
	const theme = useTheme();
	const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
	const [row, setRow] = useState(0);
	const [stage, setStage] = useState<"view" | "edit" | "confirm">("view");
	const [draft, setDraft] = useState("");
	const [message, setMessage] = useState("");
	const [allowed, setAllowed] = useState(false);
	const [busy, setBusy] = useState(false);
	const controller = useRef<AbortController | null>(null);
	const working = useRef(false);
	const intent = useRef<{
		section: Section;
		before: PolicyValue;
		value: PolicyValue;
	} | null>(null);
	const section = SECTIONS[row]!;
	const read = useCallback(
		async (signal: AbortSignal): Promise<Snapshot> => {
			const config = policyRecordSchema.parse(
				await request(
					target,
					"/api/gateway/config",
					{ signal },
					appResponseValueSchema
				)
			);
			const next: Snapshot = {};
			for (const name of SECTIONS) {
				if (
					name !== "custom_evaluators" &&
					!name.endsWith("gateway-routing") &&
					record(config[name])
				) {
					next[name] = config[name];
				}
			}
			// Custom definitions are startup catalog data, absent from ConfigView.
			const catalog = await request(
				target,
				"/api/gateway/evaluators",
				{
					signal,
				},
				appResponseValueSchema
			)
				.then((raw) => policyCatalogSchema.parse(raw))
				.catch(() => ({ evaluators: undefined }));
			if (Array.isArray(catalog.evaluators)) {
				next.custom_evaluators = catalog.evaluators.filter(
					(value) => record(value) && value.builtin === false
				);
			}
			for (const name of [
				"claude-gateway-routing",
				"codex-gateway-routing",
				"agent-gateway-routing",
			] as const) {
				const wire = await request(
					target,
					`/api/preferences/${name}`,
					{
						signal,
					},
					appResponseValueSchema
				)
					.then((raw) => policyPreferenceSchema.parse(raw))
					.catch(() => policyPreferenceSchema.parse({}));
				if (!("value" in wire)) {
					continue;
				}
				if (wire.value === null) {
					next[name] = null;
					continue;
				}
				if (!policyStringSchema.safeParse(wire.value).success) {
					continue;
				}
				try {
					const value = policyJsonSchema.parse(
						JSON.parse(policyStringSchema.parse(wire.value))
					);
					if (
						name === "agent-gateway-routing"
							? policyBooleanMapSchema.safeParse(value).success
							: policyBooleanSchema.safeParse(value).success
					) {
						next[name] = value;
					}
				} catch {
					/* A malformed preference is unavailable, not a fabricated default. */
				}
			}
			return next;
		},
		[target]
	);
	const load = useCallback(async () => {
		controller.current?.abort();
		const current = new AbortController();
		controller.current = current;
		setSnapshot(null);
		setMessage("");
		setAllowed(false);
		intent.current = null;
		try {
			const [access, next] = await Promise.all([
				checkConsoleAccess(),
				read(current.signal),
			]);
			if (current.signal.aborted) {
				return;
			}
			setAllowed(access);
			setSnapshot(next);
			if (!access) {
				setMessage("Owner or admin access is required to edit policy.");
			}
		} catch (error) {
			if (!current.signal.aborted) {
				setMessage(
					tf("Could not load advanced policy: {error} · r retry", {
						error: error instanceof Error ? error.message : String(error),
					})
				);
			}
		}
	}, [checkConsoleAccess, read]);
	useEffect(() => {
		void load();
		return () => {
			controller.current?.abort();
			onEditingChange(false);
		};
	}, [load, onEditingChange]);
	const changeStage = (next: typeof stage) => {
		setStage(next);
		onEditingChange(next !== "view");
	};
	const save = async () => {
		const pending = intent.current;
		if (!pending || working.current) {
			return;
		}
		working.current = true;
		setBusy(true);
		setMessage("");
		const current = new AbortController();
		controller.current?.abort();
		controller.current = current;
		try {
			if (!(await checkConsoleAccess())) {
				throw new Error("Owner or admin access is required.");
			}
			const fresh = await read(current.signal);
			if (current.signal.aborted) {
				return;
			}
			if (!(pending.section in fresh)) {
				throw new Error(
					"This section is no longer served. Reload before editing."
				);
			}
			if (canonical(fresh[pending.section]) !== canonical(pending.before)) {
				// A response lost after a committed write is resolved without duplicating it.
				if (
					confirmsSection(
						pending.section,
						pending.value,
						fresh[pending.section]
					)
				) {
					setSnapshot(fresh);
					intent.current = null;
					changeStage("view");
					setMessage("Policy saved and confirmed by node readback.");
					return;
				}
				throw new Error(
					"Concurrent policy change detected. Cancel and reload before editing."
				);
			}
			await request(
				target,
				pending.section.endsWith("gateway-routing")
					? `/api/preferences/${pending.section}`
					: "/api/gateway/config",
				{
					method: "PUT",
					body: pending.section.endsWith("gateway-routing")
						? { value: JSON.stringify(pending.value) }
						: { [pending.section]: pending.value },
					signal: current.signal,
				},
				appResponseValueSchema
			);
			if (pending.section === "custom_evaluators") {
				const result = policyRestartSchema.parse(
					await request(
						target,
						"/api/gateway/restart",
						{
							method: "POST",
							signal: current.signal,
						},
						appResponseValueSchema
					)
				);
				if (result.success !== true) {
					throw new Error(
						"Evaluator definitions saved; Gateway restart not confirmed. Retry or ask its operator to restart."
					);
				}
			}
			const after = await read(current.signal);
			if (current.signal.aborted) {
				return;
			}
			if (
				!confirmsSection(pending.section, pending.value, after[pending.section])
			) {
				throw new Error(
					"Saved response did not match normalized readback. Reload to inspect."
				);
			}
			setSnapshot(after);
			intent.current = null;
			changeStage("view");
			setMessage("Policy saved and confirmed by node readback.");
		} catch (error) {
			if (!current.signal.aborted) {
				setMessage(
					tf("Could not save: {error} · y retry · n cancel", {
						error: error instanceof Error ? error.message : String(error),
					})
				);
			}
		} finally {
			working.current = false;
			if (!current.signal.aborted) {
				setBusy(false);
			}
		}
	};
	useKeyboard((key) => {
		if (working.current) {
			return;
		}
		if (stage === "confirm") {
			if (key.name === "y") {
				void save();
			} else if (key.name === "n") {
				intent.current = null;
				changeStage("edit");
				setMessage("");
			}
			return;
		}
		if (stage === "edit") {
			if (key.name === "tab") {
				intent.current = null;
				changeStage("view");
				setMessage("");
			} else if (key.ctrl && key.name === "u") {
				setDraft("");
			} else if (key.name === "return") {
				try {
					const value = policyJsonSchema.parse(JSON.parse(draft));
					validate(section, value, snapshot?.[section]);
					intent.current = { section, before: snapshot?.[section], value };
					changeStage("confirm");
					setMessage("");
				} catch (error) {
					setMessage(
						tf("Invalid policy JSON: {error}", {
							error: error instanceof Error ? error.message : String(error),
						})
					);
				}
			}
			return;
		}
		if (key.name === "r") {
			void load();
		} else if (key.name === "up") {
			setRow((value) => Math.max(0, value - 1));
		} else if (key.name === "down") {
			setRow((value) => Math.min(SECTIONS.length - 1, value + 1));
		} else if (key.name === "e" && allowed && snapshot && section in snapshot) {
			setDraft(JSON.stringify(snapshot[section]));
			changeStage("edit");
			setMessage("");
		}
	});
	return (
		<box flexDirection="column" gap={0}>
			<text fg={theme.colors.primary}>Advanced safety policy</text>
			{message ? (
				<text fg={theme.colors.mutedForeground}>{message}</text>
			) : null}
			<text>Node → organization → agent; locks prevent loosening.</text>
			<text>Patterns and evaluator bindings append across scopes.</text>
			{stage === "view" ? (
				<>
					{SECTIONS.map((name, index) => (
						<text
							fg={
								row === index ? theme.colors.primary : theme.colors.foreground
							}
							key={name}
						>
							{row === index ? "›" : " "} {LABELS[index]}:{" "}
							{snapshot
								? name in snapshot
									? "served"
									: "unsupported"
								: "loading"}
						</text>
					))}
					<text>↑/↓ select · e edit complete JSON · r reload</text>
					<text>j/k section · Esc close</text>
				</>
			) : stage === "edit" ? (
				<>
					<text>
						{tf("{label} · complete replacement JSON", {
							label: LABELS[row] ?? "",
						})}
					</text>
					<input
						focused
						onInput={setDraft}
						placeholder="Complete served section JSON"
						value={draft}
					/>
					<text>Ctrl+U clear · Enter review · Tab cancel</text>
				</>
			) : (
				<>
					<text>
						{tf("Replace the entire {section} section?", { section })}
					</text>
					<text>
						Omitted overlay IDs are removed. Other sections stay unchanged.
					</text>
					{section === "custom_evaluators" ? (
						<text>
							Saving also restarts the Gateway to activate this catalog.
						</text>
					) : null}
					<text>y save replacement · n return to editor</text>
				</>
			)}
			<text>Egress applies when the agent next starts.</text>
			<text>Bypass agents stay direct; Ryu follows its provider.</text>
			<text>Wrapping is node-only; overlay null means inherit.</text>
			<text>Overlay alerts: text/evaluators; node: all paths.</text>
			{busy ? <text>Saving and checking node…</text> : null}
		</box>
	);
}
