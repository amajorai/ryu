//! Metadata predicate filters for retrieval.
//!
//! A small, JSON-encoded filter language evaluated against a chunk's metadata
//! object. The syntax follows the MongoDB-style operators most vector stores
//! accept, so a filter written for one backend reads the same here:
//!
//! ```json
//! { "kind": "page",
//!   "ordinal": { "$lt": 3 },
//!   "$or": [ { "lang": { "$in": ["en", "de"] } }, { "$not": { "draft": true } } ] }
//! ```
//!
//! - A field key maps to either a bare value (shorthand for `$eq`) or an operator
//!   object: `$eq`, `$ne`, `$in`, `$nin`, `$gt`, `$gte`, `$lt`, `$lte`, `$exists`.
//!   Several operators on one field are AND-ed.
//! - `$and` / `$or` take a non-empty array of filters; `$not` takes one filter.
//! - Keys at the same level are AND-ed.
//! - A dotted key (`header.level`) walks nested objects.
//! - When the stored value is an array, `$eq`/`$in` match if any element matches
//!   and `$ne`/`$nin` match only if no element does (the MongoDB rule), so a
//!   `tags: ["a","b"]` chunk matches `{"tags": "a"}`.
//! - Comparisons are numeric for numbers and lexicographic for strings; values of
//!   different types never compare (the predicate is `false`), and a missing
//!   field fails every operator except `$ne`, `$nin` and `$exists: false`.
//!
//! The filter is parsed once ([`MetadataFilter::parse`]) and bounded (depth and
//! node count), so a hostile request cannot make evaluation expensive.

use std::cmp::Ordering;

use anyhow::{bail, Result};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};

/// Maximum nesting of `$and`/`$or`/`$not`.
pub const MAX_FILTER_DEPTH: usize = 16;
/// Maximum number of predicates in one filter.
pub const MAX_FILTER_NODES: usize = 256;
/// Maximum number of values in one `$in`/`$nin` list.
pub const MAX_IN_VALUES: usize = 1_024;

/// A parsed metadata predicate. Round-trips through its JSON form.
#[derive(Debug, Clone, PartialEq)]
pub enum MetadataFilter {
    /// Every sub-filter matches (an empty `And` matches everything).
    And(Vec<MetadataFilter>),
    /// At least one sub-filter matches.
    Or(Vec<MetadataFilter>),
    /// The sub-filter does not match.
    Not(Box<MetadataFilter>),
    /// A comparison on one (possibly dotted) field.
    Field { path: String, op: FieldOp },
}

/// One field comparison.
#[derive(Debug, Clone, PartialEq)]
pub enum FieldOp {
    Eq(Value),
    Ne(Value),
    In(Vec<Value>),
    Nin(Vec<Value>),
    Gt(Value),
    Gte(Value),
    Lt(Value),
    Lte(Value),
    Exists(bool),
}

impl MetadataFilter {
    /// Parse the JSON filter form. `null` and `{}` parse to a filter that
    /// matches everything.
    pub fn parse(value: &Value) -> Result<Self> {
        let mut nodes = 0usize;
        match value {
            Value::Null => Ok(Self::And(Vec::new())),
            other => parse_node(other, 0, &mut nodes),
        }
    }

    /// `true` when the filter matches everything (so callers can skip work).
    pub fn is_empty(&self) -> bool {
        matches!(self, Self::And(items) if items.is_empty())
    }

    /// Evaluate against one chunk's metadata object.
    pub fn matches(&self, metadata: &Map<String, Value>) -> bool {
        match self {
            Self::And(items) => items.iter().all(|f| f.matches(metadata)),
            Self::Or(items) => items.iter().any(|f| f.matches(metadata)),
            Self::Not(inner) => !inner.matches(metadata),
            Self::Field { path, op } => op.matches(lookup(metadata, path)),
        }
    }

    /// The JSON form (inverse of [`Self::parse`]).
    pub fn to_json(&self) -> Value {
        match self {
            Self::And(items) => {
                if items.is_empty() {
                    return Value::Object(Map::new());
                }
                serde_json::json!({ "$and": items.iter().map(Self::to_json).collect::<Vec<_>>() })
            }
            Self::Or(items) => {
                serde_json::json!({ "$or": items.iter().map(Self::to_json).collect::<Vec<_>>() })
            }
            Self::Not(inner) => serde_json::json!({ "$not": inner.to_json() }),
            Self::Field { path, op } => {
                let (name, operand) = match op {
                    FieldOp::Eq(v) => ("$eq", v.clone()),
                    FieldOp::Ne(v) => ("$ne", v.clone()),
                    FieldOp::In(v) => ("$in", Value::Array(v.clone())),
                    FieldOp::Nin(v) => ("$nin", Value::Array(v.clone())),
                    FieldOp::Gt(v) => ("$gt", v.clone()),
                    FieldOp::Gte(v) => ("$gte", v.clone()),
                    FieldOp::Lt(v) => ("$lt", v.clone()),
                    FieldOp::Lte(v) => ("$lte", v.clone()),
                    FieldOp::Exists(v) => ("$exists", Value::Bool(*v)),
                };
                let mut inner = Map::new();
                inner.insert(name.to_owned(), operand);
                let mut outer = Map::new();
                outer.insert(path.clone(), Value::Object(inner));
                Value::Object(outer)
            }
        }
    }
}

impl Serialize for MetadataFilter {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for MetadataFilter {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        Self::parse(&value).map_err(serde::de::Error::custom)
    }
}

fn parse_node(value: &Value, depth: usize, nodes: &mut usize) -> Result<MetadataFilter> {
    if depth > MAX_FILTER_DEPTH {
        bail!("filter nests deeper than {MAX_FILTER_DEPTH} levels");
    }
    let Value::Object(object) = value else {
        bail!("a filter must be a JSON object");
    };
    let mut clauses = Vec::with_capacity(object.len());
    for (key, operand) in object {
        bump(nodes)?;
        match key.as_str() {
            "$and" | "$or" => {
                let Value::Array(items) = operand else {
                    bail!("{key} takes an array of filters");
                };
                if items.is_empty() {
                    bail!("{key} needs at least one filter");
                }
                let parsed = items
                    .iter()
                    .map(|item| parse_node(item, depth + 1, nodes))
                    .collect::<Result<Vec<_>>>()?;
                clauses.push(if key == "$and" {
                    MetadataFilter::And(parsed)
                } else {
                    MetadataFilter::Or(parsed)
                });
            }
            "$not" => clauses.push(MetadataFilter::Not(Box::new(parse_node(
                operand,
                depth + 1,
                nodes,
            )?))),
            other if other.starts_with('$') => bail!("unknown filter operator {other}"),
            "" => bail!("filter field names must not be empty"),
            field => clauses.extend(parse_field(field, operand, nodes)?),
        }
    }
    Ok(if clauses.len() == 1 {
        clauses.remove(0)
    } else {
        MetadataFilter::And(clauses)
    })
}

fn parse_field(field: &str, operand: &Value, nodes: &mut usize) -> Result<Vec<MetadataFilter>> {
    let field_op = |op| MetadataFilter::Field {
        path: field.to_owned(),
        op,
    };
    let Value::Object(ops) = operand else {
        return Ok(vec![field_op(FieldOp::Eq(operand.clone()))]);
    };
    // An object whose keys are not operators is an equality on an object value.
    if !ops.keys().any(|k| k.starts_with('$')) {
        return Ok(vec![field_op(FieldOp::Eq(operand.clone()))]);
    }
    let mut out = Vec::with_capacity(ops.len());
    for (name, arg) in ops {
        bump(nodes)?;
        let list = |arg: &Value| -> Result<Vec<Value>> {
            let Value::Array(items) = arg else {
                bail!("{name} on '{field}' takes an array");
            };
            if items.len() > MAX_IN_VALUES {
                bail!("{name} on '{field}' lists more than {MAX_IN_VALUES} values");
            }
            Ok(items.clone())
        };
        let scalar = |arg: &Value| -> Result<Value> {
            match arg {
                Value::Number(_) | Value::String(_) => Ok(arg.clone()),
                _ => bail!("{name} on '{field}' takes a number or a string"),
            }
        };
        let op = match name.as_str() {
            "$eq" => FieldOp::Eq(arg.clone()),
            "$ne" => FieldOp::Ne(arg.clone()),
            "$in" => FieldOp::In(list(arg)?),
            "$nin" => FieldOp::Nin(list(arg)?),
            "$gt" => FieldOp::Gt(scalar(arg)?),
            "$gte" => FieldOp::Gte(scalar(arg)?),
            "$lt" => FieldOp::Lt(scalar(arg)?),
            "$lte" => FieldOp::Lte(scalar(arg)?),
            "$exists" => match arg {
                Value::Bool(flag) => FieldOp::Exists(*flag),
                _ => bail!("$exists on '{field}' takes a boolean"),
            },
            other => bail!("unknown operator {other} on '{field}'"),
        };
        out.push(field_op(op));
    }
    Ok(out)
}

fn bump(nodes: &mut usize) -> Result<()> {
    *nodes += 1;
    if *nodes > MAX_FILTER_NODES {
        bail!("filter has more than {MAX_FILTER_NODES} predicates");
    }
    Ok(())
}

/// Resolve a dotted path. An exact top-level key wins over a dotted walk, so a
/// field literally named `a.b` stays addressable.
fn lookup<'a>(metadata: &'a Map<String, Value>, path: &str) -> Option<&'a Value> {
    if let Some(value) = metadata.get(path) {
        return Some(value);
    }
    let mut segments = path.split('.');
    let mut current = metadata.get(segments.next()?)?;
    for segment in segments {
        current = current.as_object()?.get(segment)?;
    }
    Some(current)
}

impl FieldOp {
    fn matches(&self, actual: Option<&Value>) -> bool {
        match self {
            Self::Exists(expected) => actual.is_some_and(|v| !v.is_null()) == *expected,
            Self::Eq(expected) => actual.is_some_and(|v| any_element(v, |x| json_eq(x, expected))),
            Self::Ne(expected) => !actual.is_some_and(|v| any_element(v, |x| json_eq(x, expected))),
            Self::In(options) => actual.is_some_and(|v| {
                any_element(v, |x| options.iter().any(|option| json_eq(x, option)))
            }),
            Self::Nin(options) => !actual.is_some_and(|v| {
                any_element(v, |x| options.iter().any(|option| json_eq(x, option)))
            }),
            Self::Gt(bound) => compare_any(actual, bound, |o| o == Ordering::Greater),
            Self::Gte(bound) => compare_any(actual, bound, |o| o != Ordering::Less),
            Self::Lt(bound) => compare_any(actual, bound, |o| o == Ordering::Less),
            Self::Lte(bound) => compare_any(actual, bound, |o| o != Ordering::Greater),
        }
    }
}

/// Apply `predicate` to the value, or to any element when it is an array (the
/// array itself is also tried, so `{"tags": ["a","b"]}` equals the whole array).
fn any_element(value: &Value, predicate: impl Fn(&Value) -> bool) -> bool {
    if predicate(value) {
        return true;
    }
    match value {
        Value::Array(items) => items.iter().any(predicate),
        _ => false,
    }
}

/// JSON equality with numeric normalisation (`3` equals `3.0`).
fn json_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        _ => a == b,
    }
}

fn compare_any(actual: Option<&Value>, bound: &Value, accept: impl Fn(Ordering) -> bool) -> bool {
    let Some(actual) = actual else {
        return false;
    };
    let check = |value: &Value| compare(value, bound).is_some_and(&accept);
    match actual {
        Value::Array(items) => items.iter().any(check),
        other => check(other),
    }
}

fn compare(a: &Value, b: &Value) -> Option<Ordering> {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64()?.partial_cmp(&y.as_f64()?),
        (Value::String(x), Value::String(y)) => Some(x.cmp(y)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn meta(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    fn check(filter: Value, metadata: Value) -> bool {
        MetadataFilter::parse(&filter)
            .unwrap()
            .matches(&meta(metadata))
    }

    #[test]
    fn shorthand_and_explicit_equality() {
        assert!(check(json!({"kind": "page"}), json!({"kind": "page"})));
        assert!(!check(json!({"kind": "page"}), json!({"kind": "file"})));
        assert!(check(
            json!({"kind": {"$eq": "page"}}),
            json!({"kind": "page"})
        ));
        assert!(check(json!({"n": 3}), json!({"n": 3.0})));
        assert!(!check(json!({"kind": "page"}), json!({})));
    }

    #[test]
    fn ne_in_nin_and_arrays() {
        assert!(check(
            json!({"kind": {"$ne": "page"}}),
            json!({"kind": "file"})
        ));
        assert!(check(json!({"kind": {"$ne": "page"}}), json!({})));
        assert!(check(
            json!({"lang": {"$in": ["en", "de"]}}),
            json!({"lang": "de"})
        ));
        assert!(!check(
            json!({"lang": {"$in": ["en"]}}),
            json!({"lang": "fr"})
        ));
        assert!(check(
            json!({"lang": {"$nin": ["en"]}}),
            json!({"lang": "fr"})
        ));
        assert!(check(json!({"tags": "b"}), json!({"tags": ["a", "b"]})));
        assert!(!check(
            json!({"tags": {"$ne": "b"}}),
            json!({"tags": ["a", "b"]})
        ));
        assert!(check(
            json!({"tags": {"$in": ["z", "a"]}}),
            json!({"tags": ["a"]})
        ));
    }

    #[test]
    fn range_operators_compare_numbers_and_strings_only() {
        assert!(check(
            json!({"ordinal": {"$gt": 1, "$lt": 4}}),
            json!({"ordinal": 2})
        ));
        assert!(!check(
            json!({"ordinal": {"$gt": 1, "$lt": 4}}),
            json!({"ordinal": 4})
        ));
        assert!(check(
            json!({"ordinal": {"$gte": 4, "$lte": 4}}),
            json!({"ordinal": 4})
        ));
        assert!(check(
            json!({"date": {"$gte": "2026-01-01"}}),
            json!({"date": "2026-03-01"})
        ));
        assert!(!check(json!({"n": {"$gt": 1}}), json!({"n": "5"})));
        assert!(!check(json!({"n": {"$lt": 1}}), json!({})));
    }

    #[test]
    fn logical_combinators() {
        let filter = json!({
            "$or": [ {"kind": "file"}, {"$and": [ {"kind": "page"}, {"ordinal": {"$lt": 2}} ]} ],
            "$not": {"draft": true}
        });
        assert!(check(filter.clone(), json!({"kind": "file"})));
        assert!(check(filter.clone(), json!({"kind": "page", "ordinal": 1})));
        assert!(!check(
            filter.clone(),
            json!({"kind": "page", "ordinal": 3})
        ));
        assert!(!check(filter, json!({"kind": "file", "draft": true})));
    }

    #[test]
    fn dotted_paths_and_exists() {
        assert!(check(
            json!({"doc.lang": "en"}),
            json!({"doc": {"lang": "en"}})
        ));
        assert!(check(json!({"a.b": 1}), json!({"a.b": 1})));
        assert!(check(json!({"x": {"$exists": true}}), json!({"x": 0})));
        assert!(check(json!({"x": {"$exists": false}}), json!({"x": null})));
        assert!(!check(json!({"x": {"$exists": true}}), json!({})));
    }

    #[test]
    fn empty_filters_match_everything() {
        assert!(MetadataFilter::parse(&Value::Null).unwrap().is_empty());
        assert!(MetadataFilter::parse(&json!({})).unwrap().is_empty());
        assert!(check(json!({}), json!({"anything": 1})));
    }

    #[test]
    fn malformed_filters_are_rejected() {
        for bad in [
            json!([1, 2]),
            json!({"$or": []}),
            json!({"$or": {"a": 1}}),
            json!({"$where": "1"}),
            json!({"a": {"$regex": "x"}}),
            json!({"a": {"$in": "x"}}),
            json!({"a": {"$gt": true}}),
            json!({"a": {"$exists": 1}}),
            json!({"": 1}),
        ] {
            assert!(
                MetadataFilter::parse(&bad).is_err(),
                "{bad} should be rejected"
            );
        }
    }

    #[test]
    fn depth_and_size_are_bounded() {
        let mut deep = json!({"a": 1});
        for _ in 0..(MAX_FILTER_DEPTH + 2) {
            deep = json!({ "$not": deep });
        }
        assert!(MetadataFilter::parse(&deep).is_err());
        let wide: Map<String, Value> = (0..(MAX_FILTER_NODES + 1))
            .map(|i| (format!("f{i}"), json!(i)))
            .collect();
        assert!(MetadataFilter::parse(&Value::Object(wide)).is_err());
    }

    #[test]
    fn json_round_trip_preserves_semantics() {
        let source = json!({"kind": "page", "$or": [{"n": {"$gt": 2}}, {"tags": {"$in": ["x"]}}]});
        let parsed = MetadataFilter::parse(&source).unwrap();
        let reparsed = MetadataFilter::parse(&parsed.to_json()).unwrap();
        for sample in [
            json!({"kind": "page", "n": 3}),
            json!({"kind": "page", "tags": ["x"]}),
            json!({"kind": "page", "n": 1}),
            json!({"kind": "file", "n": 9}),
        ] {
            assert_eq!(
                parsed.matches(&meta(sample.clone())),
                reparsed.matches(&meta(sample))
            );
        }
        let via_serde: MetadataFilter = serde_json::from_value(source).unwrap();
        assert_eq!(via_serde, parsed);
    }
}
