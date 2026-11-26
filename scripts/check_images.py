#!/usr/bin/env python3
"""Asks each registry whether the images of every template still exist.

  scripts/check_images.py [ID ...]      all templates, or the ones named

Prints the templates with a missing image and exits 1. It does not edit anything: a
person marks the template `status = "broken"` in a pull request. An answer that is
neither "found" nor "not found" (rate limit, registry down) is reported and does not fail.
"""
import json
import pathlib
import re
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
ACCEPT = ", ".join((
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
))


def parse(image):
    """registry host, repository, tag or digest."""
    name, digest = (image.split("@", 1) + [None])[:2]
    first, _, rest = name.partition("/")
    if rest and ("." in first or ":" in first or first == "localhost"):
        host, path = first, rest
    else:
        host, path = "registry-1.docker.io", name if "/" in name else f"library/{name}"
    if host == "docker.io":
        host, path = "registry-1.docker.io", path if "/" in path else f"library/{path}"
    repo, _, tag = path.rpartition(":") if ":" in path.rsplit("/", 1)[-1] else (path, "", "latest")
    return host, repo, digest or tag


def request(url, token=None, method="HEAD"):
    # Some registries refuse urllib's own User-Agent.
    req = urllib.request.Request(url, method=method, headers={"Accept": ACCEPT, "User-Agent": "podkit-templates"})
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    return urllib.request.urlopen(req, timeout=20)


def exists(image):
    """True, False, or a string saying why the registry gave no answer."""
    host, repo, ref = parse(image)
    url = f"https://{host}/v2/{repo}/manifests/{ref}"
    try:
        try:
            request(url)
            return True
        except urllib.error.HTTPError as e:
            if e.code != 401:
                raise
            # The registry says where an anonymous pull token comes from.
            ask = dict(re.findall(r'(\w+)="([^"]*)"', e.headers.get("WWW-Authenticate", "")))
            if "realm" not in ask:
                return "401 with no token service"
            query = f"?service={ask.get('service', '')}&scope=repository:{repo}:pull"
            body = json.load(request(ask["realm"] + query, method="GET"))
            request(url, body.get("token") or body.get("access_token"))
            return True
    except urllib.error.HTTPError as e:
        # Registries answer 401 or 403 for a repository that does not exist, to hide private ones.
        return False if e.code in (401, 403, 404) else f"HTTP {e.code}"
    except OSError as e:
        return str(e)


def main():
    wanted = set(sys.argv[1:])
    missing, unknown, seen = [], [], {}
    for compose in sorted((ROOT / "templates").glob("*/docker-compose.yml")):
        template = compose.parent.name
        if wanted and template not in wanted:
            continue
        for image in sorted(set(re.findall(r"^\s+image:\s*[\"']?([^\s\"'#]+)", compose.read_text(), re.M))):
            if "${" in image:
                continue
            if image not in seen:
                seen[image] = exists(image)
            if seen[image] is False:
                missing.append(f"{template}: {image}")
            elif seen[image] is not True:
                unknown.append(f"{template}: {image} ({seen[image]})")
    for line in unknown:
        print(f"no answer  {line}")
    for line in missing:
        print(f"MISSING    {line}")
    print(f"{len(seen)} images checked, {len(missing)} missing, {len(unknown)} without an answer")
    sys.exit(1 if missing else 0)


if __name__ == "__main__":
    main()
