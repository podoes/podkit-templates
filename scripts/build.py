#!/usr/bin/env python3
"""Checks every template and builds the catalog.

  scripts/build.py --check          only check; exit 1 on the first list of problems
  scripts/build.py [--out dist]     check, then write the catalog and the website

The catalog is `index.json` plus `templates/<id>/<file>`, all static, served by GitHub Pages.
podkit downloads `index.json` when an admin presses refresh, and a template's files when
someone opens it. docs/catalog.md describes the format.
"""
import argparse
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tomllib

ROOT = pathlib.Path(__file__).resolve().parent.parent
# The index format podkit reads. Raise it only for a change an older podkit cannot ignore.
FORMAT = 1
STATUSES = ("ok", "broken", "unmaintained")
CATEGORIES = (
    "ai", "analytics", "automation", "backup", "cms", "communication", "database", "development",
    "finance", "games", "media", "monitoring", "networking", "other", "productivity", "security",
    "storage", "tools",
)
REQUIRED = ("id", "name", "description", "category", "tags", "version", "logo", "website", "docs", "source")
# What a person reads. Changing these does not make a deployed copy out of date.
PRESENTATION = REQUIRED + ("upstream", "status", "status_note", "maintainers")
MAX_PNG = 64 * 1024


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def load(folder):
    """One template as its index entry, or the list of what is wrong with it."""
    problems = []
    manifest = folder / "template.toml"
    compose = folder / "docker-compose.yml"
    if not manifest.is_file() or not compose.is_file():
        return None, ["needs template.toml and docker-compose.yml"]
    try:
        t = tomllib.loads(manifest.read_text())
    except tomllib.TOMLDecodeError as e:
        return None, [f"template.toml: {e}"]

    for key in REQUIRED:
        if key not in t:
            problems.append(f"template.toml: `{key}` is missing")
    if problems:
        return None, problems
    if t["id"] != folder.name:
        problems.append(f"`id` is {t['id']!r}, the folder is {folder.name!r}")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", t["id"]):
        problems.append("`id` is lowercase letters, digits and hyphens")
    if t["category"] not in CATEGORIES:
        problems.append(f"`category` {t['category']!r} is not one of {', '.join(CATEGORIES)}")
    status = t.get("status", "ok")
    if status not in STATUSES:
        problems.append(f"`status` {status!r} is not one of {', '.join(STATUSES)}")
    if status != "ok" and not t.get("status_note"):
        problems.append("`status_note` says why a template is broken or unmaintained")
    maintainers = t.get("maintainers", [])
    if not all(isinstance(m, str) and re.fullmatch(r"[A-Za-z0-9-]+", m) for m in maintainers):
        problems.append("`maintainers` is a list of GitHub user names")

    logo = folder / t["logo"]
    if logo.parent != folder or logo.suffix not in (".svg", ".png") or not logo.is_file():
        problems.append(f"`logo` {t['logo']!r} is not an .svg or .png file in the folder")
    elif logo.suffix == ".png" and logo.stat().st_size > MAX_PNG:
        problems.append(f"{logo.name} is over {MAX_PNG // 1024} KiB")
    images = re.findall(r"^\s+image:\s*[\"']?([^\s\"'#]+)", compose.read_text(), re.M)
    if not images:
        problems.append("docker-compose.yml has no `image:`")
    expected = {"template.toml", "docker-compose.yml", t["logo"]}
    for extra in sorted(p.name for p in folder.iterdir() if p.name not in expected):
        problems.append(f"{extra} is not used")
    if problems:
        return None, problems

    deployed = {k: v for k, v in t.items() if k not in PRESENTATION}
    files = [compose, manifest, logo]
    return {
        "id": t["id"],
        "name": t["name"],
        "description": t["description"],
        "category": t["category"],
        "tags": t["tags"],
        "version": t["version"],
        "logo": t["logo"],
        "website": t["website"],
        "docs": t["docs"],
        "source": t["source"],
        "status": status,
        "status_note": t.get("status_note", ""),
        "maintainers": maintainers,
        "origin": "dokploy" if "upstream" in t else "podkit",
        "images": sorted(set(images)),
        # Changes only when what gets deployed changes: podkit compares it with the one a
        # deployed copy was made from.
        "revision": sha256(compose.read_bytes() + json.dumps(deployed, sort_keys=True).encode())[:16],
        "files": [{"name": f.name, "sha256": sha256(f.read_bytes()), "size": f.stat().st_size} for f in files],
    }, []


def main():
    args = argparse.ArgumentParser()
    args.add_argument("--check", action="store_true")
    args.add_argument("--out", default="dist")
    args = args.parse_args()

    entries, bad = [], 0
    for folder in sorted(p for p in (ROOT / "templates").iterdir() if p.is_dir()):
        entry, problems = load(folder)
        for p in problems:
            print(f"templates/{folder.name}: {p}", file=sys.stderr)
        bad += bool(problems)
        if entry:
            entries.append(entry)
    if bad:
        sys.exit(f"{bad} template(s) with problems")
    print(f"{len(entries)} templates are valid")
    if args.check:
        return

    out = ROOT / args.out
    shutil.rmtree(out, ignore_errors=True)
    shutil.copytree(ROOT / "site", out)
    for e in entries:
        shutil.copytree(ROOT / "templates" / e["id"], out / "templates" / e["id"])
    git = subprocess.run(["git", "rev-parse", "--verify", "HEAD"], cwd=ROOT, capture_output=True, text=True)
    commit = git.stdout.strip() if git.returncode == 0 else ""
    index = {"format": FORMAT, "commit": commit, "templates": entries}
    (out / "index.json").write_text(json.dumps(index, separators=(",", ":")))
    print(f"wrote {out.relative_to(ROOT)}/ at {commit[:7] or 'no commit'}")


if __name__ == "__main__":
    main()
