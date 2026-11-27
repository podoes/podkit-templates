# podkit templates

One-click services for [podkit](https://github.com/podoes/podkit): 487 templates, each a
folder with a compose file, a `template.toml` and a logo.

This repository is the only source of official templates. Its website is the catalog:
browse it, then deploy a template to your own podkit.

It also holds presets: whole projects (environments, databases, applications) that a team
applies in one go and binds to its own servers.

## Add or change a template

Open a pull request. [CONTRIBUTING.md](CONTRIBUTING.md) has the file format and the checks.

```sh
scripts/build.py --check     # the checks CI runs
scripts/build.py             # also writes dist/: the website and the catalog
python3 -m http.server -d dist
```

The scripts need Python 3.11 or later and nothing else. With [devenv](https://devenv.sh) the
shell brings it, `serve` (builds and serves `dist/` at http://127.0.0.1:8767) and git hooks
that run the same check before each commit.

## How podkit uses it

GitHub Pages serves `dist/`. podkit downloads `index.json` when an admin presses refresh
and keeps a copy, so the gallery works offline after the first time. A template's files are
downloaded when someone opens it and are checked against the hashes in the index.
[docs/catalog.md](docs/catalog.md) describes the format and the deploy link.

## Status and credits

A template is `ok`, `broken` or `unmaintained`. A person sets that in a pull request. A
weekly job reports templates whose images no longer exist; it changes nothing by itself.

480 templates were adapted from the [Dokploy community templates](https://github.com/Dokploy/templates)
(MIT, see [NOTICE](NOTICE)) and are now maintained here. `maintainers` in a `template.toml`
names the people who look after it.

## License

MIT. Logos are trademarks of their owners.
