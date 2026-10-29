import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { AnimatePresence, motion } from "motion/react";
import {
	type FormEvent,
	type KeyboardEvent,
	type RefObject,
	useId,
} from "react";
import type { DriverOption } from "./rides-model.ts";
import { DestinationGlyph, DriverOptionBody } from "./rides-parts.tsx";

const MAX_PROMPT_LENGTH = 8000;

/**
 * "Where to?": the prompt is the destination. Typing reveals the drivers as
 * ride options, available first, and Book sends the prompt to the chosen
 * one. Submitting is the explicit user action that lets the host send.
 */
export function RidesBooking({
	driverId,
	inputRef,
	onBook,
	onDriverChange,
	onPromptChange,
	options,
	prompt,
	reduceMotion,
}: {
	driverId: string | undefined;
	inputRef: RefObject<HTMLTextAreaElement | null>;
	onBook: () => void;
	onDriverChange: (agentId: string) => void;
	onPromptChange: (prompt: string) => void;
	options: DriverOption[];
	prompt: string;
	reduceMotion: boolean;
}) {
	const tl = useLiteralMessages();
	const fieldId = useId();
	const listId = useId();
	const booking = prompt.trim() !== "" && options.length > 0;
	const driver = options.find((option) => option.agent.id === driverId);
	const noDrivers = options.length === 0;

	const onSubmit = (event: FormEvent) => {
		event.preventDefault();
		if (booking && driver) {
			onBook();
		}
	};
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (
			event.key === "Enter" &&
			!event.shiftKey &&
			!event.nativeEvent.isComposing
		) {
			event.preventDefault();
			if (booking && driver) {
				onBook();
			}
		} else if (event.key === "Escape" && prompt !== "") {
			event.preventDefault();
			event.stopPropagation();
			onPromptChange("");
		}
	};

	return (
		<form className="flex flex-col" onSubmit={onSubmit}>
			<label className="sr-only" htmlFor={fieldId}>
				Where to? Describe the task to send
			</label>
			<div className="flex items-start gap-3 rounded-lg bg-muted px-4 py-3 focus-within:ring-2 focus-within:ring-ring/60">
				<DestinationGlyph className="mt-2 size-2.5 bg-foreground" />
				<textarea
					aria-controls={booking ? listId : undefined}
					className="field-sizing-content max-h-28 min-h-6 flex-1 resize-none bg-transparent font-medium text-base text-foreground leading-6 outline-none placeholder:text-foreground/55 disabled:cursor-not-allowed"
					disabled={noDrivers}
					id={fieldId}
					maxLength={MAX_PROMPT_LENGTH}
					onChange={(event) => onPromptChange(event.target.value)}
					onKeyDown={onKeyDown}
					placeholder="Where to?"
					ref={inputRef}
					rows={1}
					value={prompt}
				/>
			</div>
			{noDrivers ? (
				<p className="px-1 pt-3 text-muted-foreground text-sm">
					No drivers yet. Add an agent to start booking trips.
				</p>
			) : null}
			<AnimatePresence initial={false}>
				{booking ? (
					<motion.div
						animate={{ height: "auto", opacity: 1 }}
						className="overflow-hidden"
						exit={{ height: 0, opacity: 0 }}
						initial={{ height: 0, opacity: 0 }}
						transition={{ duration: reduceMotion ? 0 : 0.2, ease: "easeOut" }}
					>
						<div className="flex flex-col pt-4" id={listId}>
							<p
								className="pb-2 font-medium text-[13px] text-muted-foreground"
								id={`${listId}-label`}
							>
								Choose a driver
							</p>
							<div
								aria-labelledby={`${listId}-label`}
								className="flex flex-col gap-1"
								role="radiogroup"
							>
								{options.map((option) => (
									<DriverRow
										checked={option.agent.id === driverId}
										key={option.agent.id}
										name={`${fieldId}-driver`}
										onChange={onDriverChange}
										option={option}
									/>
								))}
							</div>
							<Button
								className="mt-3 h-11 w-full rounded-lg text-base"
								disabled={!driver}
								type="submit"
							>
								{driver
									? tl("Book {driverName}", { driverName: driver.agent.name })
									: "Choose a driver"}
							</Button>
						</div>
					</motion.div>
				) : null}
			</AnimatePresence>
		</form>
	);
}

function DriverRow({
	checked,
	name,
	onChange,
	option,
}: {
	checked: boolean;
	name: string;
	onChange: (agentId: string) => void;
	option: DriverOption;
}) {
	return (
		<label
			className={cn(
				// The selection box shares the field's and the Book button's
				// edges, on the sheet's 16px gutter.
				"flex cursor-pointer items-center gap-3 rounded-lg px-4 py-3 ring-inset transition-colors hover:bg-muted/60 has-focus-visible:ring-2 has-focus-visible:ring-ring/60",
				checked &&
					"bg-muted ring-2 ring-foreground hover:bg-muted has-focus-visible:ring-ring"
			)}
		>
			<input
				checked={checked}
				className="sr-only"
				name={name}
				onChange={() => onChange(option.agent.id)}
				type="radio"
				value={option.agent.id}
			/>
			<DriverOptionBody option={option} />
		</label>
	);
}
