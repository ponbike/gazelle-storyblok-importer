# Storyblok POP category importer

Imports Magento category data from `category_export.json` into Storyblok using `import-pop.js`.

## What `import-pop.js` does

For each category item it ensures this content structure:

```
content/
  <store_code>/
    fietsen/
      ...optional parent folders...
        <category folder>/
          <category story>
```

Behavior details:

1. Creates `<store_code>` under the Storyblok root if missing.
2. Creates `fietsen` under each `<store_code>` if missing.
3. Resolves parent hierarchy from the import data:
   - First by `parent_id` (recursive chain).
   - Fallback by `parent.name` within the same `store_code`.
4. Creates missing parent folders automatically.
5. Creates/updates the category story in its resolved category folder.
6. Re-runs are safe: existing folders/stories are reused by slug/name.

## Field mapping

These fields are written to Storyblok content:

| Source (`category_export.json`) | Storyblok field |
| --- | --- |
| `name` | `name` |
| `description` | `description` |
| `additional_description` | `additional_description` |
| `url_key` | `url_key` |
| `url_path` | `url_path` |
| `image` | `image` |
| `meta_tags.title` (fallback: `meta_title`) | `meta_title` |
| `meta_tags.description` (fallback: `meta_description`) | `meta_description` |

The Storyblok component defaults to `ProductOverviewPageCategory` and can be overridden with `--component`.

## Setup

Requires Node.js >= 20.12.

```sh
npm install
```

Create a `.env` file in the repository root:

```sh
STORYBLOK_OAUTH_TOKEN=your-personal-access-token
STORYBLOK_SPACE_ID=228883
```

`STORYBLOK_OAUTH_TOKEN` is required. `STORYBLOK_SPACE_ID` is optional.

## Usage

```sh
node import-pop.js [flags]
```

| Flag | Type | Description |
| --- | --- | --- |
| `--limit <n>` | number | Import only the first `n` items. Without this flag, all items are imported. |
| `--skip-existing` | boolean | Do not update existing stories; only create missing ones. |
| `--component <name>` | string | Override the Storyblok component name. |

## Examples

```sh
# Import all items
node import-pop.js

# Import first 25 items
node import-pop.js --limit 25

# Import first 25, only create missing stories
node import-pop.js --limit 25 --skip-existing

# Import all items using a custom component
node import-pop.js --component ProductOverviewPageCategory
```

## Failure logging

On failed imports, the script logs:

- `category_id`
- `store_code`
- `name`

Example:

```text
! category_id=36 store_code=nl-nl name="Eclipse": <error message>
```
