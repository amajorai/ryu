//! Formula columns for Space database SQL queries.
//!
//! A database column whose `cell.variant` is `"formula"` stores only its
//! expression (for example `{Price} * {Qty}`); the desktop grid computes the
//! values for display and never persists them. To let read-only SQL see the
//! same results, this module evaluates those expressions into the in-memory
//! query projection. It mirrors `packages/ui/src/lib/data-grid-formula.ts`
//! exactly — including JavaScript number formatting and rounding — so a
//! formula yields the same value in the table and in SQL. Nothing is evaluated
//! as code: input is tokenized, parsed into an AST, and interpreted.

use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::time::Instant;

use chrono::{Datelike, Duration as ChronoDuration, NaiveDate, Utc};
use serde_json::{Map, Number, Value};

const ERROR_CYCLE: &str = "#CYCLE!";
const ERROR_DIV_ZERO: &str = "#DIV/0!";
const ERROR_NAME: &str = "#NAME?";
const ERROR_REF: &str = "#REF!";
const ERROR_SYNTAX: &str = "#ERROR!";
const ERROR_VALUE: &str = "#VALUE!";

/// Longest formula, in tokens; longer input is a syntax error.
const MAX_TOKENS: usize = 1024;
/// Deepest nesting of parentheses, signs, and calls a formula may use. Keeps the
/// recursive-descent parser and evaluator far from the stack limit.
const MAX_DEPTH: usize = 64;
/// Longest text a formula may produce, in UTF-16 code units (Excel's cell
/// limit), so chained concatenation cannot grow without bound.
const MAX_TEXT_LENGTH: usize = 32_767;

const FUNCTIONS: [&str; 19] = [
    "IF", "AND", "OR", "NOT", "SUM", "AVERAGE", "MIN", "MAX", "ROUND", "ABS", "CONCAT", "LEN",
    "UPPER", "LOWER", "TRIM", "CONTAINS", "ISBLANK", "TODAY", "DAYS",
];

const OPERATORS: [&str; 13] = [
    "<=", ">=", "<>", "!=", "+", "-", "*", "/", "^", "&", "=", "<", ">",
];

/// A formula value; errors travel as `Err(code)` and surface as their code text.
#[derive(Debug, Clone, PartialEq)]
enum FormulaValue {
    Null,
    Number(f64),
    Text(String),
    Bool(bool),
}

type Evaluated = Result<FormulaValue, &'static str>;

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Number(f64),
    Text(String),
    Ref(String),
    Ident(String),
    Op(&'static str),
    Paren(bool),
    Comma,
}

#[derive(Debug, Clone)]
enum Node {
    Literal(FormulaValue),
    Ref(String),
    Unary(&'static str, Box<Node>),
    Binary(&'static str, Box<Node>, Box<Node>),
    Call(String, Vec<Node>),
}

fn is_ident_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_'
}

fn is_ident_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Match JavaScript's `^\d+(\.\d+)?([eE][+-]?\d+)?` at the start of `chars`.
fn scan_number(chars: &[char]) -> usize {
    let digits = |from: usize| {
        chars[from..]
            .iter()
            .take_while(|c| c.is_ascii_digit())
            .count()
    };
    let mut end = digits(0);
    if end == 0 {
        return 0;
    }
    if chars.get(end) == Some(&'.') {
        let fraction = digits(end + 1);
        if fraction > 0 {
            end += 1 + fraction;
        }
    }
    if matches!(chars.get(end), Some('e' | 'E')) {
        let mut exponent_start = end + 1;
        if matches!(chars.get(exponent_start), Some('+' | '-')) {
            exponent_start += 1;
        }
        let exponent = digits(exponent_start);
        if exponent > 0 {
            end = exponent_start + exponent;
        }
    }
    end
}

fn tokenize(
    source: &str,
    budget: Option<&FormulaProjectionBudget>,
) -> Result<Vec<Token>, &'static str> {
    if let Some(budget) = budget {
        budget.check()?;
    }
    let chars: Vec<char> = source.chars().collect();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if let Some(budget) = budget {
            budget.check()?;
        }
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c == '{' {
            let close = chars[i + 1..].iter().position(|&ch| ch == '}');
            let Some(offset) = close else {
                return Err(ERROR_SYNTAX);
            };
            let name: String = chars[i + 1..i + 1 + offset].iter().collect();
            tokens.push(Token::Ref(name.trim().to_owned()));
            i += offset + 2;
            continue;
        }
        if c == '"' {
            let mut value = String::new();
            let mut j = i + 1;
            let mut closed = false;
            while j < chars.len() {
                if let Some(budget) = budget {
                    budget.check()?;
                }
                if chars[j] == '"' && chars.get(j + 1) == Some(&'"') {
                    value.push('"');
                    j += 2;
                } else if chars[j] == '"' {
                    closed = true;
                    break;
                } else {
                    value.push(chars[j]);
                    j += 1;
                }
            }
            if !closed {
                return Err(ERROR_SYNTAX);
            }
            tokens.push(Token::Text(value));
            i = j + 1;
            continue;
        }
        let number_len = scan_number(&chars[i..]);
        if number_len > 0 {
            let text: String = chars[i..i + number_len].iter().collect();
            tokens.push(Token::Number(text.parse().map_err(|_| ERROR_SYNTAX)?));
            i += number_len;
            continue;
        }
        if is_ident_start(c) {
            let len = chars[i..]
                .iter()
                .take_while(|&&ch| is_ident_char(ch))
                .count();
            tokens.push(Token::Ident(chars[i..i + len].iter().collect()));
            i += len;
            continue;
        }
        if c == '(' || c == ')' {
            tokens.push(Token::Paren(c == '('));
            i += 1;
            continue;
        }
        if c == ',' {
            tokens.push(Token::Comma);
            i += 1;
            continue;
        }
        let rest: String = chars[i..chars.len().min(i + 2)].iter().collect();
        if let Some(op) = OPERATORS.iter().find(|op| rest.starts_with(**op)) {
            tokens.push(Token::Op(if *op == "!=" { "<>" } else { op }));
            i += op.chars().count();
            continue;
        }
        return Err(ERROR_SYNTAX);
    }
    if tokens.len() > MAX_TOKENS {
        return Err(ERROR_SYNTAX);
    }
    Ok(tokens)
}

fn binary_precedence(op: &str) -> Option<u8> {
    match op {
        "=" | "<>" | "<" | ">" | "<=" | ">=" => Some(1),
        "&" => Some(2),
        "+" | "-" => Some(3),
        "*" | "/" => Some(4),
        "^" => Some(5),
        _ => None,
    }
}

struct Parser {
    tokens: Vec<Token>,
    position: usize,
    depth: usize,
}

impl Parser {
    fn next(&mut self) -> Option<Token> {
        let token = self.tokens.get(self.position).cloned();
        self.position += 1;
        token
    }

    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.position)
    }

    fn primary(&mut self) -> Result<Node, &'static str> {
        match self.next().ok_or(ERROR_SYNTAX)? {
            Token::Number(value) => Ok(Node::Literal(FormulaValue::Number(value))),
            Token::Text(value) => Ok(Node::Literal(FormulaValue::Text(value))),
            Token::Ref(name) => Ok(Node::Ref(name)),
            // Like Excel, a sign binds tighter than ^: -2^2 is 4.
            Token::Op(op @ ("-" | "+")) => Ok(Node::Unary(op, Box::new(self.expression(6)?))),
            Token::Op(_) | Token::Comma | Token::Paren(false) => Err(ERROR_SYNTAX),
            Token::Paren(true) => {
                let inner = self.expression(0)?;
                match self.next() {
                    Some(Token::Paren(false)) => Ok(inner),
                    _ => Err(ERROR_SYNTAX),
                }
            }
            Token::Ident(name) => {
                let upper = name.to_uppercase();
                if self.peek() == Some(&Token::Paren(true)) {
                    self.position += 1;
                    let mut args = Vec::new();
                    if self.peek() == Some(&Token::Paren(false)) {
                        self.position += 1;
                        return Ok(Node::Call(upper, args));
                    }
                    loop {
                        args.push(self.expression(0)?);
                        match self.next() {
                            Some(Token::Comma) => continue,
                            Some(Token::Paren(false)) => break,
                            _ => return Err(ERROR_SYNTAX),
                        }
                    }
                    return Ok(Node::Call(upper, args));
                }
                match upper.as_str() {
                    "TRUE" => Ok(Node::Literal(FormulaValue::Bool(true))),
                    "FALSE" => Ok(Node::Literal(FormulaValue::Bool(false))),
                    _ => Err(ERROR_NAME),
                }
            }
        }
    }

    fn expression(&mut self, min_precedence: u8) -> Result<Node, &'static str> {
        if self.depth >= MAX_DEPTH {
            return Err(ERROR_SYNTAX);
        }
        self.depth += 1;
        let result = self.expression_inner(min_precedence);
        self.depth -= 1;
        result
    }

    fn expression_inner(&mut self, min_precedence: u8) -> Result<Node, &'static str> {
        let mut left = self.primary()?;
        loop {
            let Some(Token::Op(op)) = self.peek().cloned() else {
                return Ok(left);
            };
            let Some(precedence) = binary_precedence(op) else {
                return Ok(left);
            };
            if precedence < min_precedence {
                return Ok(left);
            }
            self.position += 1;
            // `^` is right-associative; everything else is left-associative.
            let next_min = if op == "^" {
                precedence
            } else {
                precedence + 1
            };
            let right = self.expression(next_min)?;
            left = Node::Binary(op, Box::new(left), Box::new(right));
        }
    }
}

fn validate_calls(node: &Node) -> Result<(), &'static str> {
    match node {
        Node::Call(name, args) => {
            if !FUNCTIONS.contains(&name.as_str()) {
                return Err(ERROR_NAME);
            }
            args.iter().try_for_each(validate_calls)
        }
        Node::Unary(_, operand) => validate_calls(operand),
        Node::Binary(_, left, right) => {
            validate_calls(left)?;
            validate_calls(right)
        }
        Node::Literal(_) | Node::Ref(_) => Ok(()),
    }
}

/// Parse an expression (a leading `=` is allowed), or return its error code.
#[cfg(test)]
fn compile(expression: &str) -> Result<Node, &'static str> {
    compile_bounded(expression, None)
}

fn compile_bounded(
    expression: &str,
    budget: Option<&FormulaProjectionBudget>,
) -> Result<Node, &'static str> {
    if let Some(budget) = budget {
        budget.check()?;
    }
    let trimmed = expression.trim();
    let source = trimmed.strip_prefix('=').unwrap_or(trimmed);
    if source.is_empty() {
        return Err(ERROR_SYNTAX);
    }
    let mut parser = Parser {
        tokens: tokenize(source, budget)?,
        position: 0,
        depth: 0,
    };
    let tree = parser.expression(0)?;
    if parser.position < parser.tokens.len() {
        return Err(ERROR_SYNTAX);
    }
    validate_calls(&tree)?;
    if let Some(budget) = budget {
        budget.check()?;
    }
    Ok(tree)
}

/// JavaScript `Math.round`: halves round toward +∞.
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

fn round_result(value: f64) -> f64 {
    js_round(value * 1e10) / 1e10
}

/// JavaScript `String(number)` for the values formulas produce.
fn js_number_to_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_owned();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    if value == 0.0 {
        return "0".to_owned();
    }
    let magnitude = value.abs();
    if !(1e-6..1e21).contains(&magnitude) {
        let text = format!("{value:e}");
        return match text.split_once('e') {
            Some((mantissa, exponent)) if !exponent.starts_with('-') => {
                format!("{mantissa}e+{exponent}")
            }
            _ => text,
        };
    }
    format!("{value}")
}

/// Whether `text` is plain decimal: `[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?`.
/// Hex/binary/octal prefixes are deliberately not numbers, matching the
/// desktop evaluator's `DECIMAL_TEXT_REGEX`.
fn is_decimal_text(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut i = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
    let digits = |from: usize| {
        bytes[from..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count()
    };
    let whole = digits(i);
    i += whole;
    let mut fraction = 0;
    if bytes.get(i) == Some(&b'.') {
        fraction = digits(i + 1);
        i += 1 + fraction;
    }
    if whole == 0 && fraction == 0 {
        return false;
    }
    if matches!(bytes.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(bytes.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        let exponent = digits(i);
        if exponent == 0 {
            return false;
        }
        i += exponent;
    }
    i == bytes.len()
}

/// JavaScript `Number(text)` restricted to plain decimal text (blank is 0).
fn js_parse_number(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    match trimmed {
        "Infinity" | "+Infinity" => return Some(f64::INFINITY),
        "-Infinity" => return Some(f64::NEG_INFINITY),
        _ => {}
    }
    if !is_decimal_text(trimmed) {
        return None;
    }
    trimmed.parse().ok()
}

/// Refuse text over the formula text limit.
fn bounded_text(text: String) -> Evaluated {
    if text.encode_utf16().count() > MAX_TEXT_LENGTH {
        Err(ERROR_VALUE)
    } else {
        Ok(FormulaValue::Text(text))
    }
}

/// Concatenate, refusing before allocating a result over the text limit.
fn concat_text(parts: &[String]) -> Evaluated {
    let mut length = 0;
    for part in parts {
        length += part.encode_utf16().count();
        if length > MAX_TEXT_LENGTH {
            return Err(ERROR_VALUE);
        }
    }
    Ok(FormulaValue::Text(parts.concat()))
}

fn to_number(value: &FormulaValue) -> Result<f64, &'static str> {
    match value {
        FormulaValue::Null => Ok(0.0),
        FormulaValue::Bool(value) => Ok(if *value { 1.0 } else { 0.0 }),
        FormulaValue::Number(value) => Ok(*value),
        FormulaValue::Text(text) if text.is_empty() => Ok(0.0),
        FormulaValue::Text(text) => js_parse_number(text).ok_or(ERROR_VALUE),
    }
}

fn to_text(value: &FormulaValue) -> String {
    match value {
        FormulaValue::Null => String::new(),
        FormulaValue::Bool(value) => if *value { "TRUE" } else { "FALSE" }.to_owned(),
        FormulaValue::Number(value) => js_number_to_string(*value),
        FormulaValue::Text(text) => text.clone(),
    }
}

fn to_boolean(value: &FormulaValue) -> Result<bool, &'static str> {
    match value {
        FormulaValue::Bool(value) => Ok(*value),
        FormulaValue::Number(value) => Ok(*value != 0.0),
        FormulaValue::Null => Ok(false),
        FormulaValue::Text(text) if text.is_empty() => Ok(false),
        FormulaValue::Text(text) => match text.to_uppercase().as_str() {
            "TRUE" => Ok(true),
            "FALSE" => Ok(false),
            _ => Err(ERROR_VALUE),
        },
    }
}

/// Days since 1970-01-01 for `YYYY-MM-DD…` text, overflowing like `Date.UTC`.
fn to_day_number(value: &FormulaValue) -> Result<f64, &'static str> {
    if let FormulaValue::Number(value) = value {
        return Ok(*value);
    }
    let FormulaValue::Text(text) = value else {
        return Err(ERROR_VALUE);
    };
    let bytes = text.as_bytes();
    let digits = |range: std::ops::Range<usize>| -> Option<i64> {
        let slice = text.get(range)?;
        slice
            .bytes()
            .all(|b| b.is_ascii_digit())
            .then(|| slice.parse().ok())?
    };
    if bytes.len() < 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return Err(ERROR_VALUE);
    }
    let (Some(year), Some(month), Some(day)) = (digits(0..4), digits(5..7), digits(8..10)) else {
        return Err(ERROR_VALUE);
    };
    let month_index = month - 1;
    let first = NaiveDate::from_ymd_opt(
        i32::try_from(year + month_index.div_euclid(12)).map_err(|_| ERROR_VALUE)?,
        u32::try_from(month_index.rem_euclid(12) + 1).map_err(|_| ERROR_VALUE)?,
        1,
    )
    .ok_or(ERROR_VALUE)?;
    let date = first + ChronoDuration::days(day - 1);
    let epoch = NaiveDate::from_ymd_opt(1970, 1, 1).ok_or(ERROR_VALUE)?;
    Ok((date - epoch).num_days() as f64)
}

fn compare(left: &FormulaValue, right: &FormulaValue) -> Result<f64, &'static str> {
    let numeric =
        |value: &FormulaValue| matches!(value, FormulaValue::Number(_) | FormulaValue::Bool(_));
    if numeric(left) && numeric(right) {
        return Ok(to_number(left)? - to_number(right)?);
    }
    let a = to_text(left).to_lowercase();
    let b = to_text(right).to_lowercase();
    // JavaScript compares strings by UTF-16 code units.
    Ok(match a.encode_utf16().cmp(b.encode_utf16()) {
        std::cmp::Ordering::Less => -1.0,
        std::cmp::Ordering::Equal => 0.0,
        std::cmp::Ordering::Greater => 1.0,
    })
}

/// Turn a stored cell into a formula value (lists join, objects use `name`).
fn to_formula_value(value: Option<&Value>) -> FormulaValue {
    match value {
        None | Some(Value::Null) => FormulaValue::Null,
        Some(Value::Bool(value)) => FormulaValue::Bool(*value),
        Some(Value::Number(value)) => value
            .as_f64()
            .map_or(FormulaValue::Null, FormulaValue::Number),
        Some(Value::String(text)) => FormulaValue::Text(text.clone()),
        Some(Value::Array(items)) => FormulaValue::Text(
            items
                .iter()
                .map(|item| match item {
                    Value::Object(object) => object
                        .get("name")
                        .map_or_else(|| "[object Object]".to_owned(), js_string),
                    other => js_string(other),
                })
                .collect::<Vec<_>>()
                .join(", "),
        ),
        Some(Value::Object(_)) => FormulaValue::Text("[object Object]".to_owned()),
    }
}

/// JavaScript `String(value)` for a JSON value.
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.as_f64().map_or_else(String::new, js_number_to_string),
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

fn expect_args(args: &[Node], min: usize, max: usize) -> Result<(), &'static str> {
    if args.len() < min || args.len() > max {
        Err(ERROR_VALUE)
    } else {
        Ok(())
    }
}

struct Evaluator<'a> {
    resolve: &'a mut dyn FnMut(&str) -> Option<Result<Value, &'static str>>,
    budget: Option<&'a FormulaProjectionBudget>,
}

impl Evaluator<'_> {
    fn arg(&mut self, args: &[Node], index: usize) -> Evaluated {
        args.get(index)
            .map_or(Ok(FormulaValue::Null), |node| self.eval(node))
    }

    fn numbers(&mut self, args: &[Node]) -> Result<Vec<f64>, &'static str> {
        let mut numbers = Vec::new();
        for node in args {
            let value = self.eval(node)?;
            if value == FormulaValue::Null || value == FormulaValue::Text(String::new()) {
                continue;
            }
            numbers.push(to_number(&value)?);
        }
        Ok(numbers)
    }

    fn call(&mut self, name: &str, args: &[Node]) -> Evaluated {
        match name {
            "IF" => {
                expect_args(args, 2, 3)?;
                if to_boolean(&self.arg(args, 0)?)? {
                    self.arg(args, 1)
                } else if args.len() == 3 {
                    self.arg(args, 2)
                } else {
                    Ok(FormulaValue::Bool(false))
                }
            }
            "AND" => {
                for node in args {
                    if !to_boolean(&self.eval(node)?)? {
                        return Ok(FormulaValue::Bool(false));
                    }
                }
                Ok(FormulaValue::Bool(true))
            }
            "OR" => {
                for node in args {
                    if to_boolean(&self.eval(node)?)? {
                        return Ok(FormulaValue::Bool(true));
                    }
                }
                Ok(FormulaValue::Bool(false))
            }
            "NOT" => {
                expect_args(args, 1, 1)?;
                Ok(FormulaValue::Bool(!to_boolean(&self.arg(args, 0)?)?))
            }
            "SUM" => Ok(FormulaValue::Number(round_result(
                self.numbers(args)?.iter().sum(),
            ))),
            "AVERAGE" => {
                let numbers = self.numbers(args)?;
                if numbers.is_empty() {
                    return Err(ERROR_DIV_ZERO);
                }
                Ok(FormulaValue::Number(round_result(
                    numbers.iter().sum::<f64>() / numbers.len() as f64,
                )))
            }
            "MIN" | "MAX" => {
                let numbers = self.numbers(args)?;
                let pick =
                    numbers.into_iter().reduce(
                        |a, b| {
                            if (name == "MIN") == (b < a) {
                                b
                            } else {
                                a
                            }
                        },
                    );
                Ok(pick.map_or(FormulaValue::Null, FormulaValue::Number))
            }
            "ROUND" => {
                expect_args(args, 1, 2)?;
                let value = to_number(&self.arg(args, 0)?)?;
                let digits = if args.len() == 2 {
                    to_number(&self.arg(args, 1)?)?
                } else {
                    0.0
                };
                let factor = 10f64.powf(digits.trunc());
                Ok(FormulaValue::Number(js_round(value * factor) / factor))
            }
            "ABS" => {
                expect_args(args, 1, 1)?;
                Ok(FormulaValue::Number(to_number(&self.arg(args, 0)?)?.abs()))
            }
            "CONCAT" => {
                let mut text = String::new();
                let mut units = 0usize;
                for node in args {
                    let part = to_text(&self.eval(node)?);
                    units = units.saturating_add(part.encode_utf16().count());
                    if units > MAX_TEXT_LENGTH {
                        return Err(ERROR_VALUE);
                    }
                    text.push_str(&part);
                }
                Ok(FormulaValue::Text(text))
            }
            "LEN" => {
                expect_args(args, 1, 1)?;
                let text = to_text(&self.arg(args, 0)?);
                Ok(FormulaValue::Number(text.encode_utf16().count() as f64))
            }
            "UPPER" | "LOWER" | "TRIM" => {
                expect_args(args, 1, 1)?;
                let text = to_text(&self.arg(args, 0)?);
                bounded_text(match name {
                    "UPPER" => text.to_uppercase(),
                    "LOWER" => text.to_lowercase(),
                    _ => text.trim().to_owned(),
                })
            }
            "CONTAINS" => {
                expect_args(args, 2, 2)?;
                let text = to_text(&self.arg(args, 0)?).to_lowercase();
                let part = to_text(&self.arg(args, 1)?).to_lowercase();
                Ok(FormulaValue::Bool(text.contains(&part)))
            }
            "ISBLANK" => {
                expect_args(args, 1, 1)?;
                let value = self.arg(args, 0)?;
                Ok(FormulaValue::Bool(
                    value == FormulaValue::Null || value == FormulaValue::Text(String::new()),
                ))
            }
            "TODAY" => {
                expect_args(args, 0, 0)?;
                // UTC, so Core and a Desktop in another timezone agree on the day.
                let today = Utc::now().date_naive();
                Ok(FormulaValue::Text(format!(
                    "{:04}-{:02}-{:02}",
                    today.year(),
                    today.month(),
                    today.day()
                )))
            }
            "DAYS" => {
                expect_args(args, 2, 2)?;
                let end = to_day_number(&self.arg(args, 0)?)?;
                let start = to_day_number(&self.arg(args, 1)?)?;
                Ok(FormulaValue::Number(end - start))
            }
            _ => Err(ERROR_NAME),
        }
    }

    fn eval(&mut self, node: &Node) -> Evaluated {
        if let Some(budget) = self.budget {
            budget.check()?;
        }
        let value = match node {
            Node::Literal(value) => Ok(value.clone()),
            Node::Ref(name) => {
                // Only a referenced formula's failure arrives as `Err`; stored
                // text that reads like an error code stays ordinary text.
                let value = (self.resolve)(name).ok_or(ERROR_REF)??;
                Ok(to_formula_value(Some(&value)))
            }
            Node::Unary(op, operand) => {
                let value = to_number(&self.eval(operand)?)?;
                Ok(FormulaValue::Number(if *op == "-" {
                    -value
                } else {
                    value
                }))
            }
            Node::Binary(op, left, right) => {
                let left = self.eval(left)?;
                let right = self.eval(right)?;
                binary(op, &left, &right)
            }
            Node::Call(name, args) => self.call(name, args),
        }?;
        if let Some(budget) = self.budget {
            if let FormulaValue::Text(text) = &value {
                budget.charge_work(text.len())?;
            }
            budget.check()?;
        }
        Ok(value)
    }
}

fn binary(op: &str, left: &FormulaValue, right: &FormulaValue) -> Evaluated {
    let number = |value: f64| Ok(FormulaValue::Number(value));
    match op {
        "+" => number(round_result(to_number(left)? + to_number(right)?)),
        "-" => number(round_result(to_number(left)? - to_number(right)?)),
        "*" => number(round_result(to_number(left)? * to_number(right)?)),
        "/" => {
            let divisor = to_number(right)?;
            if divisor == 0.0 {
                return Err(ERROR_DIV_ZERO);
            }
            number(round_result(to_number(left)? / divisor))
        }
        "^" => number(round_result(to_number(left)?.powf(to_number(right)?))),
        "&" => concat_text(&[to_text(left), to_text(right)]),
        "=" => Ok(FormulaValue::Bool(compare(left, right)? == 0.0)),
        "<>" => Ok(FormulaValue::Bool(compare(left, right)? != 0.0)),
        "<" => Ok(FormulaValue::Bool(compare(left, right)? < 0.0)),
        ">" => Ok(FormulaValue::Bool(compare(left, right)? > 0.0)),
        "<=" => Ok(FormulaValue::Bool(compare(left, right)? <= 0.0)),
        _ => Ok(FormulaValue::Bool(compare(left, right)? >= 0.0)),
    }
}

/// A formula result as a JSON cell value, keeping errors distinct from text.
fn to_result(result: Evaluated) -> Result<Value, &'static str> {
    match result? {
        FormulaValue::Null => Ok(Value::Null),
        FormulaValue::Bool(value) => Ok(Value::Bool(value)),
        FormulaValue::Text(text) => Ok(Value::String(text)),
        FormulaValue::Number(value) if !value.is_finite() => Err(ERROR_VALUE),
        FormulaValue::Number(value) => {
            if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
                Ok(Value::from(value as i64))
            } else {
                Ok(Number::from_f64(value).map_or(Value::Null, Value::Number))
            }
        }
    }
}

/// A formula result as the JSON cell value SQL loads (errors as their code).
#[cfg(test)]
fn to_json(result: Evaluated) -> Value {
    to_result(result).unwrap_or_else(|code| Value::String(code.to_owned()))
}

/// One database column as the formula engine sees it.
pub(crate) struct FormulaColumn<'a> {
    pub expression: Option<&'a str>,
    pub id: &'a str,
    pub label: &'a str,
}

/// Per-query limits shared by compilation, recursive dependencies, and text
/// intermediates. Exhaustion aborts the query rather than becoming a cell error.
pub(crate) struct FormulaProjectionBudget {
    max_bytes: usize,
    retained_bytes: Cell<usize>,
    work_bytes: Cell<usize>,
    deadline: Instant,
}

impl FormulaProjectionBudget {
    pub(crate) fn new(max_bytes: usize, deadline: Instant) -> Self {
        Self {
            max_bytes,
            retained_bytes: Cell::new(0),
            work_bytes: Cell::new(0),
            deadline,
        }
    }

    pub(crate) fn check(&self) -> Result<(), &'static str> {
        if Instant::now() >= self.deadline {
            return Err("database query deadline exceeded");
        }
        if self.retained_bytes.get() > self.max_bytes {
            return Err("database formula projection exceeds the size limit");
        }
        if self.work_bytes.get() > self.max_bytes.saturating_mul(4) {
            return Err("database formula evaluation exceeds the size limit");
        }
        Ok(())
    }

    fn charge_work(&self, bytes: usize) -> Result<(), &'static str> {
        self.work_bytes
            .set(self.work_bytes.get().saturating_add(bytes));
        self.check()
    }

    fn charge_result(
        &self,
        id: &str,
        value: &Result<Value, &'static str>,
    ) -> Result<(), &'static str> {
        self.check()?;
        let bytes = match value {
            Ok(Value::String(text)) => text.len(),
            Err(code) => code.len(),
            _ => 0,
        }
        .saturating_add(id.len())
        .saturating_add(32);
        self.retained_bytes
            .set(self.retained_bytes.get().saturating_add(bytes));
        self.check()
    }
}

/// Fill every formula column's computed value into `rows` (in place). Formulas
/// may reference any column by label or id, including other formulas; cycles
/// become `#CYCLE!` and invalid formulas their error code.
pub(crate) fn apply_formula_columns(
    columns: &[FormulaColumn<'_>],
    rows: &mut [Map<String, Value>],
    budget: &FormulaProjectionBudget,
) -> Result<(), &'static str> {
    budget.check()?;
    let compiled: HashMap<&str, Result<Node, &'static str>> = columns
        .iter()
        .filter_map(|column| {
            column
                .expression
                .map(|expression| (column.id, compile_bounded(expression, Some(budget))))
        })
        .collect();
    budget.check()?;
    if compiled.is_empty() {
        return budget.check();
    }
    let mut by_name: HashMap<String, usize> = HashMap::new();
    for (index, column) in columns.iter().enumerate() {
        by_name.insert(column.id.to_lowercase(), index);
    }
    for (index, column) in columns.iter().enumerate() {
        by_name.insert(column.label.trim().to_lowercase(), index);
    }

    for row in rows.iter_mut() {
        budget.check()?;
        let mut results: HashMap<usize, Result<Value, &'static str>> = HashMap::new();
        let mut visiting: HashSet<usize> = HashSet::new();
        for (index, column) in columns.iter().enumerate() {
            if column.expression.is_some() {
                // The result is cached in `results`, which is written below.
                let _ = compute(
                    index,
                    columns,
                    &compiled,
                    &by_name,
                    row,
                    &mut results,
                    &mut visiting,
                    budget,
                );
                budget.check()?;
            }
        }
        for (index, value) in results {
            if let Some(column) = columns.get(index) {
                let value = value.unwrap_or_else(|code| Value::String(code.to_owned()));
                row.insert(column.id.to_owned(), value);
            }
        }
    }
    budget.check()
}

fn compute(
    index: usize,
    columns: &[FormulaColumn<'_>],
    compiled: &HashMap<&str, Result<Node, &'static str>>,
    by_name: &HashMap<String, usize>,
    row: &Map<String, Value>,
    results: &mut HashMap<usize, Result<Value, &'static str>>,
    visiting: &mut HashSet<usize>,
    budget: &FormulaProjectionBudget,
) -> Result<Value, &'static str> {
    budget.check()?;
    if let Some(value) = results.get(&index) {
        return value.clone();
    }
    if visiting.contains(&index) {
        return Err(ERROR_CYCLE);
    }
    let column = &columns[index];
    let tree = match compiled.get(column.id) {
        Some(Ok(tree)) => tree.clone(),
        Some(Err(code)) => return Err(code),
        None => return Err(ERROR_SYNTAX),
    };
    visiting.insert(index);
    let mut resolve = |name: &str| -> Option<Result<Value, &'static str>> {
        let target = *by_name.get(&name.trim().to_lowercase())?;
        if columns[target].expression.is_some() {
            Some(compute(
                target, columns, compiled, by_name, row, results, visiting, budget,
            ))
        } else {
            Some(Ok(row
                .get(columns[target].id)
                .cloned()
                .unwrap_or(Value::Null)))
        }
    };
    let value = to_result(
        Evaluator {
            resolve: &mut resolve,
            budget: Some(budget),
        }
        .eval(&tree),
    );
    visiting.remove(&index);
    budget.charge_result(column.id, &value)?;
    results.insert(index, value.clone());
    value
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn run(expression: &str, row: Value) -> Value {
        let row = row.as_object().cloned().unwrap_or_default();
        let mut resolve = |name: &str| row.get(name).cloned().map(Ok);
        match compile(expression) {
            Err(code) => Value::String(code.to_owned()),
            Ok(tree) => to_json(
                Evaluator {
                    resolve: &mut resolve,
                    budget: None,
                }
                .eval(&tree),
            ),
        }
    }

    #[test]
    fn projection_budget_counts_utf8_dependencies_and_rows_before_retaining_them() {
        let columns = [
            FormulaColumn {
                id: "C0",
                label: "C0",
                expression: Some("\"é\""),
            },
            FormulaColumn {
                id: "C1",
                label: "C1",
                expression: Some("{C0}"),
            },
        ];
        let deadline = Instant::now() + std::time::Duration::from_secs(5);
        // Each cached cell uses two UTF-8 bytes, a two-byte key, and overhead.
        let mut rows = vec![Map::new()];
        apply_formula_columns(
            &columns,
            &mut rows,
            &FormulaProjectionBudget::new(72, deadline),
        )
        .unwrap();
        assert_eq!(rows[0]["C1"], json!("é"));
        let mut rows = vec![Map::new()];
        let error = apply_formula_columns(
            &columns,
            &mut rows,
            &FormulaProjectionBudget::new(71, deadline),
        )
        .unwrap_err();
        assert!(error.contains("projection exceeds"));
        assert!(rows[0].is_empty());
        let mut rows = vec![Map::new(), Map::new()];
        assert!(apply_formula_columns(
            &columns,
            &mut rows,
            &FormulaProjectionBudget::new(143, deadline)
        )
        .is_err());
    }

    #[test]
    fn expired_projection_deadline_aborts_compilation_and_evaluation() {
        let budget = FormulaProjectionBudget::new(1024, Instant::now());
        assert_eq!(
            compile_bounded("1 + 2", Some(&budget)).unwrap_err(),
            "database query deadline exceeded"
        );
        let tree = compile("1 + 2").unwrap();
        let mut resolve = |_: &str| None;
        assert_eq!(
            Evaluator {
                resolve: &mut resolve,
                budget: Some(&budget)
            }
            .eval(&tree)
            .unwrap_err(),
            "database query deadline exceeded"
        );
    }

    #[test]
    fn temporary_text_work_exhaustion_aborts_instead_of_becoming_a_cell_error() {
        let columns = [
            FormulaColumn {
                id: "raw",
                label: "raw",
                expression: None,
            },
            FormulaColumn {
                id: "n",
                label: "n",
                expression: Some("LEN({raw})"),
            },
        ];
        let mut rows = vec![json!({"raw": "x".repeat(512)}).as_object().unwrap().clone()];
        let budget =
            FormulaProjectionBudget::new(64, Instant::now() + std::time::Duration::from_secs(5));
        let error = apply_formula_columns(&columns, &mut rows, &budget).unwrap_err();
        assert!(error.contains("evaluation exceeds"));
        assert!(!rows[0].contains_key("n"));
    }

    #[test]
    fn concat_rejects_oversized_stored_text_incrementally_but_len_still_works() {
        let stored = json!({"big": "x".repeat(2 * 1024 * 1024)});
        let expression = format!("CONCAT({})", vec!["{big}"; 100].join(","));
        assert_eq!(run(&expression, stored.clone()), json!(ERROR_VALUE));
        assert_eq!(run("LEN({big})", stored), json!(2 * 1024 * 1024));
    }

    #[test]
    fn arithmetic_follows_precedence_and_associativity() {
        assert_eq!(run("1 + 2 * 3", json!({})), json!(7));
        assert_eq!(run("(1 + 2) * 3", json!({})), json!(9));
        assert_eq!(run("2 ^ 3 ^ 2", json!({})), json!(512));
        assert_eq!(run("-2 ^ 2", json!({})), json!(4));
        assert_eq!(run("0.1 + 0.2", json!({})), json!(0.3));
        assert_eq!(run("=10 / 4", json!({})), json!(2.5));
    }

    #[test]
    fn column_references_coerce_like_a_spreadsheet() {
        let row = json!({"Price": 2.5, "Qty": "4", "Done": true, "Note": null, "Tags": ["a", "b"]});
        assert_eq!(run("{Price} * {Qty}", row.clone()), json!(10));
        assert_eq!(run("{Done} + 1", row.clone()), json!(2));
        assert_eq!(run("{Note} + 1", row.clone()), json!(1));
        assert_eq!(run("{Tags} & \"!\"", row), json!("a, b!"));
    }

    #[test]
    fn comparison_and_text() {
        assert_eq!(run("\"abc\" = \"ABC\"", json!({})), json!(true));
        assert_eq!(run("3 <> 3", json!({})), json!(false));
        assert_eq!(run("2 != 3", json!({})), json!(true));
        assert_eq!(run("\"say \"\"hi\"\"\"", json!({})), json!("say \"hi\""));
        assert_eq!(run("\"a\" & 1 & TRUE", json!({})), json!("a1TRUE"));
        assert_eq!(run("\"x\" & 2.5 & 1e21", json!({})), json!("x2.51e+21"));
    }

    #[test]
    #[allow(
        clippy::approx_constant,
        reason = "3.14 is ROUND(3.14159, 2)'s expected result, not an approximation of pi"
    )]
    fn functions() {
        assert_eq!(
            run("IF({x} > 1, \"big\", \"small\")", json!({"x": 2})),
            json!("big")
        );
        assert_eq!(run("IF(FALSE, 1)", json!({})), json!(false));
        assert_eq!(run("AND(TRUE, 1, NOT(FALSE))", json!({})), json!(true));
        assert_eq!(run("SUM(1, 2, {x})", json!({"x": 3})), json!(6));
        assert_eq!(
            run("AVERAGE(1, 2, {blank})", json!({"blank": null})),
            json!(1.5)
        );
        assert_eq!(run("MIN(3, 1, 2) + MAX(4, 9)", json!({})), json!(10));
        assert_eq!(run("ROUND(3.14159, 2)", json!({})), json!(3.14));
        assert_eq!(run("ROUND(-2.5)", json!({})), json!(-2));
        assert_eq!(run("ABS(-4)", json!({})), json!(4));
        assert_eq!(run("CONCAT(\"a\", 1, \"b\")", json!({})), json!("a1b"));
        assert_eq!(run("LEN(\"four\")", json!({})), json!(4));
        assert_eq!(run("UPPER(TRIM(\" x \"))", json!({})), json!("X"));
        assert_eq!(run("CONTAINS(\"Hello\", \"ELL\")", json!({})), json!(true));
        assert_eq!(run("ISBLANK({x})", json!({"x": ""})), json!(true));
        assert_eq!(
            run("DAYS(\"2026-03-01\", \"2026-02-01\")", json!({})),
            json!(28)
        );
        assert_eq!(run("LEN(TODAY())", json!({})), json!(10));
    }

    #[test]
    fn errors_are_values() {
        assert_eq!(run("1 / 0", json!({})), json!(ERROR_DIV_ZERO));
        assert_eq!(run("\"x\" * 2", json!({})), json!(ERROR_VALUE));
        assert_eq!(run("{Missing} + 1", json!({})), json!(ERROR_REF));
        assert_eq!(run("Price + 1", json!({})), json!(ERROR_NAME));
        assert_eq!(run("NOPE(1)", json!({})), json!(ERROR_NAME));
        assert_eq!(run("1 +", json!({})), json!(ERROR_SYNTAX));
        assert_eq!(run("(1", json!({})), json!(ERROR_SYNTAX));
        assert_eq!(run("{Price", json!({})), json!(ERROR_SYNTAX));
        assert_eq!(run("", json!({})), json!(ERROR_SYNTAX));
        assert_eq!(run("ROUND()", json!({})), json!(ERROR_VALUE));
    }

    #[test]
    fn limits_nesting_length_and_text_growth() {
        let deep = format!("{}1{}", "(".repeat(20_000), ")".repeat(20_000));
        assert_eq!(run(&deep, json!({})), json!(ERROR_SYNTAX));
        assert_eq!(run(&"-".repeat(500), json!({})), json!(ERROR_SYNTAX));
        let long = vec!["1"; 600].join("+");
        assert_eq!(run(&long, json!({})), json!(ERROR_SYNTAX));
        let nested = format!("{}1{}", "(".repeat(30), ")".repeat(30));
        assert_eq!(run(&nested, json!({})), json!(1));
        let big = "x".repeat(MAX_TEXT_LENGTH);
        assert_eq!(
            run("{t} & \"y\"", json!({"t": big.clone()})),
            json!(ERROR_VALUE)
        );
        assert_eq!(
            run("CONCAT({t}, {t})", json!({"t": big.clone()})),
            json!(ERROR_VALUE)
        );
        assert_eq!(
            run("LEN({t} & \"\")", json!({"t": big})),
            json!(MAX_TEXT_LENGTH)
        );
    }

    #[test]
    fn text_coerces_only_in_decimal_form() {
        assert_eq!(run("{x} + 1", json!({"x": " 1.5e1 "})), json!(16));
        assert_eq!(run("{x} + 1", json!({"x": ".5"})), json!(1.5));
        assert_eq!(run("{x} + 1", json!({"x": "-2."})), json!(-1));
        assert_eq!(run("{x} + 1", json!({"x": "0x10"})), json!(ERROR_VALUE));
        assert_eq!(run("{x} + 1", json!({"x": "0b1"})), json!(ERROR_VALUE));
        assert_eq!(run("{x} + 1", json!({"x": "1e"})), json!(ERROR_VALUE));
        assert_eq!(run("{x} + 1", json!({"x": "."})), json!(ERROR_VALUE));
    }

    #[test]
    fn stored_error_like_text_is_plain_text() {
        assert_eq!(
            run("{Notes} & \" details\"", json!({"Notes": "#REF!"})),
            json!("#REF! details")
        );
        let columns = [
            FormulaColumn {
                id: "a",
                label: "A",
                expression: Some("\"#DIV/0!\""),
            },
            FormulaColumn {
                id: "b",
                label: "B",
                expression: Some("{A} & \"?\""),
            },
            FormulaColumn {
                id: "c",
                label: "C",
                expression: Some("1 / 0"),
            },
            FormulaColumn {
                id: "d",
                label: "D",
                expression: Some("{C} & \"?\""),
            },
        ];
        let mut rows = vec![Map::new()];
        apply_formula_columns(
            &columns,
            &mut rows,
            &FormulaProjectionBudget::new(
                16 * 1024 * 1024,
                Instant::now() + std::time::Duration::from_secs(5),
            ),
        )
        .unwrap();
        assert_eq!(
            Value::Object(rows.remove(0)),
            json!({"a": "#DIV/0!", "b": "#DIV/0!?", "c": ERROR_DIV_ZERO, "d": ERROR_DIV_ZERO})
        );
    }

    #[test]
    fn applies_formula_columns_including_chains_and_cycles() {
        let columns = [
            FormulaColumn {
                id: "price",
                label: "Price",
                expression: None,
            },
            FormulaColumn {
                id: "qty",
                label: "Qty",
                expression: None,
            },
            FormulaColumn {
                id: "total",
                label: "Total",
                expression: Some("{Price} * {qty}"),
            },
            FormulaColumn {
                id: "taxed",
                label: "Taxed",
                expression: Some("{Total} * 1.1"),
            },
            FormulaColumn {
                id: "a",
                label: "A",
                expression: Some("{B} + 1"),
            },
            FormulaColumn {
                id: "b",
                label: "B",
                expression: Some("{A} + 1"),
            },
        ];
        let mut rows = vec![json!({"price": 2, "qty": 3, "total": ""})
            .as_object()
            .cloned()
            .unwrap_or_default()];
        apply_formula_columns(
            &columns,
            &mut rows,
            &FormulaProjectionBudget::new(
                16 * 1024 * 1024,
                Instant::now() + std::time::Duration::from_secs(5),
            ),
        )
        .unwrap();
        assert_eq!(
            Value::Object(rows.remove(0)),
            json!({"price": 2, "qty": 3, "total": 6, "taxed": 6.6, "a": ERROR_CYCLE, "b": ERROR_CYCLE})
        );
    }
}
