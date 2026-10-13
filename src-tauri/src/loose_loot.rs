//! Loose loot categories: what each loose loot spawn may hold, as handbook categories two levels deep
//! (e.g. Barter items › Valuables), so its markers can be filtered by them.
//!
//! The item → category table is built from the item data when it is stored; each spawn's categories are
//! pooled from its possible items when a map is read, so a changed spawn list needs no rebuild.

use serde_json::{json, Map, Value};

/// Sub-category for posters, which the handbook files under Barter items › Others with little else.
const POSTERS: &str = "posters";

/// `{ categories, items }` from the shared item table and its lookup tables, or None without handbook
/// categories (the extra piece is off):
/// - `categories`: key → `{ label, icon, parent? }`; a top-level category has no parent
/// - `items`: item id → its sub-category key, or its top-level key when it has none
pub fn build(items: &Map<String, Value>, tables: &Value) -> Option<Value> {
    let handbook = tables.get("handbookCategories")?.as_object()?;
    let field = |id: &str, key: &str| handbook.get(id).and_then(|category| category.get(key)).and_then(Value::as_str);
    let mut categories = Map::new();
    let mut by_item = Map::new();
    for (id, item) in items {
        // Listed from the item's own category up to the top level.
        let Some(own) = item.get("handbookCategories").and_then(Value::as_array).and_then(|ids| ids.first()).and_then(Value::as_str)
        else {
            continue;
        };
        let mut path = vec![own];
        while let Some(parent) = field(path[0], "parent").filter(|parent| handbook.contains_key(*parent) && !path.contains(parent)) {
            path.insert(0, parent);
        }
        let (Some(root), Some(root_key)) = (field(path[0], "name"), field(path[0], "normalizedName")) else {
            continue;
        };
        if !categories.contains_key(root_key) {
            categories.insert(root_key.into(), json!({ "label": root, "icon": field(path[0], "imageLink") }));
        }
        let poster = item.get("types").and_then(Value::as_array).is_some_and(|types| types.iter().any(|kind| kind == "poster"));
        let key = if poster {
            if !categories.contains_key(POSTERS) {
                categories.insert(POSTERS.into(), json!({ "label": "Posters", "icon": format!("item:{id}"), "parent": root_key }));
            }
            POSTERS
        } else if let Some(sub) = path.get(1).copied() {
            let (Some(label), Some(key)) = (field(sub, "name"), field(sub, "normalizedName")) else {
                continue;
            };
            if !categories.contains_key(key) {
                categories.insert(key.into(), json!({ "label": label, "icon": field(sub, "imageLink"), "parent": root_key }));
            }
            key
        } else {
            root_key
        };
        by_item.insert(id.clone(), key.into());
    }
    (!by_item.is_empty()).then(|| json!({ "categories": categories, "items": by_item }))
}

/// Gives each `lootLoose` entry the `categories` its possible items fall in, and the map a `looseCategories`
/// table of those categories and their parents. Items without a category are left out.
pub fn attach(map: &mut Value, table: &Value) {
    let (Some(categories), Some(items)) = (table["categories"].as_object(), table["items"].as_object()) else {
        return;
    };
    let mut used = Map::new();
    let Some(spawns) = map.get_mut("lootLoose").and_then(Value::as_array_mut) else {
        return;
    };
    for spawn in spawns {
        let mut keys: Vec<&str> = Vec::new();
        for id in spawn["items"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            if let Some(key) = items.get(id).and_then(Value::as_str) {
                if !keys.contains(&key) {
                    keys.push(key);
                }
            }
        }
        for key in &keys {
            let mut next = Some(*key);
            while let Some(key) = next.filter(|key| !used.contains_key(*key)) {
                let Some(category) = categories.get(key) else { break };
                used.insert(key.into(), category.clone());
                next = category["parent"].as_str();
            }
        }
        if let Some(fields) = spawn.as_object_mut() {
            fields.insert("categories".into(), json!(keys));
        }
    }
    map["looseCategories"] = Value::Object(used);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn handbook() -> Value {
        json!({ "handbookCategories": {
            "b": { "name": "Barter items", "normalizedName": "barter-items", "imageLink": "https://assets.tarkov.dev/b.webp" },
            "v": { "name": "Valuables", "normalizedName": "valuables", "parent": "b", "imageLink": "https://assets.tarkov.dev/v.webp" },
            "o": { "name": "Others", "normalizedName": "others", "parent": "b" },
            "i": { "name": "Info items", "normalizedName": "info-items" },
            "n": { "name": "Notes", "normalizedName": "notes", "parent": "i" },
            "x": { "name": "Deep", "normalizedName": "deep", "parent": "n" },
        } })
    }

    #[test]
    fn items_fall_in_two_levels_and_posters_split_out() {
        let items = json!({
            "gold": { "handbookCategories": ["v", "b"], "types": [] },
            "poster": { "handbookCategories": ["o", "b"], "types": ["poster", "barter"] },
            "ssd": { "handbookCategories": ["i"] },
            "diary": { "handbookCategories": ["x", "n", "i"] },
            "bare": { "types": [] },
        });
        let table = build(items.as_object().unwrap(), &handbook()).unwrap();
        assert_eq!(table["items"], json!({ "gold": "valuables", "poster": "posters", "ssd": "info-items", "diary": "notes" }));
        assert_eq!(table["categories"]["valuables"], json!({ "label": "Valuables", "icon": "https://assets.tarkov.dev/v.webp", "parent": "barter-items" }));
        assert_eq!(table["categories"]["posters"], json!({ "label": "Posters", "icon": "item:poster", "parent": "barter-items" }));
        assert_eq!(table["categories"]["info-items"]["parent"], Value::Null);
        assert!(build(items.as_object().unwrap(), &json!({})).is_none(), "no handbook, no table");
    }

    #[test]
    fn spawns_pool_their_items_categories() {
        let items = json!({ "gold": { "handbookCategories": ["v"] }, "poster": { "handbookCategories": ["o"], "types": ["poster"] },
            "ssd": { "handbookCategories": ["i"] } });
        let table = build(items.as_object().unwrap(), &handbook()).unwrap();
        let mut map = json!({ "lootLoose": [
            { "items": ["gold", "poster", "gold", "unknown"] }, { "items": ["unknown"] },
        ] });
        attach(&mut map, &table);
        assert_eq!(map["lootLoose"][0]["categories"], json!(["valuables", "posters"]));
        assert_eq!(map["lootLoose"][1]["categories"], json!([]));
        let used: Vec<_> = map["looseCategories"].as_object().unwrap().keys().cloned().collect();
        assert_eq!(used, ["barter-items", "posters", "valuables"], "used categories and their parents only");
    }
}
