//! A plugin's key-value storage: one JSON file in its own data folder, capped in keys and size.

use serde::Deserialize;
use serde_json::{Map, Value};

pub const MAX_KEY: usize = 128;
pub const MAX_VALUE: usize = 32 * 1024;
pub const MAX_TOTAL: usize = 256 * 1024;
pub const MAX_KEYS: usize = 256;

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub enum Op {
    Get { key: String },
    Set { key: String, value: Value },
    Remove { key: String },
    Keys,
}

/// Runs one operation on the map: its result, and whether the map changed (and has to be written).
pub fn apply(map: &mut Map<String, Value>, op: Op) -> Result<(Value, bool), &'static str> {
    let key_ok = |k: &str| !k.is_empty() && k.chars().count() <= MAX_KEY && !k.chars().any(char::is_control);
    match op {
        Op::Keys => Ok((Value::Array(map.keys().cloned().map(Value::String).collect()), false)),
        Op::Get { key } if key_ok(&key) => Ok((map.get(&key).cloned().unwrap_or(Value::Null), false)),
        Op::Remove { key } if key_ok(&key) => {
            let changed = map.remove(&key).is_some();
            Ok((Value::Null, changed))
        }
        Op::Set { key, value } if key_ok(&key) => {
            if serde_json::to_vec(&value).map_or(usize::MAX, |v| v.len()) > MAX_VALUE {
                return Err("value-too-large");
            }
            if !map.contains_key(&key) && map.len() >= MAX_KEYS {
                return Err("too-many-keys");
            }
            let old = map.insert(key.clone(), value);
            if serde_json::to_vec(&*map).map_or(usize::MAX, |v| v.len()) > MAX_TOTAL {
                // Put back what was there: a refused write changes nothing.
                match old {
                    Some(v) => map.insert(key, v),
                    None => map.remove(&key),
                };
                return Err("storage-full");
            }
            Ok((Value::Null, true))
        }
        _ => Err("bad-key"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn op(v: Value) -> Op {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn basic() {
        let mut m = Map::new();
        assert_eq!(apply(&mut m, op(json!({"op":"set","key":"a","value":{"n":1}}))).unwrap(), (Value::Null, true));
        assert_eq!(apply(&mut m, op(json!({"op":"get","key":"a"}))).unwrap().0, json!({"n":1}));
        assert_eq!(apply(&mut m, op(json!({"op":"get","key":"b"}))).unwrap().0, Value::Null);
        assert_eq!(apply(&mut m, op(json!({"op":"keys"}))).unwrap().0, json!(["a"]));
        assert_eq!(apply(&mut m, op(json!({"op":"remove","key":"a"}))).unwrap(), (Value::Null, true));
        assert_eq!(apply(&mut m, op(json!({"op":"remove","key":"a"}))).unwrap(), (Value::Null, false));
        assert!(serde_json::from_value::<Op>(json!({"op":"drop"})).is_err());
        assert!(serde_json::from_value::<Op>(json!({"op":"get","key":"a","path":"../x"})).is_err());
    }

    #[test]
    fn limits() {
        let mut m = Map::new();
        assert_eq!(apply(&mut m, op(json!({"op":"set","key":"","value":1}))), Err("bad-key"));
        assert_eq!(apply(&mut m, op(json!({"op":"get","key":"a".repeat(MAX_KEY + 1)}))), Err("bad-key"));
        assert_eq!(apply(&mut m, op(json!({"op":"set","key":"a\u{0}","value":1}))), Err("bad-key"));
        assert_eq!(apply(&mut m, op(json!({"op":"set","key":"big","value":"x".repeat(MAX_VALUE)}))), Err("value-too-large"));
        for i in 0..MAX_KEYS {
            apply(&mut m, op(json!({"op":"set","key":format!("k{i}"),"value":1}))).unwrap();
        }
        assert_eq!(apply(&mut m, op(json!({"op":"set","key":"one-more","value":1}))), Err("too-many-keys"));
        // Overwriting an existing key is still allowed when full of keys.
        assert!(apply(&mut m, op(json!({"op":"set","key":"k0","value":2}))).is_ok());
        let mut m = Map::new();
        let chunk = "x".repeat(MAX_VALUE - 100);
        let mut refused = None;
        for i in 0..20 {
            if let Err(e) = apply(&mut m, op(json!({"op":"set","key":format!("k{i}"),"value":chunk}))) {
                refused = Some((i, e));
                break;
            }
        }
        let (i, e) = refused.expect("total cap");
        assert_eq!(e, "storage-full");
        assert!(!m.contains_key(&format!("k{i}")), "the refused key is not kept");
        assert!(serde_json::to_vec(&m).unwrap().len() <= MAX_TOTAL);
    }
}
