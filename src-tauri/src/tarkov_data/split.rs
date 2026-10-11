//! Pure transform of the tarkov.dev `maps` response into small per-map documents.

use serde_json::{Map, Value};

pub struct Split {
    /// Shared lookups: `lootContainers`, `stationaryWeapons`, `goonReports`.
    pub common: Value,
    /// Boss and follower definitions; large, so kept apart from `common`.
    pub mobs: Value,
    /// One document per map, keyed by `normalizedName`.
    pub maps: Vec<(String, Value)>,
}

/// Replaces translation keys with display strings at the JSON paths the response lists in `translations`.
/// Paths use `$`, `.field`, `.*` (every object value) and `[*]` (every array element).
pub fn translate(response: &mut Value, names: &Map<String, Value>) {
    let paths: Vec<String> = response
        .get("translations")
        .and_then(Value::as_array)
        .map(|paths| {
            paths
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    for path in paths {
        let steps = parse_path(&path);
        apply(response, &steps, names);
    }
}

#[derive(Debug, PartialEq)]
enum Step {
    Field(String),
    Values,
    Elements,
}

fn parse_path(path: &str) -> Vec<Step> {
    let mut steps = Vec::new();
    for part in path
        .trim_start_matches('$')
        .split('.')
        .filter(|part| !part.is_empty())
    {
        let (field, elements) = match part.strip_suffix("[*]") {
            Some(field) => (field, true),
            None => (part, false),
        };
        steps.push(if field == "*" {
            Step::Values
        } else {
            Step::Field(field.to_owned())
        });
        if elements {
            steps.push(Step::Elements);
        }
    }
    steps
}

fn apply(value: &mut Value, steps: &[Step], names: &Map<String, Value>) {
    let Some((step, rest)) = steps.split_first() else {
        if let Some(name) = value
            .as_str()
            .and_then(|key| names.get(key))
            .filter(|name| name.is_string())
        {
            *value = name.clone();
        }
        return;
    };
    match (step, value) {
        (Step::Field(field), Value::Object(object)) => {
            if let Some(child) = object.get_mut(field) {
                apply(child, rest, names);
            }
        }
        (Step::Values, Value::Object(object)) => object
            .values_mut()
            .for_each(|child| apply(child, rest, names)),
        (Step::Elements, Value::Array(array)) => {
            array.iter_mut().for_each(|child| apply(child, rest, names))
        }
        _ => {}
    }
}

/// Splits a translated response. Maps without a `normalizedName` are skipped.
pub fn split(mut response: Value) -> Result<Split, String> {
    let data = response
        .get_mut("data")
        .and_then(Value::as_object_mut)
        .ok_or("Response has no data object.")?;
    let maps = match data.remove("maps") {
        Some(Value::Object(maps)) => maps,
        _ => return Err("Response has no maps.".into()),
    };
    let mobs = data.remove("mobs").unwrap_or(Value::Object(Map::new()));
    let mut common = Map::new();
    for key in ["lootContainers", "stationaryWeapons", "goonReports"] {
        common.insert(key.into(), data.remove(key).unwrap_or(Value::Null));
    }
    let mut documents: Vec<(String, Value)> = maps
        .into_iter()
        .filter_map(|(_, map)| {
            let name = map.get("normalizedName")?.as_str()?.to_owned();
            safe_name(&name).then_some((name, map))
        })
        .collect();
    documents.sort_by(|a, b| a.0.cmp(&b.0));
    if documents.is_empty() {
        return Err("Response has no usable maps.".into());
    }
    Ok(Split {
        common: Value::Object(common),
        mobs,
        maps: documents,
    })
}

/// Map names become file names; only allow tarkov.dev's slug alphabet.
pub fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

/// What another game mode changes relative to the baseline split.
/// Fields are replaced whole: boss and spawn lists have no ids to match entries on.
#[derive(Debug, Default, PartialEq)]
pub struct ModeDiff {
    /// Per map, the top-level fields whose values differ (or that the baseline lacks).
    /// A map the baseline does not have carries all of its fields.
    pub maps: Vec<(String, Map<String, Value>)>,
    /// Differing `common` fields.
    pub common: Map<String, Value>,
    /// The mode's mobs, when they differ.
    pub mobs: Option<Value>,
}

fn changed_fields(baseline: Option<&Value>, other: &Value) -> Map<String, Value> {
    let Some(other) = other.as_object() else {
        return Map::new();
    };
    other
        .iter()
        .filter(|(key, value)| baseline.and_then(|base| base.get(key.as_str())) != Some(value))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

pub fn diff(baseline: &Split, other: Split) -> ModeDiff {
    let maps = other
        .maps
        .into_iter()
        .filter_map(|(name, map)| {
            let base = baseline
                .maps
                .iter()
                .find(|(base, _)| *base == name)
                .map(|(_, map)| map);
            let fields = changed_fields(base, &map);
            (!fields.is_empty()).then_some((name, fields))
        })
        .collect();
    ModeDiff {
        maps,
        common: changed_fields(Some(&baseline.common), &other.common),
        mobs: (other.mobs != baseline.mobs).then_some(other.mobs),
    }
}

/// Baseline document with a mode's changed fields laid over it.
pub fn overlay(mut baseline: Value, fields: Map<String, Value>) -> Value {
    if let Some(object) = baseline.as_object_mut() {
        object.extend(fields);
        baseline
    } else {
        Value::Object(fields)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mode_diff_keeps_only_changed_fields_and_overlays_back() {
        let baseline = split(json!({ "data": {
            "maps": {
                "a": { "normalizedName": "customs", "bosses": [1], "lootContainers": [9], "extracts": [{ "id": "x", "faction": "pmc" }] },
                "b": { "normalizedName": "woods", "bosses": [] }
            },
            "mobs": { "boss": 1 }, "lootContainers": { "c": 1 }, "goonReports": [1]
        } })).unwrap();
        let other = split(json!({ "data": {
            "maps": {
                "a": { "normalizedName": "customs", "bosses": [2], "lootContainers": [9], "extracts": [{ "id": "x", "faction": "scav" }] },
                "b": { "normalizedName": "woods", "bosses": [] },
                "c": { "normalizedName": "arena", "bosses": [] }
            },
            "mobs": { "boss": 1 }, "lootContainers": { "c": 1 }, "goonReports": [2]
        } })).unwrap();
        let diff = diff(&baseline, other);
        let names: Vec<_> = diff
            .maps
            .iter()
            .map(|(name, fields)| (name.as_str(), fields.keys().cloned().collect::<Vec<_>>()))
            .collect();
        assert_eq!(
            names,
            vec![
                (
                    "arena",
                    vec!["bosses".to_string(), "normalizedName".to_string()]
                ),
                (
                    "customs",
                    vec!["bosses".to_string(), "extracts".to_string()]
                ),
            ]
        );
        assert_eq!(diff.common.keys().collect::<Vec<_>>(), vec!["goonReports"]);
        assert_eq!(diff.mobs, None);

        let customs = baseline
            .maps
            .iter()
            .find(|(name, _)| name == "customs")
            .unwrap()
            .1
            .clone();
        let merged = overlay(customs, diff.maps[1].1.clone());
        assert_eq!(merged["bosses"], json!([2]));
        assert_eq!(merged["extracts"][0]["faction"], "scav");
        assert_eq!(merged["lootContainers"], json!([9]));
    }

    fn sample() -> Value {
        json!({
            "data": {
                "maps": {
                    "id1": { "id": "id1", "name": "id1 Name", "normalizedName": "customs", "nameId": "bigmap",
                        "scenePath": "maps/customs_preset.bundle",
                        "extracts": [{ "name": "ZB-1011" }, { "name": "untranslated" }] },
                    "id2": { "id": "id2", "name": "id2 Name", "normalizedName": "../escape" }
                },
                "mobs": { "bossBully": { "name": "bossBully" } },
                "lootContainers": { "c1": { "name": "c1 Name", "normalizedName": "safe" } },
                "stationaryWeapons": {},
                "goonReports": []
            },
            "translations": ["$.data.maps.*.name", "$.data.maps.*.extracts[*].name", "$.data.mobs.*.name",
                "$.data.lootContainers.*.name"]
        })
    }

    #[test]
    fn translates_listed_paths_only() {
        let names = json!({ "id1 Name": "Customs", "ZB-1011": "ZB-1011 bunker", "bossBully": "Reshala",
            "c1 Name": "Safe", "bigmap": "should not apply" });
        let mut response = sample();
        translate(&mut response, names.as_object().unwrap());
        let map = &response["data"]["maps"]["id1"];
        assert_eq!(map["name"], "Customs");
        assert_eq!(map["nameId"], "bigmap");
        assert_eq!(map["extracts"][0]["name"], "ZB-1011 bunker");
        assert_eq!(map["extracts"][1]["name"], "untranslated");
        assert_eq!(response["data"]["mobs"]["bossBully"]["name"], "Reshala");
        assert_eq!(response["data"]["lootContainers"]["c1"]["name"], "Safe");
    }

    #[test]
    fn splits_into_common_mobs_and_safe_map_documents() {
        let split = split(sample()).unwrap();
        assert_eq!(split.maps.len(), 1);
        assert_eq!(split.maps[0].0, "customs");
        assert_eq!(split.maps[0].1["nameId"], "bigmap");
        assert!(split.mobs.get("bossBully").is_some());
        assert!(split.common.get("lootContainers").is_some());
        assert!(split.common.get("maps").is_none());
        assert!(super::split(json!({ "data": {} })).is_err());
    }

    #[test]
    fn path_parsing() {
        assert_eq!(
            parse_path("$.data.maps.*.extracts[*].name"),
            vec![
                Step::Field("data".into()),
                Step::Field("maps".into()),
                Step::Values,
                Step::Field("extracts".into()),
                Step::Elements,
                Step::Field("name".into())
            ]
        );
    }
}
