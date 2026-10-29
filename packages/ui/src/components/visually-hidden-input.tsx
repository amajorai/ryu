"use client";

import { type InputHTMLAttributes, useEffect, useMemo, useRef } from "react";

import { isNativeObjectLike } from "../lib/native-primitive-observation.ts";

type InputValue = string[] | string;

interface VisuallyHiddenInputProps<T = InputValue>
	extends Omit<
		InputHTMLAttributes<HTMLInputElement>,
		"value" | "checked" | "onReset"
	> {
	bubbles?: boolean;
	checked?: boolean;
	control: HTMLElement | null;
	value?: T;
}

function VisuallyHiddenInput<T = InputValue>({
	control: _control,
	value,
	checked,
	bubbles = true,
	type = "hidden",
	style,
	className,
	...inputProps
}: VisuallyHiddenInputProps<T>) {
	const isCheckInput = useMemo(
		() => type === "checkbox" || type === "radio" || type === "switch",
		[type]
	);
	const inputRef = useRef<HTMLInputElement>(null);

	const prevValueRef = useRef<{
		value: T | boolean | undefined;
		previous: T | boolean | undefined;
	}>({
		value: isCheckInput ? checked : value,
		previous: isCheckInput ? checked : value,
	});

	const prevValue = useMemo(() => {
		const currentValue = isCheckInput ? checked : value;
		if (prevValueRef.current.value !== currentValue) {
			prevValueRef.current.previous = prevValueRef.current.value;
			prevValueRef.current.value = currentValue;
		}
		return prevValueRef.current.previous;
	}, [isCheckInput, value, checked]);

	useEffect(() => {
		const input = inputRef.current;
		if (!input) {
			return;
		}

		const inputProto = window.HTMLInputElement.prototype;
		const propertyKey = isCheckInput ? "checked" : "value";
		const eventType = isCheckInput ? "click" : "input";
		const currentValue = isCheckInput ? checked : value;

		const serializedCurrentValue = isCheckInput
			? checked
			: isNativeObjectLike(value)
				? JSON.stringify(value)
				: value;

		const descriptor = Object.getOwnPropertyDescriptor(inputProto, propertyKey);

		const setter = descriptor?.set;

		if (prevValue !== currentValue && setter) {
			const event = new Event(eventType, { bubbles });
			setter.call(input, serializedCurrentValue);
			input.dispatchEvent(event);
		}
	}, [prevValue, value, checked, bubbles, isCheckInput]);

	return (
		<input
			type={type}
			{...inputProps}
			aria-hidden={isCheckInput}
			className={`sr-only! [clip-path:inset(50%)]! ${className ?? ""}`}
			defaultChecked={isCheckInput ? checked : undefined}
			ref={inputRef}
			style={style}
			tabIndex={-1}
		/>
	);
}

export { VisuallyHiddenInput };
