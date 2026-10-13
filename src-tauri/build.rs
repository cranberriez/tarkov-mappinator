use std::{env, fs, path::Path};

/// tarkov.dev hosts shared with the frontend map library (`src/maps/hosts.json`), exposed as
/// `TARKOV_DATA_HOST`, `TARKOV_ASSET_HOST` and `TARKOV_TILE_HOST` for `env!`.
fn hosts() {
    let path = Path::new(&env::var("CARGO_MANIFEST_DIR").unwrap()).join("../src/maps/hosts.json");
    println!("cargo:rerun-if-changed={}", path.display());
    let text = fs::read_to_string(&path).expect("read src/maps/hosts.json");
    let hosts: serde_json::Value = serde_json::from_str(&text).expect("parse src/maps/hosts.json");
    for (key, name) in [
        ("data", "TARKOV_DATA_HOST"),
        ("assets", "TARKOV_ASSET_HOST"),
        ("tiles", "TARKOV_TILE_HOST"),
    ] {
        let value = hosts[key]
            .as_str()
            .unwrap_or_else(|| panic!("hosts.json has no \"{key}\""));
        println!("cargo:rustc-env={name}={value}");
    }
}

fn main() {
    hosts();
    tauri_build::build()
}
