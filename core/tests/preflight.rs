//! #249: preflight must fail closed on unreadable Git config / .gitattributes.
//! Missing files are verified absence; a present file that cannot be read
//! is unverifiable and must push a reason.

mod common;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde_json::{Value, json};

use common::{CoreProcess, TempFixture};

const DEADLINE: Duration = Duration::from_secs(10);

fn git_env(home: &Path, tmp: &Path) -> Vec<(String, String)> {
    vec![
        (
            "PATH".to_string(),
            "/usr/bin:/bin:/usr/sbin:/sbin".to_string(),
        ),
        ("HOME".to_string(), home.to_str().unwrap().to_string()),
        ("TMPDIR".to_string(), tmp.to_str().unwrap().to_string()),
        ("GIT_CONFIG_NOSYSTEM".to_string(), "1".to_string()),
        ("GIT_TERMINAL_PROMPT".to_string(), "0".to_string()),
        ("LANG".to_string(), "C".to_string()),
        ("LC_ALL".to_string(), "C".to_string()),
    ]
}

fn git(home: &Path, tmp: &Path, cwd: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(["-C"])
        .arg(cwd)
        .args(args)
        .envs(git_env(home, tmp))
        .status()
        .unwrap_or_else(|e| panic!("run git {:?}: {e}", args));
    assert!(status.success(), "git {:?} failed", args);
}

fn chmod_unreadable(path: &Path) {
    let mut permissions = fs::metadata(path)
        .unwrap_or_else(|e| panic!("stat {}: {e}", path.display()))
        .permissions();
    permissions.set_mode(0o000);
    fs::set_permissions(path, permissions)
        .unwrap_or_else(|e| panic!("chmod {}: {e}", path.display()));
}

struct PreflightHarness {
    _fixture: TempFixture,
    home: PathBuf,
    source: PathBuf,
    core: CoreProcess,
}

impl PreflightHarness {
    fn with_files(prefix: &str, files: &[(&str, &str)]) -> Self {
        let fixture = TempFixture::new(prefix);
        let home = fixture.join("home");
        fs::create_dir_all(&home).expect("create home");
        let source = fixture.join("source");
        fs::create_dir_all(&source).expect("create source");
        for (rel, content) in files {
            let path = source.join(rel);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("create source parent");
            }
            fs::write(&path, content).expect("write source file");
        }
        let env = git_env(&home, fixture.path());
        let status = Command::new("git")
            .args(["init", "--quiet"])
            .arg(&source)
            .envs(env.iter().cloned())
            .status()
            .expect("run git init");
        assert!(status.success(), "git init failed");
        git(&home, fixture.path(), &source, &["add", "--all"]);
        let core = CoreProcess::spawn(&home, fixture.path());
        Self {
            _fixture: fixture,
            home,
            source,
            core,
        }
    }

    fn run(&mut self) -> (bool, Vec<String>) {
        let response = self
            .core
            .request_ok(
                "preflight",
                json!({
                    "sourceRoot": self.source.to_str().unwrap(),
                    "sourceGitDir": self.source.join(".git").to_str().unwrap(),
                }),
                DEADLINE,
            )
            .expect("preflight");
        let result = response.get("result").expect("preflight result");
        let ok = result
            .get("ok")
            .and_then(Value::as_bool)
            .expect("preflight ok");
        let reasons = result
            .get("reasons")
            .and_then(Value::as_array)
            .expect("preflight reasons")
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();
        (ok, reasons)
    }

    fn shutdown(&mut self) {
        self.core.shutdown();
    }
}

#[test]
fn clean_repo_passes_preflight() {
    let mut harness = PreflightHarness::with_files("pf-clean", &[("keep.txt", "keep\n")]);
    let (ok, reasons) = harness.run();
    assert!(ok, "clean repo failed preflight: {reasons:?}");
    assert!(reasons.is_empty());
    harness.shutdown();
}

#[test]
fn transform_gitattributes_fails_preflight() {
    let mut harness = PreflightHarness::with_files(
        "pf-attr-transform",
        &[(".gitattributes", "* text=auto\n"), ("keep.txt", "keep\n")],
    );
    let (ok, reasons) = harness.run();
    assert!(!ok, "transform attributes must fail closed");
    assert!(
        reasons
            .iter()
            .any(|r| r.contains("content-transforming entries")),
        "missing transform reason: {reasons:?}"
    );
    harness.shutdown();
}

#[test]
fn missing_gitattributes_is_absence_not_unreadable() {
    let mut harness = PreflightHarness::with_files(
        "pf-attr-missing",
        &[
            (".gitattributes", "# no transforms\n"),
            ("keep.txt", "keep\n"),
        ],
    );
    fs::remove_file(harness.source.join(".gitattributes")).expect("delete attributes");
    let (ok, reasons) = harness.run();
    assert!(
        ok,
        "a tracked .gitattributes missing from the working tree is absence: {reasons:?}"
    );
    assert!(
        !reasons.iter().any(|r| r.contains("could not be read")),
        "missing attributes must not be treated as unreadable: {reasons:?}"
    );
    harness.shutdown();
}

#[test]
fn unreadable_gitattributes_fails_closed() {
    let mut harness = PreflightHarness::with_files(
        "pf-attr-unreadable",
        &[(".gitattributes", "* text=auto\n"), ("keep.txt", "keep\n")],
    );
    chmod_unreadable(&harness.source.join(".gitattributes"));
    let (ok, reasons) = harness.run();
    assert!(!ok, "unreadable attributes must fail closed: {reasons:?}");
    assert!(
        reasons
            .iter()
            .any(|r| r == "a .gitattributes file could not be read"),
        "missing unreadable-attributes reason: {reasons:?}"
    );
    harness.shutdown();
}

#[test]
fn gitattributes_replaced_with_directory_fails_closed() {
    let mut harness = PreflightHarness::with_files(
        "pf-attr-dir",
        &[(".gitattributes", "* text=auto\n"), ("keep.txt", "keep\n")],
    );
    fs::remove_file(harness.source.join(".gitattributes")).expect("remove attributes file");
    fs::create_dir_all(harness.source.join(".gitattributes")).expect("attributes as directory");
    let (ok, reasons) = harness.run();
    assert!(
        !ok,
        "directory .gitattributes must fail closed: {reasons:?}"
    );
    assert!(
        reasons
            .iter()
            .any(|r| r == "a .gitattributes file could not be read"),
        "missing unreadable-attributes reason: {reasons:?}"
    );
    harness.shutdown();
}

#[test]
fn unreadable_user_gitconfig_fails_closed() {
    let mut harness = PreflightHarness::with_files("pf-user-config", &[("keep.txt", "keep\n")]);
    let global = harness.home.join(".gitconfig");
    fs::write(
        &global,
        "[filter \"hidden\"]\n\tclean = true\n\tsmudge = true\n",
    )
    .expect("write user gitconfig");
    chmod_unreadable(&global);
    let (ok, reasons) = harness.run();
    assert!(
        !ok,
        "unreadable user gitconfig must fail closed: {reasons:?}"
    );
    assert!(
        reasons
            .iter()
            .any(|r| r == "Git config could not be enumerated"),
        "unreadable user gitconfig must not pass as setting-absent: {reasons:?}"
    );
    harness.shutdown();
}

#[test]
fn unreadable_git_config_fails_closed() {
    let mut harness =
        PreflightHarness::with_files("pf-config-unreadable", &[("keep.txt", "keep\n")]);
    // A config entry whose name is not valid UTF-8 cannot be classified as
    // "setting absent". Skipping it (the old fail-open) would hide a driver.
    let config_path = harness.source.join(".git").join("config");
    let mut bytes = fs::read(&config_path).expect("read git config");
    bytes.extend_from_slice(b"\n[diff \"");
    bytes.push(0xff);
    bytes.extend_from_slice(b"hidden\"]\n\tcommand = true\n");
    fs::write(&config_path, &bytes).expect("write git config");
    let (ok, reasons) = harness.run();
    assert!(!ok, "unverifiable Git config must fail closed: {reasons:?}");
    assert!(
        reasons
            .iter()
            .any(|r| r == "Git config could not be enumerated")
            || reasons.iter().any(|r| r.contains("diff driver")),
        "unverifiable config must not pass as setting-absent: {reasons:?}"
    );
    harness.shutdown();
}
