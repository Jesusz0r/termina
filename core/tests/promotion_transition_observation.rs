//! Failed observations after a rename are conflicts, never proof of absence.
mod common;

use common::{CoreProcess, TempFixture, expected_file_json, identity_json, wait_for_path};
use serde_json::json;
use std::ffi::OsStr;
use std::fs;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::symlink;
use std::time::Duration;

const DEADLINE: Duration = Duration::from_secs(5);

fn check_transition(kind: &str, replace_vacated: bool) {
    let fixture = TempFixture::new("transition-observation");
    let home = fixture.join("home");
    let source = fixture.join("source");
    let primary = fixture.join("primary");
    for dir in [&home, &source, &primary] {
        fs::create_dir(dir).unwrap();
    }
    let vacated = if kind == "install" {
        source.join("file")
    } else {
        primary.join("file")
    };
    let retained = ".termina-promotion-retained-test.tmp";
    let moved = if kind == "install" {
        primary.join("file")
    } else {
        primary.join(retained)
    };
    fs::write(&vacated, b"original").unwrap();
    let expected = expected_file_json(&vacated);
    let transition = if kind == "install" {
        json!({"kind": kind, "sourceRoot": source, "sourceRootIdentity": identity_json(&source),
            "sourceComponents": ["file"], "sourceParentIdentity": identity_json(&source),
            "expectedSource": expected, "expectedDestination": {"state": {"type": "missing"}}})
    } else {
        json!({"kind": kind, "retainedName": retained, "expectedDestination": expected})
    };
    let ready = fixture.join("ready");
    let release = fixture.join("release");
    let mut core = CoreProcess::spawn(&home, fixture.path());
    let request = core.send("promotion-bound-transition", json!({
        "primaryRoot": primary, "primaryRootIdentity": identity_json(&primary),
        "destinationComponents": ["file"], "parentIdentity": identity_json(&primary),
        "transition": transition,
        "testHook": {"stage": "promotion-syscall", "readyPath": ready, "releasePath": release},
    })).unwrap();
    wait_for_path(&ready, DEADLINE);
    let invalid_target = OsStr::from_bytes(b"invalid-\xff-target");
    if replace_vacated {
        symlink(invalid_target, &vacated).unwrap();
    }
    fs::write(&release, b"release").unwrap();
    let response = core.recv(&request, DEADLINE).unwrap();
    assert_eq!(response["ok"], true, "{response}");
    let result = &response["result"];
    assert_eq!(result["durable"], !replace_vacated, "{response}");
    assert_eq!(
        result["outcome"],
        if replace_vacated {
            "conflict-after-mutation"
        } else {
            "applied"
        }
    );
    assert_eq!(fs::read(&moved).unwrap(), b"original");
    if replace_vacated {
        assert!(result["error"].is_string());
        assert_eq!(fs::read_link(&vacated).unwrap().as_os_str(), invalid_target);
    } else {
        assert!(result["error"].is_null());
        assert!(!vacated.exists());
    }
    core.shutdown();
}

#[test]
fn install_requires_verified_source_absence() {
    check_transition("install", true);
    check_transition("install", false);
}

#[test]
fn retire_requires_verified_destination_absence() {
    check_transition("retire", true);
    check_transition("retire", false);
}
