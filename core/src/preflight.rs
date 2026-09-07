//! Preflight: repository capability checks (drivers, transforms, filters)
//! that decide whether a working tree is safe to capture.
use std::fs;
use std::path::PathBuf;

use serde_json::{Value, json};

use crate::util::{open_repo, opt_s, s};

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

/// True when a non-LFS config key under `section` ends with `suffix`
/// (for example `diff.tool.command` or `merge.ours.driver`).
fn config_has_driver(config: &git2::Config, section: &str, suffix: &str) -> bool {
    let glob = format!("{section}.*");
    let Ok(mut entries) = config.entries(Some(&glob)) else {
        return false;
    };
    let needle = format!(".{suffix}");
    while let Some(entry) = entries.next() {
        let Ok(entry) = entry else { continue };
        let Ok(name) = entry.name() else { continue };
        if is_lfs_config_key(name) {
            continue;
        }
        if name.to_ascii_lowercase().ends_with(&needle) {
            return true;
        }
    }
    false
}

/// True when any non-LFS `filter.*` key exists (a real clean/smudge filter).
fn config_has_non_lfs_filter(config: &git2::Config) -> bool {
    let Ok(mut entries) = config.entries(Some("filter.*")) else {
        return false;
    };
    while let Some(entry) = entries.next() {
        let Ok(entry) = entry else { continue };
        let Ok(name) = entry.name() else { continue };
        if !is_lfs_config_key(name) {
            return true;
        }
    }
    false
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
    let config = repo.config().map_err(|e| e.to_string())?;
    // Sparse checkout and partial clones.
    if let Ok(value) = config.get_string("core.sparseCheckout")
        && value.trim() != "false"
    {
        reasons.push("a sparse checkout is active".to_string());
    }
    if config.get_string("extensions.partialClone").is_ok() {
        reasons.push("a partial clone is active".to_string());
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
    // Content-transforming settings that break byte-exact materialization.
    if let Ok(value) = config.get_string("core.autocrlf")
        && value.trim() != "false"
    {
        reasons.push("core.autocrlf is not false".to_string());
    }
    if let Ok(value) = config.get_string("core.eol")
        && value.trim() != "native"
    {
        reasons.push("core.eol is configured".to_string());
    }
    if config_has_non_lfs_filter(&config) {
        reasons.push("a Git clean/smudge filter is configured".to_string());
    }
    if config_has_driver(&config, "diff", "command")
        || config_has_driver(&config, "diff", "textconv")
    {
        reasons.push("a custom diff driver is configured".to_string());
    }
    if config_has_driver(&config, "merge", "driver") {
        reasons.push("a custom merge driver is configured".to_string());
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
            Err(_) => continue, // unreadable attributes file — leave as-is
        };
        if has_transform_attr(&content) {
            reasons.push("a .gitattributes file contains content-transforming entries".to_string());
            break;
        }
    }
    Ok(json!({ "result": { "ok": reasons.is_empty(), "reasons": reasons } }))
}
