# The catalog

`scripts/build.py` writes `dist/`, which GitHub Pages serves:

```
index.json
catalog.tar.gz                     every template, for podkit
templates/<id>/template.toml, docker-compose.yml, logo.*
index.html, app.js, style.css      the website
```

## index.json

```json
{
  "format": 1,
  "commit": "<git commit of this repository>",
  "archive": { "name": "catalog.tar.gz", "sha256": "…", "size": 0 },
  "templates": [ … ]
}
```

`catalog.tar.gz` holds `templates/<id>/<file>` for every template. podkit downloads the
index, then the archive, and unpacks the archive only when its SHA-256 is the one in the index.

`format` is raised only for a change an older podkit cannot ignore. podkit refuses a format
it does not know and keeps its last copy.

Each template:

| Field | Meaning |
|---|---|
| `id`, `name`, `description`, `category`, `tags`, `version`, `logo`, `website`, `docs`, `source` | From `template.toml` |
| `status`, `status_note` | `ok`, `broken` or `unmaintained`, and why |
| `maintainers` | GitHub user names |
| `origin` | `dokploy` or `podkit` |
| `images` | The images the compose file names |
| `revision` | Changes only when what gets deployed changes |
| `files` | Name, SHA-256 and size of each file |

## Revisions

`revision` is a hash of the compose file and of every `template.toml` key that is not for
reading (`[variables]`, `[config]` and the like). A new description or logo does not change
it. podkit stores the revision an application was deployed from and says a newer template
exists when the catalog's differs.

## The deploy link

The website links to `https://<the user's podkit>/market/<id>`. The address is typed by the
user and kept in their browser.

What podkit must do with that request:

- Show a confirmation page. Opening the link never deploys.
- Look `<id>` up in its own copy of the catalog. The link carries no template content.
- Answer "unknown template, refresh the catalog" for an id it does not have.

## Importing a file by hand

The website offers each template's files for download. podkit can import such files, and
any other template file. It treats every import as unofficial: labelled, shown in full
before the deploy, and never told about updates.
