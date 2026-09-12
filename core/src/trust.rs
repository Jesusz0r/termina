//! Agent-trust hashes: bounded walks over agent config files.
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::util::{opt_s, s};

/// The trust-hash walk stops after this many files.
const TRUST_MAX_FILES: usize = 10_000;
/// The trust-hash walk stops after this many bytes.
const TRUST_MAX_BYTES: u64 = 64 * 1024 * 1024;
/// Trust files larger than this are skipped.
const TRUST_MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

pub(crate) fn op_trust_hashes(req: &Value) -> Result<Value, String> {
    let agent_dir = PathBuf::from(s(req, "agentDir")?);
    let project_root = opt_s(req, "projectRoot").map(PathBuf::from);
    let mut out = serde_json::Map::new();
    let mut files = 0usize;
    let mut bytes = 0u64;

    for name in [
        "settings.json",
        "models.json",
        "models-store.json",
        "prompts",
        "skills",
        "themes",
        "extensions",
    ] {
        let full = agent_dir.join(name);
        let metadata = match fs::symlink_metadata(&full) {
            Ok(metadata) => metadata,
            Err(_) => continue, // absent
        };
        if metadata.file_type().is_dir() {
            walk_hashes(
                &full,
                &format!("agent/{name}"),
                &mut out,
                &mut files,
                &mut bytes,
            );
        } else if metadata.file_type().is_file()
            && let Some((key, hash)) =
                hash_file(&full, &format!("agent/{name}"), &mut files, &mut bytes)
        {
            out.insert(key, Value::String(hash));
        }
    }
    if let Some(root) = project_root {
        for rel in [".agents/skills"] {
            walk_hashes(
                &root.join(rel),
                &format!("project/{rel}"),
                &mut out,
                &mut files,
                &mut bytes,
            );
        }
    }
    Ok(json!({ "state": Value::Object(out) }))
}

fn walk_hashes(
    abs_root: &Path,
    prefix: &str,
    out: &mut serde_json::Map<String, Value>,
    files: &mut usize,
    bytes: &mut u64,
) {
    let entries = match fs::read_dir(abs_root) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if *files >= TRUST_MAX_FILES || *bytes >= TRUST_MAX_BYTES {
            return;
        }
        let Some(name) = entry.file_name().to_str().map(String::from) else {
            continue; // a non-UTF-8 name cannot key the map
        };
        let full = entry.path();
        let metadata = match fs::symlink_metadata(&full) {
            Ok(metadata) => metadata,
            Err(_) => continue, // a transient file — skip
        };
        let key = format!("{prefix}/{name}");
        if metadata.file_type().is_dir() {
            walk_hashes(&full, &key, out, files, bytes);
        } else if metadata.file_type().is_file()
            && let Some((key, hash)) = hash_file(&full, &key, files, bytes)
        {
            out.insert(key, Value::String(hash));
        }
    }
}

fn hash_file(
    path: &Path,
    key: &str,
    files: &mut usize,
    bytes: &mut u64,
) -> Option<(String, String)> {
    let metadata = fs::metadata(path).ok()?;
    if metadata.len() > TRUST_MAX_FILE_BYTES {
        return None;
    }
    let content = fs::read(path).ok()?;
    *files += 1;
    *bytes += content.len() as u64;
    let digest = Sha256::digest(&content);
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    Some((key.to_string(), hex))
}
