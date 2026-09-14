//! Preflight: repository capability checks (drivers, transforms, filters)
//! that decide whether a working tree is safe to capture.
use std::fs;
use std::path::PathBuf;

use serde_json::{Value, json};

use crate::util::{missing_path, open_repo, opt_s, s};

const REASON_ATTR_UNREADABLE: &str = "a .gitattributes file could not be read";
const REASON_CONFIG_UNREADABLE: &str = "Git config could not be enumerated";

/// Probe of a Git config setting: present, verified-absent, or unverifiable.
enum ConfigProbe {
    Present,
    Absent,
    Unreadable,
}

/// True when the attributes text contains a content-transforming pattern.
/// Git LFS `filter=lfs` is not a transform here: capture hashes working-tree
/// bytes, so pointer files and smudged files both round-trip.
fn has_transform_attr(text: &str) -> bool {
    const WORDS: [&str; 6] = [
        "filter",
        "eol",
        "working-tree-encoding",
        "ident",
        "text",
        "export-subst",
    ];
    for line in text.lines() {
        for token in line.split_whitespace() {
            let lower = token.to_ascii_lowercase();
            if lower == "filter=lfs" || lower.starts_with("filter=lfs,") || lower == "-filter=lfs" {
                continue;
            }
            if WORDS
                .iter()
                .any(|word| token == *word || token.starts_with(&format!("{word}=")))
            {
                return true;
            }
        }
    }
    false
}

/// True when `name` is a Git LFS config key (`filter.lfs.*`, `diff.lfs.*`).
fn is_lfs_config_key(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.contains(".lfs.") || lower.ends_with(".lfs")
}

fn push_unique(reasons: &mut Vec<String>, reason: &str) {
    if !reasons.iter().any(|existing| existing == reason) {
        reasons.push(reason.to_string());
    }
}

fn config_string(config: &git2::Config, name: &str) -> Result<Option<String>, ()> {
    match config.get_string(name) {
        Ok(value) => Ok(Some(value)),
        Err(err) if err.code() == git2::ErrorCode::NotFound => Ok(None),
        Err(_) => Err(()),
    }
}

/// True when a non-LFS config key under `section` ends with `suffix`
/// (for example `diff.tool.command` or `merge.ours.driver`).
fn config_has_driver(config: &git2::Config, section: &str, suffix: &str) -> ConfigProbe {
    let glob = format!("{section}.*");
    let Ok(mut entries) = config.entries(Some(&glob)) else {
        return ConfigProbe::Unreadable;
    };
    let needle = format!(".{suffix}");
    while let Some(entry) = entries.next() {
        let Ok(entry) = entry else {
            return ConfigProbe::Unreadable;
        };
        let Ok(name) = entry.name() else {
            return ConfigProbe::Unreadable;
        };
        if is_lfs_config_key(name) {
            continue;
        }
        if name.to_ascii_lowercase().ends_with(&needle) {
            return ConfigProbe::Present;
        }
    }
    ConfigProbe::Absent
}

/// True when any non-LFS `filter.*` key exists (a real clean/smudge filter).
fn config_has_non_lfs_filter(config: &git2::Config) -> ConfigProbe {
    let Ok(mut entries) = config.entries(Some("filter.*")) else {
        return ConfigProbe::Unreadable;
    };
    while let Some(entry) = entries.next() {
        let Ok(entry) = entry else {
            return ConfigProbe::Unreadable;
        };
        let Ok(name) = entry.name() else {
            return ConfigProbe::Unreadable;
        };
        if !is_lfs_config_key(name) {
            return ConfigProbe::Present;
        }
    }
    ConfigProbe::Absent
}

fn record_config_probe(reasons: &mut Vec<String>, probe: ConfigProbe, present_reason: &str) {
    match probe {
        ConfigProbe::Present => reasons.push(present_reason.to_string()),
        ConfigProbe::Absent => {}
        ConfigProbe::Unreadable => push_unique(reasons, REASON_CONFIG_UNREADABLE),
    }
}

pub(crate) fn op_preflight(req: &Value) -> Result<Value, String> {
    let source_root = PathBuf::from(s(req, "sourceRoot")?);
    let source_git_dir = PathBuf::from(s(req, "sourceGitDir")?);
    let worlds_root = opt_s(req, "worldsRoot").map(PathBuf::from);
    let mut reasons: Vec<String> = Vec::new();

    let repo = match open_repo(&source_root) {
        Ok(repo) => repo,
        Err(_) => {
            reasons.push("the opened folder is not inside a Git repository".to_string());
            return Ok(json!({ "result": { "ok": false, "reasons": reasons } }));
        }
    };
    let cwd_canon = fs::canonicalize(&source_root).unwrap_or_else(|_| source_root.clone());
    if repo.workdir().is_none() {
        reasons.push("the opened folder is not inside a Git repository".to_string());
    }
    if let Some(worlds) = &worlds_root {
        // Compare canonical forms: macOS reports /tmp and /private/tmp for
        // the same directory.
        let worlds_canon = fs::canonicalize(worlds).unwrap_or_else(|_| worlds.clone());
        if cwd_canon == worlds_canon || cwd_canon.starts_with(&worlds_canon) {
            reasons.push("the opened folder is inside the app-owned worlds root".to_string());
        }
    }

    // Active merge/rebase/cherry-pick/revert state.
    for (marker, label) in [
        ("MERGE_HEAD", "merge-head"),
        ("CHERRY_PICK_HEAD", "cherry-pick-head"),
        ("REVERT_HEAD", "revert-head"),
        ("BISECT_LOG", "bisect-log"),
    ] {
        if source_git_dir.join(marker).exists() {
            reasons.push(format!("the repository has an active {label} operation"));
        }
    }
    if source_git_dir.join("rebase-merge").exists() || source_git_dir.join("rebase-apply").exists()
    {
        reasons.push("the repository has an active rebase".to_string());
    }

    let index = repo.index().map_err(|e| e.to_string())?;
    // Unresolved index entries (unmerged paths).
    if index.has_conflicts() {
        reasons.push("the repository has unresolved index entries".to_string());
    }
    // Submodules and gitlinks in the index.
    if index.iter().any(|entry| entry.mode == 0o160000) {
        reasons.push("the project contains a submodule".to_string());
    }
    let config = match repo.config() {
        Ok(config) => Some(config),
        Err(_) => {
            push_unique(&mut reasons, REASON_CONFIG_UNREADABLE);
            None
        }
    };
    if let Some(config) = &config {
        // Sparse checkout and partial clones.
        match config_string(config, "core.sparseCheckout") {
            Ok(Some(value)) if value.trim() != "false" => {
                reasons.push("a sparse checkout is active".to_string());
            }
            Ok(_) => {}
            Err(()) => push_unique(&mut reasons, REASON_CONFIG_UNREADABLE),
        }
        match config_string(config, "extensions.partialClone") {
            Ok(Some(_)) => reasons.push("a partial clone is active".to_string()),
            Ok(None) => {}
            Err(()) => push_unique(&mut reasons, REASON_CONFIG_UNREADABLE),
        }
    }
    // A source object alternate in the user's repository.
    if source_git_dir
        .join("objects")
        .join("info")
        .join("alternates")
        .exists()
    {
        reasons.push("a source object alternate is active".to_string());
    }
    if let Some(config) = &config {
        // Content-transforming settings that break byte-exact materialization.
        match config_string(config, "core.autocrlf") {
            Ok(Some(value)) if value.trim() != "false" => {
                reasons.push("core.autocrlf is not false".to_string());
            }
            Ok(_) => {}
            Err(()) => push_unique(&mut reasons, REASON_CONFIG_UNREADABLE),
        }
        match config_string(config, "core.eol") {
            Ok(Some(value)) if value.trim() != "native" => {
                reasons.push("core.eol is configured".to_string());
            }
            Ok(_) => {}
            Err(()) => push_unique(&mut reasons, REASON_CONFIG_UNREADABLE),
        }
        record_config_probe(
            &mut reasons,
            config_has_non_lfs_filter(config),
            "a Git clean/smudge filter is configured",
        );
        record_config_probe(
            &mut reasons,
            match (
                config_has_driver(config, "diff", "command"),
                config_has_driver(config, "diff", "textconv"),
            ) {
                (ConfigProbe::Present, _) | (_, ConfigProbe::Present) => ConfigProbe::Present,
                (ConfigProbe::Unreadable, _) | (_, ConfigProbe::Unreadable) => {
                    ConfigProbe::Unreadable
                }
                (ConfigProbe::Absent, ConfigProbe::Absent) => ConfigProbe::Absent,
            },
            "a custom diff driver is configured",
        );
        record_config_probe(
            &mut reasons,
            config_has_driver(config, "merge", "driver"),
            "a custom merge driver is configured",
        );
    }

    // Transform-bearing attributes in any tracked .gitattributes file.
    let attr_files: Vec<String> = index
        .iter()
        .filter_map(|entry| {
            let path = String::from_utf8_lossy(&entry.path).into_owned();
            if path.rsplit('/').next() == Some(".gitattributes") {
                Some(path)
            } else {
                None
            }
        })
        .collect();
    for attr in attr_files {
        let attr_root = repo.workdir().unwrap_or(source_root.as_path());
        let content = match fs::read_to_string(attr_root.join(&attr)) {
            Ok(content) => content,
            // Missing is verified absence: the working tree has no attributes
            // to apply. A present file that cannot be read is unverifiable.
            Err(err) if missing_path(&err) => continue,
            Err(_) => {
                push_unique(&mut reasons, REASON_ATTR_UNREADABLE);
                continue;
            }
        };
        if has_transform_attr(&content) {
            reasons.push("a .gitattributes file contains content-transforming entries".to_string());
            break;
        }
    }
    Ok(json!({ "result": { "ok": reasons.is_empty(), "reasons": reasons } }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    fn open_file_config(bytes: &[u8]) -> git2::Config {
        let path = std::env::temp_dir().join(format!(
            "termina-preflight-config-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::write(&path, bytes).expect("write probe config");
        git2::Config::open(&path).unwrap_or_else(|e| panic!("open probe config: {e}"))
    }

    #[test]
    fn driver_probe_absent_vs_present() {
        let absent = open_file_config(b"[core]\n\tbare = false\n");
        assert!(matches!(
            config_has_driver(&absent, "diff", "command"),
            ConfigProbe::Absent
        ));
        let present = open_file_config(b"[diff \"tool\"]\n\tcommand = true\n");
        assert!(matches!(
            config_has_driver(&present, "diff", "command"),
            ConfigProbe::Present
        ));
        let lfs = open_file_config(b"[diff \"lfs\"]\n\tcommand = true\n");
        assert!(matches!(
            config_has_driver(&lfs, "diff", "command"),
            ConfigProbe::Absent
        ));
    }

    #[test]
    fn driver_probe_invalid_utf8_name_is_unreadable() {
        let mut bytes = b"[diff \"".to_vec();
        bytes.push(0xff);
        bytes.extend_from_slice(b"hidden\"]\n\tcommand = true\n");
        let config = open_file_config(&bytes);
        assert!(
            matches!(
                config_has_driver(&config, "diff", "command"),
                ConfigProbe::Unreadable
            ),
            "invalid UTF-8 config names must not classify as verified absence"
        );
    }

    #[test]
    fn filter_probe_invalid_utf8_name_is_unreadable() {
        let mut bytes = b"[filter \"".to_vec();
        bytes.push(0xff);
        bytes.extend_from_slice(b"hidden\"]\n\tclean = true\n");
        let config = open_file_config(&bytes);
        assert!(matches!(
            config_has_non_lfs_filter(&config),
            ConfigProbe::Unreadable
        ));
    }
}
