# Contributing

## A template

```
templates/<id>/
  template.toml
  docker-compose.yml
  logo.svg            or logo.png, at most 64 KiB
```

`template.toml`:

| Key | Meaning |
|---|---|
| `id` | The folder name: lowercase letters, digits, hyphens |
| `name`, `description` | What people read in the catalog |
| `category` | One of the categories in `scripts/build.py` |
| `tags` | Words people search for |
| `version` | The version of the software, not of the template |
| `logo` | The logo file in the folder |
| `website`, `docs`, `source` | Links |
| `maintainers` | Optional. GitHub user names of the people who look after the template |
| `status` | Optional. `broken` or `unmaintained`; leave it out when the template works |
| `status_note` | Required with `status`: one sentence that says why |
| `upstream` | Set on templates adapted from Dokploy. Do not add it to a new one |

`[variables]`, `[config]` and the compose subset are podkit's: see
[its template documentation](https://github.com/podoes/podkit/blob/main/docs/templates.md).

## Before you open a pull request

1. Run `scripts/build.py --check`.
2. Run `scripts/check_images.py <id>` to confirm the images exist.
3. Deploy the template on a podkit and confirm it starts. CI cannot do this for you.

Add yourself to `maintainers` when you add or adopt a template.

## Mark a template broken or unmaintained

Set `status` and `status_note` in its `template.toml`. The template stays in the catalog
with a label. To clear it, fix the template and remove both keys.
