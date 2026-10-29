"""Pure tool-schema and FunctionGemma call parsing helpers."""

from __future__ import annotations

from typing import Any

ALLOWED_OPERATIONS = {"WAIT", "DONE", "BLOCKED", "CLICK", "TYPE_TEXT", "SCROLL_UP", "SCROLL_DOWN"}
MAX_CONTROL_TEXT_CHARS = 160
MAX_FIELD_VALUE_CHARS = 128

START = "<start_function_call>call:computer_use_action{"
END = "}<end_function_call>"


def _criteria(question: Any) -> dict[str, Any]:
    if not isinstance(question, dict):
        return {}
    criteria = question.get("criteria")
    return criteria if isinstance(criteria, dict) else {}


def _short_text(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(value.split())[:limit]


def build_tool(
    questions: dict[str, Any],
) -> tuple[dict[str, Any], set[str], set[str], set[str]]:
    operations = set(_criteria(questions.get("operation")))
    if not operations or not operations.issubset(ALLOWED_OPERATIONS):
        raise ValueError("operation choices are required")
    click_targets = set(_criteria(questions.get("click_target")))
    type_targets = set(_criteria(questions.get("type_text_target")))
    targets = click_targets | type_targets
    if not all(isinstance(value, str) and value.isdigit() for value in targets):
        raise ValueError("target choices must be numeric strings")
    tool = {
        "type": "function",
        "function": {
            "name": "computer_use_action",
            "description": "Choose one safe next desktop action using only the supplied operation and target ids.",
            "parameters": {
                "type": "object",
                "properties": {
                    "operation": {"type": "string", "enum": sorted(operations)},
                    "target": {"type": "string", "enum": ["none", *sorted(targets)]},
                },
                "required": ["operation", "target"],
            },
        },
    }
    return tool, operations, click_targets, type_targets


def compact_observations(state: dict[str, Any], questions: dict[str, Any]) -> dict[str, Any]:
    controls: list[dict[str, str]] = []
    for question_id, operation in (("click_target", "CLICK"), ("type_text_target", "TYPE_TEXT")):
        for target_id, metadata in _criteria(questions.get(question_id)).items():
            if not isinstance(target_id, str) or not isinstance(metadata, dict):
                raise ValueError("target metadata is invalid")
            controls.append(
                {
                    "id": target_id,
                    "operation": operation,
                    "element": _short_text(metadata.get("element"), MAX_CONTROL_TEXT_CHARS),
                    "role": _short_text(metadata.get("role"), 48),
                    "current_value": _short_text(metadata.get("current_value"), MAX_FIELD_VALUE_CHARS),
                }
            )
    page = state.get("page")
    if not isinstance(page, dict):
        page = {}
    recent_actions = state.get("recent_actions")
    if not isinstance(recent_actions, list):
        recent_actions = []
    history = [
        {
            "operation": _short_text(action.get("operation"), 32),
            "page_changed": action.get("page_changed") is True,
        }
        for action in recent_actions[-4:]
        if isinstance(action, dict)
    ]
    return {
        "goal": _short_text(state.get("task"), 4096),
        "page": {
            "app": _short_text(page.get("app"), 120),
            "title": _short_text(page.get("title"), 180),
        },
        "controls": controls,
        "recent_actions": history,
    }


def _parse_fields(body: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    remaining = body.strip()
    while remaining:
        if remaining.startswith(","):
            remaining = remaining[1:].lstrip()
        name, separator, value = remaining.partition(":")
        if not separator or name not in {"operation", "target"} or name in fields:
            raise ValueError("FunctionGemma returned malformed action fields")
        if not value.startswith("<escape>"):
            raise ValueError("FunctionGemma action fields must use its escaped-value format")
        value = value[len("<escape>") :]
        field_value, separator, remaining = value.partition("<escape>")
        if not separator:
            raise ValueError("FunctionGemma returned an unterminated action field")
        fields[name] = field_value
        if remaining and not remaining.lstrip().startswith(","):
            raise ValueError("FunctionGemma returned malformed action separators")
    if set(fields) != {"operation", "target"}:
        raise ValueError("FunctionGemma omitted an action field")
    return fields


def parse_call(
    text: str,
    operations: set[str],
    click_targets: set[str],
    type_targets: set[str],
) -> dict[str, str | None]:
    text = text.strip()
    if text.count("<start_function_call>") != 1:
        raise ValueError("FunctionGemma must return exactly one function call")
    if not text.startswith(START):
        raise ValueError("FunctionGemma selected an unexpected function")
    body_and_end = text[len(START) :]
    body, separator, trailing = body_and_end.partition(END)
    if not separator or trailing.strip():
        raise ValueError("FunctionGemma returned an incomplete function call")
    fields = _parse_fields(body)
    operation = fields["operation"]
    raw_target = fields["target"]
    if operation not in operations:
        raise ValueError("FunctionGemma selected an operation outside the current choices")
    target = None if raw_target == "none" else raw_target
    if operation in {"CLICK", "TYPE_TEXT"}:
        allowed_targets = click_targets if operation == "CLICK" else type_targets
        if target is None or target not in allowed_targets:
            raise ValueError("FunctionGemma selected a target outside the current choices")
    elif target is not None:
        raise ValueError("FunctionGemma supplied a target for an action that has none")
    return {"operation": operation, "target": target}
