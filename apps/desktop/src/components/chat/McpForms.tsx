import { useLocalizedString } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { z } from "zod";
import { type ApiTarget, request } from "@/src/lib/api/client.ts";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";
import { type McpFormOwner, ownsMcpForms } from "./mcp-form-owner.ts";
import {
	type FormField,
	type FormResponse,
	type FormValues,
	initialFormValues,
	type McpForm,
	nextFormPollDelay,
	parseMcpForms,
	validateFormValues,
} from "./mcp-form-schema.ts";

const McpFormOwnerContext = createContext<McpFormOwner | null>(null);
export function McpFormOwnerProvider({
	target,
	conversationId,
	children,
}: McpFormOwner & { children: ReactNode }) {
	const value = useMemo(
		() => ({ target, conversationId }),
		[target, conversationId]
	);
	return (
		<McpFormOwnerContext.Provider value={value}>
			{children}
		</McpFormOwnerContext.Provider>
	);
}
export function useMcpFormsOwned(
	target: ApiTarget,
	conversationId: string | null | undefined
): boolean {
	return ownsMcpForms(useContext(McpFormOwnerContext), target, conversationId);
}

function ArrayEntry({
	field,
	values,
	onChange,
	disabled,
	id,
}: {
	field: FormField;
	values: FormValues;
	onChange: (values: FormValues) => void;
	disabled: boolean;
	id: string;
}) {
	const [draft, setDraft] = useState("");
	const addText = useLocalizedString("Add");
	const currentValue = values[field.name];
	const selected = Array.isArray(currentValue) ? currentValue : [];
	const add = () => {
		if (draft.trim()) {
			onChange({
				...values,
				[field.name]: [...new Set([...selected, draft.trim()])],
			});
			setDraft("");
		}
	};
	return (
		<>
			<div className="flex gap-2">
				<Input
					disabled={disabled}
					id={`${id}-${field.name}`}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							add();
						}
					}}
					value={draft}
				/>
				<Button
					disabled={disabled || !draft.trim()}
					onClick={add}
					type="button"
					variant="outline"
				>
					{addText}
				</Button>
			</div>
			<div className="flex flex-wrap gap-2">
				{selected
					.filter(
						(value) => !field.choices.some((choice) => choice.value === value)
					)
					.map((value) => (
						<Button
							disabled={disabled}
							key={value}
							onClick={() =>
								onChange({
									...values,
									[field.name]: selected.filter((item) => item !== value),
								})
							}
							type="button"
							variant="secondary"
						>
							{value} ×
						</Button>
					))}
			</div>
		</>
	);
}

export function McpFormFields({
	fields,
	values,
	onChange,
	disabled = false,
	id = "mcp-form",
}: {
	fields: FormField[];
	values: FormValues;
	onChange: (values: FormValues) => void;
	disabled?: boolean;
	id?: string;
}) {
	const noResourcesText = useLocalizedString("No resources available");
	return (
		<>
			{fields.map((field) => (
				<div className="flex flex-col gap-2" key={field.name}>
					<Label htmlFor={`${id}-${field.name}`}>
						{field.title}
						{field.required ? " *" : ""}
					</Label>
					{field.description && (
						<p
							className="text-muted-foreground text-xs"
							id={`${id}-${field.name}-description`}
						>
							{field.description}
						</p>
					)}
					{field.choices.length > 0 && (
						<div
							aria-label={field.title}
							className="flex flex-wrap gap-2"
							role="group"
						>
							{field.choices.map((choice) => {
								const value = values[field.name];
								const selected = Array.isArray(value)
									? value.includes(choice.value)
									: value === choice.value;
								return (
									<Button
										aria-pressed={selected}
										className="h-auto min-h-9 flex-col whitespace-normal"
										disabled={disabled}
										key={choice.value}
										onClick={() =>
											onChange({
												...values,
												[field.name]:
													field.type === "array"
														? selected
															? (Array.isArray(value) ? value : []).filter(
																	(item) => item !== choice.value
																)
															: [
																	...(Array.isArray(value) ? value : []),
																	choice.value,
																]
														: choice.value,
											})
										}
										spacing="comfortable"
										type="button"
										variant={selected ? "default" : "outline"}
									>
										{choice.thumbnail ? (
											<img
												alt=""
												className="h-20 w-28 rounded-md object-cover"
												crossOrigin="anonymous"
												loading="lazy"
												referrerPolicy="no-referrer"
												src={choice.thumbnail}
											/>
										) : field.choices.some((option) => option.thumbnail) ? (
											<span
												aria-hidden="true"
												className="h-20 w-28 rounded-md bg-muted"
											/>
										) : null}
										{choice.label}
										{choice.description && (
											<span className="font-normal text-xs">
												{choice.description}
											</span>
										)}
									</Button>
								);
							})}
						</div>
					)}
					{field.resource && !field.choices.length && (
						<p className="text-muted-foreground text-sm">{noResourcesText}</p>
					)}
					{field.type === "array" ? (
						(!(field.choices.length || field.resource) ||
							field.suggestions) && (
							<ArrayEntry
								disabled={disabled}
								field={field}
								id={id}
								onChange={onChange}
								values={values}
							/>
						)
					) : field.type === "boolean" ? (
						<Checkbox
							checked={values[field.name] === true}
							disabled={disabled}
							id={`${id}-${field.name}`}
							onCheckedChange={(checked) =>
								onChange({ ...values, [field.name]: checked })
							}
						/>
					) : (
						(!(field.choices.length || field.resource) ||
							field.suggestions) && (
							<Input
								aria-describedby={
									field.description
										? `${id}-${field.name}-description`
										: undefined
								}
								disabled={disabled}
								id={`${id}-${field.name}`}
								max={field.maximum}
								maxLength={field.maxLength}
								min={field.minimum}
								minLength={field.minLength}
								onChange={(event) =>
									onChange({
										...values,
										[field.name]:
											field.type === "string" || event.target.value === ""
												? event.target.value
												: Number(event.target.value),
									})
								}
								required={field.required}
								step={field.type === "integer" ? 1 : "any"}
								type={
									field.type === "string"
										? field.format === "email"
											? "email"
											: field.format === "date"
												? "date"
												: "text"
										: "number"
								}
								value={String(values[field.name] ?? "")}
							/>
						)
					)}
				</div>
			))}
		</>
	);
}

export function RichMcpForm({
	form,
	initialValues,
	onValuesChange,
	onRespond,
}: {
	form: McpForm;
	initialValues?: FormValues;
	onValuesChange?: (values: FormValues) => void;
	onRespond: (response: FormResponse) => Promise<void>;
}) {
	const [values, setValues] = useState<FormValues>(
		() => initialValues ?? initialFormValues(form.fields)
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const submitText = useLocalizedString("Submit");
	const cancelText = useLocalizedString("Cancel");
	const declineText = useLocalizedString("Decline");
	const send = async (response: FormResponse) => {
		if (busy) {
			return;
		}
		if (response.action === "accept") {
			const invalid = validateFormValues(form.fields, values);
			if (invalid) {
				setError(invalid);
				return;
			}
		}
		setBusy(true);
		setError(undefined);
		try {
			await onRespond(response);
		} catch (failure) {
			setError(
				failure instanceof Error
					? failure.message
					: "Unable to send your response"
			);
		} finally {
			setBusy(false);
		}
	};
	return (
		<form
			className="flex flex-col gap-4"
			onSubmit={(event) => {
				event.preventDefault();
				void send({
					action: "accept",
					content: Object.fromEntries(
						Object.entries(values).filter(([, value]) => value !== "")
					),
				});
			}}
		>
			<p className="whitespace-pre-wrap text-sm">{form.message}</p>
			<McpFormFields
				disabled={busy}
				fields={form.fields}
				id={form.id}
				onChange={(next) => {
					setValues(next);
					onValuesChange?.(next);
				}}
				values={values}
			/>
			{error && (
				<p className="text-destructive text-sm" role="alert">
					{error}
				</p>
			)}
			<div className="flex flex-wrap justify-end gap-2">
				<Button
					disabled={busy}
					onClick={() => void send({ action: "cancel" })}
					type="button"
					variant="ghost"
				>
					{cancelText}
				</Button>
				<Button
					disabled={busy}
					onClick={() => void send({ action: "decline" })}
					type="button"
					variant="outline"
				>
					{declineText}
				</Button>
				<Button disabled={busy} type="submit">
					{submitText}
				</Button>
			</div>
		</form>
	);
}

export function McpForms({
	conversationId,
	target,
	enabled,
}: {
	conversationId: string | null;
	target: ApiTarget;
	enabled: boolean;
}) {
	const [forms, setForms] = useState<McpForm[]>([]);
	const [error, setError] = useState<string>();
	const drafts = useRef(new Map<string, FormValues>());
	const title = useLocalizedString("Information requested");
	const { url, token, userJwt } = target;
	useEffect(() => {
		setForms([]);
		setError(undefined);
		drafts.current.clear();
	}, [conversationId, url, token, userJwt]);
	useEffect(() => {
		if (!(conversationId && enabled)) {
			return;
		}
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout>;
		let delay = 1500;
		const poll = async () => {
			try {
				const response = await request<unknown>(
					{ url, token, userJwt },
					`/api/chat/forms?conversationId=${encodeURIComponent(conversationId)}`,
					{ signal: controller.signal },
					gatewayJsonValueSchema
				);
				if (!controller.signal.aborted) {
					const pending = parseMcpForms(response);
					setForms(pending);
					delay = nextFormPollDelay(delay, pending.length > 0);
					setError(undefined);
				}
			} catch (failure) {
				if (!controller.signal.aborted) {
					delay = nextFormPollDelay(delay, false);
					setError(
						failure instanceof Error
							? failure.message
							: "Unable to load requested information"
					);
				}
			}
			if (!controller.signal.aborted) {
				timer = setTimeout(() => void poll(), delay);
			}
		};
		void poll();
		return () => {
			controller.abort();
			clearTimeout(timer);
		};
	}, [conversationId, enabled, url, token, userJwt]);
	const form = forms.find((form) => form.conversationId === conversationId);
	if (!form) {
		return null;
	}
	const respond = async (response: FormResponse) => {
		const result = await request<{ resolved: boolean }>(
			target,
			"/api/chat/forms",
			{
				method: "POST",
				body: {
					conversationId: form.conversationId,
					id: form.id,
					...response,
				},
			},
			responseCodec1
		);
		setForms((previous) => previous.filter((item) => item.id !== form.id));
		drafts.current.delete(form.id);
		if (!result.resolved) {
			setError("This request is no longer waiting for a response");
		}
	};
	return (
		<Dialog
			onOpenChange={(open) => {
				if (enabled && !open) {
					void respond({ action: "cancel" }).catch((failure) =>
						setError(
							failure instanceof Error
								? failure.message
								: "Unable to cancel request"
						)
					);
				}
			}}
			open={enabled}
		>
			<DialogContent className="max-h-[85dvh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{form.server}</DialogDescription>
				</DialogHeader>
				<RichMcpForm
					form={form}
					initialValues={drafts.current.get(form.id)}
					key={form.id}
					onRespond={respond}
					onValuesChange={(values) => drafts.current.set(form.id, values)}
				/>
				{error && (
					<p className="text-destructive text-sm" role="alert">
						{error}
					</p>
				)}
			</DialogContent>
		</Dialog>
	);
}

// Response codecs validate the consumed native DTO fields and retain JSON extension fields.
const responseCodec1 = z
	.object({ resolved: z.boolean() })
	.catchall(gatewayJsonValueSchema);
