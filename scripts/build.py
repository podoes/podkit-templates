#!/usr/bin/env python3
"""Checks every template and builds the catalog.

  scripts/build.py --check          only check; exit 1 on the first list of problems
  scripts/build.py [--out dist]     check, then write the catalog and the website

The catalog is `index.json` plus `templates/<id>/<file>`, all static, served by GitHub Pages.
podkit downloads `index.json` when an admin presses refresh, and a template's files when
someone opens it. docs/catalog.md describes the format.
"""
import argparse
import gzip
import hashlib
import io
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile
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


PRESET_ABOUT = ("name", "description", "tags", "maintainers")


def servers_of(project):
    """Every `server` a preset's project names, with where."""
    for env, e in project.get("environments", {}).items():
        for kind in ("apps", "databases", "stacks", "models", "cron"):
            for name, obj in e.get(kind, {}).items():
                if "server" in obj:
                    yield f"environments.{env}.{kind}.{name}.server", obj["server"]
    for network in project.get("networks", []):
        yield f"networks.{network.get('name')}.server", network.get("server")


KINDS = (("apps", "application"), ("databases", "database"), ("stacks", "stack"), ("models", "model"), ("cron", "scheduled task"))


# What an image is, when it is a database: the mark its tile wears.
ENGINES = (("postgres", "postgres"), ("pgvector", "postgres"), ("timescale", "postgres"), ("mysql", "mysql"), ("mariadb", "mariadb"),
           ("mongo", "mongodb"), ("redis", "redis"), ("valkey", "redis"), ("keydb", "redis"), ("dragonfly", "redis"))


def nested(body, key):
    """The lines under `key:` in a service, and what is written on its own line."""
    lines = body.splitlines()
    for i, line in enumerate(lines):
        m = re.match(rf"(\s+){re.escape(key)}:\s*(.*)$", line)
        if not m:
            continue
        under = []
        for after in lines[i + 1:]:
            if after.strip() and len(after) - len(after.lstrip()) <= len(m.group(1)):
                break
            under.append(after)
        return under, m.group(2)
    return [], ""


def stack_of(compose, logos):
    """What a stack's compose file runs, for the site to draw it open: each service with its
    image and the services it uses, and each volume that several of them share.

    A service uses another when it waits for it (`depends_on`) or names it as a host in its
    environment. This reads the plain compose files a preset holds; it is not a YAML
    parser, and what it cannot read is left out of the drawing, never out of the preset.
    """
    block = re.search(r"^services:[ \t]*\n((?:[ \t]+.*\n|[ \t]*\n)*)", compose + "\n", re.M)
    first = block and re.search(r"^([ \t]+)\S", block.group(1), re.M)
    if not first:
        return [], []
    chunks = re.split(rf"^{first.group(1)}([A-Za-z0-9._-]+):[ \t]*(?:#.*)?\n", block.group(1), flags=re.M)
    bodies = dict(zip(chunks[1::2], chunks[2::2]))
    services, volumes = [], {}
    for name, body in bodies.items():
        image = re.search(r"^\s+image:\s*[\"']?([^\s\"'#]+)", body, re.M)
        image = image.group(1) if image else ""
        base = image.split("@")[0].rsplit("/", 1)[-1].split(":")[0]
        under, inline = nested(body, "depends_on")
        depth = min((len(line) - len(line.lstrip()) for line in under if line.strip()), default=0)
        waits = set(re.findall(r"[\w.-]+", inline))
        for line in under:
            m = re.match(r"\s*-\s*[\"']?([\w.-]+)", line) or (len(line) - len(line.lstrip()) == depth and re.match(r"\s*([\w.-]+):", line))
            if m:
                waits.add(m.group(1))
        mounts, _ = nested(body, "volumes")
        for line in mounts:
            m = re.match(r"\s*-\s*[\"']?([A-Za-z0-9._-]+):/", line)
            if m:
                volumes.setdefault(m.group(1), []).append(name)
        said = "\n".join(line for line in body.splitlines() if line not in mounts)
        # Named as a host: after // or @, before a port, or as the whole value of a host setting.
        # A database called after its user (POSTGRES_USER=forgejo) is not one.
        def host(other):
            o = re.escape(other)
            return re.search(rf"(?://|@){o}(?![\w.-])|(?<![\w.-]){o}:\d", said) or re.search(
                rf"^\s*-?\s*[\"']?[\w.]*(?:host|url|addr|server)[\w.]*\s*[:=]\s*[\"']?{o}[\"']?\s*$", said, re.M | re.I)
        names = {other for other in bodies if other != name and host(other)}
        service = {"name": name, "image": image, "uses": sorted((waits | names) & set(bodies) - {name})}
        engine = next((mark for word, mark in ENGINES if word in base), None)
        template = next((t for t in (name, base) if t in logos), None)
        if template:
            service["logo"] = f"templates/{template}/{logos[template]}"
        elif engine:
            service["mark"] = engine
        services.append(service)
    shared = [{"name": v, "services": users} for v, users in volumes.items() if len(users) > 1]
    return services, shared


def outline_of(project, logos):
    """What a preset makes, for the site to draw: its environments and what is in each.

    `logos` is each catalog template's logo by id: a part named after a template wears it,
    and so does a stack whose first service is one.
    """
    def part(kind, label, name, obj):
        services, shared = stack_of(obj.get("compose", ""), logos) if kind == "stacks" else ([], [])
        if kind == "databases":
            detail = " ".join(str(v) for v in (obj.get("engine"), obj.get("version")) if v)
        elif kind == "cron":
            detail = obj.get("schedule", "")
        elif kind == "stacks":
            detail = ", ".join(s["name"] for s in services) if len(services) > 1 else "compose file"
        else:
            # An application is an image or a repository, a model a repository.
            detail = obj.get("image") or obj.get("repo") or ""
        # The mark podkit's canvas gives the part: what it runs, when that has one.
        if kind == "databases":
            mark = obj.get("engine")
        elif kind == "models":
            mark = "ollama" if obj.get("engine") == "ollama" else "huggingface"
        else:
            mark = "docker" if kind == "stacks" or (kind == "apps" and "image" in obj) else None
        template = next((t for t in [name, *(s["name"] for s in services)] if t in logos), None)
        out = {"kind": label, "name": name, "detail": detail, "mark": mark}
        if template:
            out["logo"] = f"templates/{template}/{logos[template]}"
        if len(services) > 1:
            out["services"], out["shared"] = services, shared
        return out

    return {
        "environments": [
            {
                "slug": slug,
                "name": e.get("name", slug),
                "parts": [part(kind, label, name, obj) for kind, label in KINDS for name, obj in e.get(kind, {}).items()],
            }
            for slug, e in project.get("environments", {}).items()
        ],
        "networks": [
            # The same name can be in two environments: a member is told apart by its own.
            {"name": n.get("name", ""), "members": [{k: m.get(k, "") for k in ("environment", "kind", "name")} for m in n.get("members", [])]}
            for n in project.get("networks", [])
        ],
    }


def load_preset(folder, logos):
    """One preset as its index entry, or the list of what is wrong with it.

    A preset is a podkit project file. podkit checks it in full when it reads the catalog;
    this checks what the catalog asks on top: nothing in it may belong to one install.
    """
    about_file, preset_file = folder / "about.toml", folder / "preset.toml"
    if not about_file.is_file() or not preset_file.is_file():
        return None, ["needs about.toml and preset.toml"]
    try:
        about = tomllib.loads(about_file.read_text())
        text = preset_file.read_text()
        preset = tomllib.loads(text)
    except tomllib.TOMLDecodeError as e:
        return None, [str(e)]
    problems = [f"about.toml: `{k}` is missing" for k in PRESET_ABOUT if k not in about]
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", folder.name):
        problems.append("the folder is lowercase letters, digits and hyphens")
    projects = preset.get("projects", {})
    if preset.get("version") != 1 or len(projects) != 1:
        problems.append("preset.toml is `version = 1` with exactly one project")
        return None, problems
    (project,) = projects.values()
    for where, server in servers_of(project):
        if server != "${choose}":
            problems.append(f"{where} is {server!r}: a catalog preset says \"${{choose}}\"")
    for env, e in project.get("environments", {}).items():
        for name, app in e.get("apps", {}).items():
            where = f"environments.{env}.apps.{name}"
            if "${project}" not in app.get("slug", ""):
                problems.append(f"{where}.slug needs \"${{project}}\" in it: a slug is unique on a server")
            for key in ("deploy_key", "registry"):
                if app.get(key, "${choose}") != "${choose}":
                    problems.append(f"{where}.{key} names something of one team")
            if app.get("domains"):
                problems.append(f"{where}.domains: a hostname belongs to whoever applies the preset")
        for name, stack in e.get("stacks", {}).items():
            if stack.get("domains"):
                problems.append(f"environments.{env}.stacks.{name}.domains: a hostname belongs to whoever applies the preset")
    if "${secret:" in text and not about.get("secrets"):
        problems.append("about.toml: `secrets` says, for each secret to type in, what it is for")
    if problems:
        return None, problems
    return {
        "id": folder.name,
        "name": about["name"],
        "description": about["description"],
        "tags": about["tags"],
        "maintainers": about["maintainers"],
        "secrets": about.get("secrets", {}),
        "sha256": sha256(text.encode()),
        "outline": outline_of(next(iter(projects.values())), logos),
        # A preset is one small file: it travels in the index, where a podkit that does not
        # know presets leaves it alone.
        "file": text,
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
    presets = []
    for folder in sorted(p for p in (ROOT / "presets").glob("*") if p.is_dir()):
        entry, problems = load_preset(folder, {e["id"]: e["logo"] for e in entries})
        for p in problems:
            print(f"presets/{folder.name}: {p}", file=sys.stderr)
        bad += bool(problems)
        if entry:
            presets.append(entry)
    if bad:
        sys.exit(f"{bad} template(s) or preset(s) with problems")
    print(f"{len(entries)} templates and {len(presets)} presets are valid")
    if args.check:
        return

    out = ROOT / args.out
    shutil.rmtree(out, ignore_errors=True)
    shutil.copytree(ROOT / "site", out)
    for e in entries:
        shutil.copytree(ROOT / "templates" / e["id"], out / "templates" / e["id"])
    for e in presets:
        (out / "presets" / e["id"]).mkdir(parents=True)
        (out / "presets" / e["id"] / "preset.toml").write_text(e["file"])
    git = subprocess.run(["git", "rev-parse", "--verify", "HEAD"], cwd=ROOT, capture_output=True, text=True)
    commit = git.stdout.strip() if git.returncode == 0 else ""
    # Everything podkit needs in one download; it checks the hash before unpacking.
    archive = out / "catalog.tar.gz"
    with gzip.GzipFile(archive, "wb", mtime=0) as gz, tarfile.open(fileobj=gz, mode="w") as tar:
        for e in entries:
            for f in e["files"]:
                info = tarfile.TarInfo(f"templates/{e['id']}/{f['name']}")
                data = (ROOT / "templates" / e["id"] / f["name"]).read_bytes()
                info.size, info.mode = len(data), 0o644
                tar.addfile(info, io.BytesIO(data))
    index = {
        "format": FORMAT,
        "commit": commit,
        "archive": {"name": archive.name, "sha256": sha256(archive.read_bytes()), "size": archive.stat().st_size},
        "templates": entries,
        "presets": presets,
    }
    (out / "index.json").write_text(json.dumps(index, separators=(",", ":")))
    print(f"wrote {out.relative_to(ROOT)}/ at {commit[:7] or 'no commit'}")


if __name__ == "__main__":
    main()
