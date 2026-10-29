//! Device capability validation (RHP v1.1 design §6.2), identical to the C firmware's
//! `capability/rhp_cap` and pinned by `tests/vectors/rhp_v1_1_capabilities.json`.
//!
//! A secure device registers a table of capabilities with `capabilities_register`.
//! This module validates each descriptor (name, sanitised description, a flat and
//! bounded parameter schema, timeout and policy flags), translates the parameter
//! schema to a JSON Schema for agent tools, validates invoke arguments, and derives
//! the agent tool name. It also holds the per-device prefs rules
//! (`capabilities_enabled`, `capabilities{name: bool}`, `relay_mirror`) shared by
//! the registry API and Core's `device` MCP server.
//!
//! Validation order for each descriptor in a register message (the C mirror uses
//! the same order): the descriptor itself (`invalid_name`, `reserved`,
//! `invalid_schema`), then `duplicate` against the names already accepted, then
//! `limit` once 32 capabilities have been accepted.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Number, Value};

use crate::noise;

/// Maximum capabilities per device.
pub const MAX_CAPS: usize = 32;
/// Maximum concurrent invokes per connection.
pub const MAX_INFLIGHT: usize = 4;
/// Maximum serialized `capability_result.result` size.
pub const MAX_RESULT_BYTES: usize = 16_384;
/// Maximum serialized `capabilities_register` message size.
pub const MAX_REGISTER_BYTES: usize = 16_384;
/// Maximum serialized invoke `args` size.
pub const MAX_ARGS_BYTES: usize = 8_192;
/// Maximum parameters per capability (required + optional).
pub const MAX_PARAMS: usize = 16;
/// Maximum `enum` entries per parameter.
pub const MAX_ENUM: usize = 16;
/// Maximum `max_len` of a string parameter.
pub const MAX_STRING_LEN: u64 = 4_096;
/// Maximum capability name length.
pub const MAX_NAME_LEN: usize = 32;
/// Maximum sanitised capability description length (in characters).
pub const MAX_DESCRIPTION_CHARS: usize = 200;
/// Maximum sanitised parameter description length (in characters).
pub const MAX_PARAM_DESCRIPTION_CHARS: usize = 120;
/// Default capability timeout.
pub const DEFAULT_TIMEOUT_MS: u32 = 10_000;
/// Minimum explicit capability timeout.
pub const MIN_TIMEOUT_MS: u32 = 100;
/// Maximum explicit capability timeout.
pub const MAX_TIMEOUT_MS: u32 = 60_000;
/// First name segments a device may not use.
pub const RESERVED_SEGMENTS: [&str; 6] = ["ryu", "system", "web", "browser", "computer", "memory"];
/// Longest device id used verbatim as the tool-name device key.
pub const MAX_VERBATIM_DEVICE_KEY: usize = 22;

/// The four parameter types of the flat schema subset.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParamType {
    String,
    Integer,
    Number,
    Boolean,
}

impl ParamType {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "string" => Some(ParamType::String),
            "integer" => Some(ParamType::Integer),
            "number" => Some(ParamType::Number),
            "boolean" => Some(ParamType::Boolean),
            _ => None,
        }
    }

    /// The JSON-schema / wire type name.
    pub fn as_str(self) -> &'static str {
        match self {
            ParamType::String => "string",
            ParamType::Integer => "integer",
            ParamType::Number => "number",
            ParamType::Boolean => "boolean",
        }
    }
}

/// One validated parameter.
#[derive(Clone, Debug, PartialEq)]
pub struct ParamSpec {
    pub name: String,
    pub param_type: ParamType,
    pub description: String,
    pub required: bool,
    pub enum_values: Option<Vec<Value>>,
    pub min: Option<Number>,
    pub max: Option<Number>,
    pub max_len: Option<u64>,
}

/// `confirm` policy: `none` (default) or `device_press`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfirmPolicy {
    #[default]
    None,
    DevicePress,
}

impl ConfirmPolicy {
    /// The wire string.
    pub fn as_str(self) -> &'static str {
        match self {
            ConfirmPolicy::None => "none",
            ConfirmPolicy::DevicePress => "device_press",
        }
    }
}

/// A capability that passed validation.
#[derive(Clone, Debug, PartialEq)]
pub struct ValidCapability {
    pub name: String,
    /// Sanitised description (1 to 200 characters).
    pub description: String,
    /// Required parameters first, then optional ones.
    pub params: Vec<ParamSpec>,
    pub timeout_ms: u32,
    pub sensitive: bool,
    pub confirm: ConfirmPolicy,
}

/// Why one descriptor was rejected (`capabilities_ack.rejected[].code`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RejectCode {
    InvalidName,
    InvalidSchema,
    Duplicate,
    Limit,
    Reserved,
}

impl RejectCode {
    /// The wire string.
    pub fn as_str(self) -> &'static str {
        match self {
            RejectCode::InvalidName => "invalid_name",
            RejectCode::InvalidSchema => "invalid_schema",
            RejectCode::Duplicate => "duplicate",
            RejectCode::Limit => "limit",
            RejectCode::Reserved => "reserved",
        }
    }
}

/// One rejected descriptor in `capabilities_ack`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityRejection {
    pub name: String,
    pub code: RejectCode,
}

/// A whole `capabilities_register` message was refused (the session answers with
/// `error{capabilities_rejected}`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RegisterError {
    /// `generation` is 0 or not strictly greater than the previous one.
    BadGeneration,
    /// The serialized message exceeds [`MAX_REGISTER_BYTES`].
    TooLarge,
}

impl RegisterError {
    /// The encrypted error code the session sends.
    pub fn code(self) -> &'static str {
        "capabilities_rejected"
    }

    /// Human-readable detail.
    pub fn message(self) -> &'static str {
        match self {
            RegisterError::BadGeneration => "generation must be at least 1 and strictly increasing",
            RegisterError::TooLarge => "capabilities_register exceeds 16384 bytes",
        }
    }
}

/// Invoke arguments did not match the capability's schema (`invalid_args`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArgsError {
    pub message: String,
}

impl ArgsError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    /// The stable code.
    pub fn code(&self) -> &'static str {
        "invalid_args"
    }
}

impl std::fmt::Display for ArgsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "invalid_args: {}", self.message)
    }
}

impl std::error::Error for ArgsError {}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

fn is_segment(segment: &str) -> bool {
    let bytes = segment.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 32
        && bytes[0].is_ascii_lowercase()
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_')
}

/// `^[a-z][a-z0-9_]{0,31}([.][a-z][a-z0-9_]{0,31}){0,2}$`, at most 32 characters,
/// and no `__`.
pub fn is_valid_name(name: &str) -> bool {
    if name.is_empty() || name.len() > MAX_NAME_LEN || name.contains("__") {
        return false;
    }
    let segments: Vec<&str> = name.split('.').collect();
    segments.len() <= 3 && segments.iter().all(|s| is_segment(s))
}

/// Whether a (syntactically valid) name uses a reserved first segment.
pub fn is_reserved_name(name: &str) -> bool {
    let first = name.split('.').next().unwrap_or_default();
    RESERVED_SEGMENTS.contains(&first)
}

/// `^[a-z][a-z0-9_]{0,31}$`.
pub fn is_valid_param_name(name: &str) -> bool {
    is_segment(name)
}

// ---------------------------------------------------------------------------
// Descriptions
// ---------------------------------------------------------------------------

fn is_stripped(c: char) -> bool {
    let cp = c as u32;
    cp <= 0x1F
        || (0x7F..=0x9F).contains(&cp)
        || (0x200B..=0x200F).contains(&cp)
        || (0x202A..=0x202E).contains(&cp)
        || (0x2066..=0x2069).contains(&cp)
        || cp == 0xFEFF
}

fn is_collapsed_space(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r' | '\u{0B}' | '\u{0C}')
}

/// Sanitise a device-provided description:
///
/// 1. ASCII whitespace (space, tab, LF, CR, VT, FF) becomes a space;
/// 2. the remaining C0/C1 controls (and DEL), U+200B-200F, U+202A-202E,
///    U+2066-2069 and U+FEFF are removed;
/// 3. runs of spaces collapse to one and the ends are trimmed;
/// 4. the result is truncated to `max_chars` Unicode scalar values (and trimmed
///    again).
pub fn sanitize_description(raw: &str, max_chars: usize) -> String {
    let mut out = String::with_capacity(raw.len().min(max_chars * 4));
    let mut pending_space = false;
    for c in raw.chars() {
        if is_collapsed_space(c) {
            pending_space = !out.is_empty();
            continue;
        }
        if is_stripped(c) {
            continue;
        }
        if pending_space {
            out.push(' ');
            pending_space = false;
        }
        out.push(c);
    }
    if out.chars().count() > max_chars {
        out = out.chars().take(max_chars).collect();
        let trimmed_len = out.trim_end_matches(' ').len();
        out.truncate(trimmed_len);
    }
    out
}

// ---------------------------------------------------------------------------
// Descriptor validation
// ---------------------------------------------------------------------------

const DESCRIPTOR_KEYS: [&str; 6] = [
    "name",
    "description",
    "params",
    "timeout_ms",
    "sensitive",
    "confirm",
];
const PARAMS_KEYS: [&str; 2] = ["required", "optional"];
const PARAM_KEYS: [&str; 6] = ["type", "description", "enum", "min", "max", "max_len"];

fn only_keys(object: &Map<String, Value>, allowed: &[&str]) -> bool {
    object.keys().all(|k| allowed.contains(&k.as_str()))
}

fn as_u64_strict(value: &Value) -> Option<u64> {
    value.as_u64()
}

fn is_integral(number: &Number) -> bool {
    number.is_i64() || number.is_u64() || number.as_f64().is_some_and(|f| f.fract() == 0.0)
}

fn validate_param(name: &str, spec: &Value, required: bool) -> Result<ParamSpec, RejectCode> {
    let invalid = Err(RejectCode::InvalidSchema);
    if !is_valid_param_name(name) {
        return invalid;
    }
    let Some(object) = spec.as_object() else {
        return invalid;
    };
    if !only_keys(object, &PARAM_KEYS) {
        return invalid;
    }
    let Some(param_type) = object
        .get("type")
        .and_then(Value::as_str)
        .and_then(ParamType::parse)
    else {
        return invalid;
    };
    let Some(raw_description) = object.get("description").and_then(Value::as_str) else {
        return invalid;
    };
    let description = sanitize_description(raw_description, MAX_PARAM_DESCRIPTION_CHARS);
    if description.is_empty() {
        return invalid;
    }

    let enum_values = match object.get("enum") {
        None => None,
        Some(Value::Array(values)) => {
            let typed = values.iter().all(|v| match param_type {
                ParamType::String => v.is_string(),
                ParamType::Integer => v.as_number().is_some_and(is_integral),
                _ => false,
            });
            if values.is_empty() || values.len() > MAX_ENUM || !typed {
                return invalid;
            }
            Some(values.clone())
        }
        Some(_) => return invalid,
    };

    let numeric = matches!(param_type, ParamType::Integer | ParamType::Number);
    let bound = |key: &str| -> Result<Option<Number>, RejectCode> {
        match object.get(key) {
            None => Ok(None),
            Some(Value::Number(n)) if numeric => {
                if param_type == ParamType::Integer && !is_integral(n) {
                    return Err(RejectCode::InvalidSchema);
                }
                Ok(Some(n.clone()))
            }
            Some(_) => Err(RejectCode::InvalidSchema),
        }
    };
    let min = bound("min")?;
    let max = bound("max")?;
    if let (Some(lo), Some(hi)) = (&min, &max) {
        if lo.as_f64() > hi.as_f64() {
            return invalid;
        }
    }

    let max_len = match object.get("max_len") {
        None => None,
        Some(value) if param_type == ParamType::String => match as_u64_strict(value) {
            Some(n) if (1..=MAX_STRING_LEN).contains(&n) => Some(n),
            _ => return invalid,
        },
        Some(_) => return invalid,
    };

    Ok(ParamSpec {
        name: name.to_string(),
        param_type,
        description,
        required,
        enum_values,
        min,
        max,
        max_len,
    })
}

fn validate_params(params: Option<&Value>) -> Result<Vec<ParamSpec>, RejectCode> {
    let invalid = Err(RejectCode::InvalidSchema);
    let Some(Value::Object(params)) = params else {
        return invalid;
    };
    if !only_keys(params, &PARAMS_KEYS) {
        return invalid;
    }
    let group = |key: &str| -> Result<Option<&Map<String, Value>>, RejectCode> {
        match params.get(key) {
            None => Ok(None),
            Some(Value::Object(map)) => Ok(Some(map)),
            Some(_) => Err(RejectCode::InvalidSchema),
        }
    };
    let required = group("required")?;
    let optional = group("optional")?;
    let total = required.map_or(0, Map::len) + optional.map_or(0, Map::len);
    if total > MAX_PARAMS {
        return invalid;
    }
    let mut out = Vec::with_capacity(total);
    for (name, spec) in required.into_iter().flatten() {
        out.push(validate_param(name, spec, true)?);
    }
    for (name, spec) in optional.into_iter().flatten() {
        if required.is_some_and(|r| r.contains_key(name)) {
            return invalid;
        }
        out.push(validate_param(name, spec, false)?);
    }
    Ok(out)
}

/// Validate one descriptor on its own (no duplicate or limit checks).
pub fn validate_descriptor(raw: &Value) -> Result<ValidCapability, RejectCode> {
    let Some(object) = raw.as_object() else {
        return Err(RejectCode::InvalidName);
    };
    let Some(name) = object.get("name").and_then(Value::as_str) else {
        return Err(RejectCode::InvalidName);
    };
    if !is_valid_name(name) {
        return Err(RejectCode::InvalidName);
    }
    if is_reserved_name(name) {
        return Err(RejectCode::Reserved);
    }
    if !only_keys(object, &DESCRIPTOR_KEYS) {
        return Err(RejectCode::InvalidSchema);
    }
    let Some(raw_description) = object.get("description").and_then(Value::as_str) else {
        return Err(RejectCode::InvalidSchema);
    };
    let description = sanitize_description(raw_description, MAX_DESCRIPTION_CHARS);
    if description.is_empty() {
        return Err(RejectCode::InvalidSchema);
    }
    let params = validate_params(object.get("params"))?;
    let timeout_ms = match object.get("timeout_ms") {
        None => DEFAULT_TIMEOUT_MS,
        Some(value) => match as_u64_strict(value) {
            Some(ms) if (u64::from(MIN_TIMEOUT_MS)..=u64::from(MAX_TIMEOUT_MS)).contains(&ms) => {
                u32::try_from(ms).map_err(|_| RejectCode::InvalidSchema)?
            }
            _ => return Err(RejectCode::InvalidSchema),
        },
    };
    let sensitive = match object.get("sensitive") {
        None => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err(RejectCode::InvalidSchema),
    };
    let confirm = match object.get("confirm").map(Value::as_str) {
        None | Some(Some("none")) => ConfirmPolicy::None,
        Some(Some("device_press")) => ConfirmPolicy::DevicePress,
        Some(_) => return Err(RejectCode::InvalidSchema),
    };
    Ok(ValidCapability {
        name: name.to_string(),
        description,
        params,
        timeout_ms,
        sensitive,
        confirm,
    })
}

/// The accepted capabilities and the per-descriptor rejections of one register.
pub type RegisterOutcome = (Vec<ValidCapability>, Vec<CapabilityRejection>);

/// Validate a whole `capabilities_register`. `prev_generation` is the last accepted
/// generation in this session; `serialized_len` is the size of the CONTROL message.
pub fn validate_register(
    generation: u32,
    prev_generation: Option<u32>,
    raw: &[Value],
    serialized_len: usize,
) -> Result<RegisterOutcome, RegisterError> {
    if serialized_len > MAX_REGISTER_BYTES {
        return Err(RegisterError::TooLarge);
    }
    if generation == 0 || prev_generation.is_some_and(|prev| generation <= prev) {
        return Err(RegisterError::BadGeneration);
    }
    let mut accepted: Vec<ValidCapability> = Vec::new();
    let mut rejected = Vec::new();
    for descriptor in raw {
        let name = descriptor
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let outcome = validate_descriptor(descriptor).and_then(|cap| {
            if accepted.iter().any(|a| a.name == cap.name) {
                Err(RejectCode::Duplicate)
            } else if accepted.len() >= MAX_CAPS {
                Err(RejectCode::Limit)
            } else {
                Ok(cap)
            }
        });
        match outcome {
            Ok(cap) => accepted.push(cap),
            Err(code) => rejected.push(CapabilityRejection { name, code }),
        }
    }
    Ok((accepted, rejected))
}

// ---------------------------------------------------------------------------
// JSON schema and argument validation
// ---------------------------------------------------------------------------

/// Translate a capability's parameters to
/// `{"type":"object","properties","required","additionalProperties":false}`.
pub fn to_json_schema(capability: &ValidCapability) -> Value {
    let mut properties = Map::new();
    let mut required = Vec::new();
    for param in &capability.params {
        let mut prop = Map::new();
        prop.insert("type".into(), json!(param.param_type.as_str()));
        prop.insert("description".into(), json!(param.description));
        if let Some(values) = &param.enum_values {
            prop.insert("enum".into(), Value::Array(values.clone()));
        }
        if let Some(min) = &param.min {
            prop.insert("minimum".into(), Value::Number(min.clone()));
        }
        if let Some(max) = &param.max {
            prop.insert("maximum".into(), Value::Number(max.clone()));
        }
        if let Some(max_len) = param.max_len {
            prop.insert("maxLength".into(), json!(max_len));
        }
        properties.insert(param.name.clone(), Value::Object(prop));
        if param.required {
            required.push(json!(param.name));
        }
    }
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
    })
}

fn number_matches_enum(number: &Number, values: &[Value]) -> bool {
    values
        .iter()
        .any(|v| v.as_number().and_then(Number::as_f64) == number.as_f64())
}

fn validate_value(param: &ParamSpec, value: &Value) -> Result<(), ArgsError> {
    let name = &param.name;
    match param.param_type {
        ParamType::String => {
            let Some(text) = value.as_str() else {
                return Err(ArgsError::new(format!("{name} must be a string")));
            };
            if let Some(max_len) = param.max_len {
                if text.chars().count() as u64 > max_len {
                    return Err(ArgsError::new(format!("{name} is longer than {max_len}")));
                }
            }
            if let Some(values) = &param.enum_values {
                if !values.iter().any(|v| v.as_str() == Some(text)) {
                    return Err(ArgsError::new(format!("{name} is not an allowed value")));
                }
            }
        }
        ParamType::Integer | ParamType::Number => {
            let Some(number) = value.as_number() else {
                return Err(ArgsError::new(format!("{name} must be a number")));
            };
            if param.param_type == ParamType::Integer && !is_integral(number) {
                return Err(ArgsError::new(format!("{name} must be an integer")));
            }
            let x = number.as_f64().unwrap_or(f64::NAN);
            if param
                .min
                .as_ref()
                .and_then(Number::as_f64)
                .is_some_and(|min| x < min)
                || param
                    .max
                    .as_ref()
                    .and_then(Number::as_f64)
                    .is_some_and(|max| x > max)
            {
                return Err(ArgsError::new(format!("{name} is out of range")));
            }
            if let Some(values) = &param.enum_values {
                if !number_matches_enum(number, values) {
                    return Err(ArgsError::new(format!("{name} is not an allowed value")));
                }
            }
        }
        ParamType::Boolean => {
            if !value.is_boolean() {
                return Err(ArgsError::new(format!("{name} must be a boolean")));
            }
        }
    }
    Ok(())
}

/// Validate invoke arguments against a capability: an object of at most 8192
/// serialized bytes, every required key present, no unknown key, and each value
/// within its type, range, `enum` and `max_len`.
pub fn validate_args(capability: &ValidCapability, args: &Value) -> Result<(), ArgsError> {
    let Some(object) = args.as_object() else {
        return Err(ArgsError::new("args must be an object"));
    };
    let size = serde_json::to_vec(args)
        .map(|v| v.len())
        .unwrap_or(usize::MAX);
    if size > MAX_ARGS_BYTES {
        return Err(ArgsError::new("args exceed 8192 bytes"));
    }
    for key in object.keys() {
        if !capability.params.iter().any(|p| &p.name == key) {
            return Err(ArgsError::new(format!("unknown argument {key}")));
        }
    }
    for param in &capability.params {
        match object.get(&param.name) {
            Some(value) => validate_value(param, value)?,
            None if param.required => {
                return Err(ArgsError::new(format!("missing argument {}", param.name)));
            }
            None => {}
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tool naming
// ---------------------------------------------------------------------------

fn is_verbatim_device_key(device_id: &str) -> bool {
    device_id.len() <= MAX_VERBATIM_DEVICE_KEY
        && !device_id.is_empty()
        && device_id.split('_').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

/// The device part of a tool name: the device_id itself when it matches
/// `^[a-z0-9]+(_[a-z0-9]+)*$` and has at most 22 characters, otherwise `d` plus the
/// first 12 hex characters of `SHA256(device_id)`.
pub fn device_key(device_id: &str) -> String {
    if is_verbatim_device_key(device_id) {
        return device_id.to_string();
    }
    let digest = noise::sha256(&[device_id.as_bytes()]);
    format!("d{}", &hex::encode(digest)[..12])
}

/// `<device_key>__<capability with '.' replaced by '-'>`.
pub fn tool_name(device_id: &str, capability: &str) -> String {
    format!(
        "{}__{}",
        device_key(device_id),
        capability.replace('.', "-")
    )
}

/// `device.<tool_name>`, the tool id in Core's `device` MCP server.
pub fn tool_id(device_id: &str, capability: &str) -> String {
    format!("device.{}", tool_name(device_id, capability))
}

// ---------------------------------------------------------------------------
// Device prefs (design §6.5)
// ---------------------------------------------------------------------------

/// Whether the device's capabilities are exposed at all (`capabilities_enabled`,
/// default true).
pub fn capabilities_enabled(prefs: &Value) -> bool {
    prefs
        .get("capabilities_enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

/// Whether one capability is enabled: `capabilities_enabled` must not be false, and
/// then `capabilities[name]` wins, else the default `!sensitive`.
pub fn capability_enabled(prefs: &Value, name: &str, sensitive: bool) -> bool {
    capabilities_enabled(prefs)
        && prefs
            .get("capabilities")
            .and_then(|caps| caps.get(name))
            .and_then(Value::as_bool)
            .unwrap_or(!sensitive)
}

/// Whether the cleartext emotion mirror to a relay phone is on (`relay_mirror`,
/// default true).
pub fn relay_mirror_enabled(prefs: &Value) -> bool {
    prefs
        .get("relay_mirror")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

/// Type-check the capability-related prefs of a `PATCH` body. Returns the
/// human-readable reason for a 400 `bad_prefs`.
pub fn validate_prefs(prefs: &Value) -> Result<(), &'static str> {
    let Some(object) = prefs.as_object() else {
        return Err("prefs must be a JSON object");
    };
    if object
        .get("capabilities_enabled")
        .is_some_and(|v| !v.is_boolean())
    {
        return Err("capabilities_enabled must be a boolean");
    }
    if object.get("relay_mirror").is_some_and(|v| !v.is_boolean()) {
        return Err("relay_mirror must be a boolean");
    }
    match object.get("capabilities") {
        None => {}
        Some(Value::Object(map)) if map.values().all(Value::is_boolean) => {}
        Some(_) => return Err("capabilities must be an object of booleans"),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CAPS: &str = include_str!("../tests/vectors/rhp_v1_1_capabilities.json");

    fn vectors() -> Value {
        serde_json::from_str(CAPS).unwrap()
    }

    fn registered() -> Vec<ValidCapability> {
        let v = vectors();
        let reg = &v["register_valid"];
        let raw = reg["capabilities"].as_array().unwrap();
        let len = serde_json::to_vec(reg).unwrap().len();
        let (accepted, rejected) = validate_register(1, None, raw, len).unwrap();
        assert!(rejected.is_empty(), "{rejected:?}");
        accepted
    }

    #[test]
    fn register_valid_is_accepted() {
        let accepted = registered();
        let names: Vec<&str> = accepted.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["device.status", "display.show_text"]);
        assert_eq!(accepted[1].timeout_ms, 5000);
        assert!(!accepted[1].sensitive);
        assert_eq!(accepted[1].confirm, ConfirmPolicy::None);
    }

    #[test]
    fn json_schema_matches_vector() {
        let accepted = registered();
        let show_text = accepted
            .iter()
            .find(|c| c.name == "display.show_text")
            .unwrap();
        assert_eq!(
            to_json_schema(show_text),
            vectors()["json_schema_display_show_text"]
        );
        assert_eq!(
            to_json_schema(&accepted[0]),
            json!({"type":"object","properties":{},"required":[],"additionalProperties":false})
        );
    }

    #[test]
    fn invalid_descriptors_get_their_codes() {
        let v = vectors();
        for case in v["invalid_descriptors"].as_array().unwrap() {
            let expected = case["code"].as_str().unwrap();
            let code = validate_descriptor(&case["descriptor"]).unwrap_err();
            assert_eq!(code.as_str(), expected, "{}", case["descriptor"]);
            // The same code comes back through a whole register.
            let (accepted, rejected) =
                validate_register(1, None, std::slice::from_ref(&case["descriptor"]), 10).unwrap();
            assert!(accepted.is_empty());
            assert_eq!(rejected[0].code.as_str(), expected);
        }
    }

    #[test]
    fn args_cases_match_vector() {
        let accepted = registered();
        for case in vectors()["args_cases"].as_array().unwrap() {
            let cap = accepted
                .iter()
                .find(|c| c.name == case["capability"].as_str().unwrap())
                .unwrap();
            let result = validate_args(cap, &case["args"]);
            if case["ok"].as_bool().unwrap() {
                assert!(result.is_ok(), "{}: {result:?}", case["args"]);
            } else {
                let err = result.expect_err("must reject");
                assert_eq!(
                    err.code(),
                    case["code"].as_str().unwrap(),
                    "{}",
                    case["args"]
                );
            }
        }
    }

    #[test]
    fn tool_names_match_vector() {
        for case in vectors()["tool_names"].as_array().unwrap() {
            let device_id = case["device_id"].as_str().unwrap();
            let cap = case["capability"].as_str().unwrap();
            assert_eq!(
                tool_name(device_id, cap),
                case["tool_name"].as_str().unwrap()
            );
            assert_eq!(tool_id(device_id, cap), case["tool_id"].as_str().unwrap());
        }
        assert_eq!(
            device_key("Rhw_1"),
            format!("d{}", &hex::encode(noise::sha256(&[b"Rhw_1"]))[..12])
        );
        assert_ne!(device_key("a__b"), "a__b");
        assert!(tool_id("x", "a.b.c").len() <= 63);
    }

    #[test]
    fn duplicates_limit_and_generation() {
        let one = |name: String| json!({"name": name, "description": "d", "params": {"required": {}, "optional": {}}});
        let mut raw: Vec<Value> = (0..33).map(|i| one(format!("cap{i}"))).collect();
        raw.insert(1, one("cap0".into()));
        let (accepted, rejected) = validate_register(2, Some(1), &raw, 100).unwrap();
        assert_eq!(accepted.len(), 32);
        assert_eq!(
            rejected,
            vec![
                CapabilityRejection {
                    name: "cap0".into(),
                    code: RejectCode::Duplicate
                },
                CapabilityRejection {
                    name: "cap32".into(),
                    code: RejectCode::Limit
                },
            ]
        );
        assert_eq!(
            validate_register(0, None, &[], 10),
            Err(RegisterError::BadGeneration)
        );
        assert_eq!(
            validate_register(2, Some(2), &[], 10),
            Err(RegisterError::BadGeneration)
        );
        assert_eq!(
            validate_register(3, Some(2), &[], MAX_REGISTER_BYTES + 1),
            Err(RegisterError::TooLarge)
        );
    }

    #[test]
    fn names_and_reserved_segments() {
        assert!(is_valid_name("a"));
        assert!(is_valid_name("a.b_c.d9"));
        assert!(!is_valid_name("a.b.c.d"));
        assert!(!is_valid_name("a..b"));
        assert!(!is_valid_name("9a"));
        assert!(!is_valid_name(&"a".repeat(33)));
        assert!(is_reserved_name("ryu"));
        assert!(is_reserved_name("memory.read"));
        assert!(!is_reserved_name("memoryx.read"));
        let desc = |name: &str| json!({"name": name, "description": "x", "params": {}});
        assert_eq!(
            validate_descriptor(&desc("web.open")),
            Err(RejectCode::Reserved)
        );
        assert!(validate_descriptor(&desc("led.set")).is_ok());
        let extra = json!({"name": "led.set", "description": "x", "params": {}, "icon": "x"});
        assert_eq!(validate_descriptor(&extra), Err(RejectCode::InvalidSchema));
    }

    #[test]
    fn schema_rules() {
        let with_param = |spec: Value| json!({"name": "led.set", "description": "x", "params": {"required": {"p": spec}}});
        let ok = |spec: Value| validate_descriptor(&with_param(spec)).is_ok();
        assert!(ok(
            json!({"type": "string", "description": "x", "enum": ["a", "b"]})
        ));
        assert!(ok(
            json!({"type": "integer", "description": "x", "enum": [1, 2]})
        ));
        assert!(!ok(
            json!({"type": "number", "description": "x", "enum": [1.5]})
        ));
        assert!(!ok(
            json!({"type": "boolean", "description": "x", "min": 0})
        ));
        assert!(!ok(
            json!({"type": "integer", "description": "x", "max_len": 3})
        ));
        assert!(!ok(
            json!({"type": "string", "description": "x", "max_len": 4097})
        ));
        assert!(!ok(
            json!({"type": "integer", "description": "x", "min": 0.5})
        ));
        assert!(!ok(
            json!({"type": "integer", "description": "x", "min": 5, "max": 1})
        ));
        assert!(!ok(
            json!({"type": "string", "description": "x", "pattern": "a"})
        ));
        assert!(!ok(json!({"type": "string"})));
        let many: Map<String, Value> = (0..17)
            .map(|i| {
                (
                    format!("p{i}"),
                    json!({"type": "boolean", "description": "x"}),
                )
            })
            .collect();
        let too_many = json!({"name": "led.set", "description": "x", "params": {"optional": many}});
        assert_eq!(
            validate_descriptor(&too_many),
            Err(RejectCode::InvalidSchema)
        );
        let timeout = |ms: Value| {
            validate_descriptor(
                &json!({"name": "a", "description": "x", "params": {}, "timeout_ms": ms}),
            )
        };
        assert_eq!(timeout(json!(100)).unwrap().timeout_ms, 100);
        assert_eq!(timeout(json!(60000)).unwrap().timeout_ms, 60000);
        assert!(timeout(json!(60001)).is_err());
        assert!(timeout(json!("5000")).is_err());
        let press = validate_descriptor(
            &json!({"name": "a", "description": "x", "params": {}, "confirm": "device_press", "sensitive": true}),
        )
        .unwrap();
        assert_eq!(press.confirm, ConfirmPolicy::DevicePress);
        assert!(press.sensitive);
    }

    #[test]
    fn description_sanitising_strips_bidi_and_controls() {
        assert_eq!(
            sanitize_description("  Show\u{202E}  a\u{200B}\tmessage\u{0}\n\u{FEFF}now ", 200),
            "Show a message now"
        );
        assert_eq!(
            sanitize_description("\u{2066}\u{2069}\u{85}\u{7F}", 200),
            ""
        );
        assert_eq!(sanitize_description("abc def", 4), "abc");
        assert_eq!(
            sanitize_description(&"é".repeat(300), 200).chars().count(),
            200
        );
    }

    #[test]
    fn prefs_rules() {
        let none = json!({});
        assert!(capability_enabled(&none, "a", false));
        assert!(!capability_enabled(&none, "a", true));
        let overridden = json!({"capabilities": {"a": true, "b": false}});
        assert!(capability_enabled(&overridden, "a", true));
        assert!(!capability_enabled(&overridden, "b", false));
        let off = json!({"capabilities_enabled": false, "capabilities": {"a": true}});
        assert!(!capability_enabled(&off, "a", false));
        assert!(relay_mirror_enabled(&none));
        assert!(!relay_mirror_enabled(&json!({"relay_mirror": false})));
        assert!(validate_prefs(&json!({"capabilities_enabled": true, "relay_mirror": false, "capabilities": {"a": true}, "other": 1})).is_ok());
        assert!(validate_prefs(&json!({"capabilities_enabled": "no"})).is_err());
        assert!(validate_prefs(&json!({"relay_mirror": 1})).is_err());
        assert!(validate_prefs(&json!({"capabilities": {"a": "yes"}})).is_err());
        assert!(validate_prefs(&json!({"capabilities": []})).is_err());
        assert!(validate_prefs(&json!([])).is_err());
    }
}
