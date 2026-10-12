# Storyblok POP category importer

Imports Magento category data from `category_export.json` into Storyblok using `import-pop.js`.

By default, the importer only processes these locales: `nl-nl`, `nl-be`, `de-de`, `en-us`, `da-dk`, and `sv-se`. All other locales are skipped.

## What `import-pop.js` does

For each category item it ensures this content structure:

```
content/
  <store_code>/
    <localized category root from url_path>/
      ...optional parent folders...
        <category folder>/
          <category startpage story>
```

Behavior details:

1. Creates `<store_code>` under the Storyblok root if missing.
2. Builds the full folder chain for each category from `url_path`.
3. Creates missing folders only when the existing entry at that slug is actually a folder.
4. Creates or updates the category page as a story inside the leaf folder, using the leaf slug as a startpage-style story.
5. Skips entries whose `store_code` is not in the supported locale allowlist.
6. Re-runs are safe as long as the folder structure already matches the intended path.

## Field mapping

These fields are written to Storyblok content:

| Source (`category_export.json`) | Storyblok field |
| --- | --- |
| `name` | `page_title` |
| `description` | `description` |
| `additional_description` | `additional_description` |
| `meta_title` | `meta_tags.title` |
| `meta_description` | `meta_tags.description` |
| default block | `blocks[0]` (`ProductListing`) |

The Storyblok component defaults to `ProductOverviewPage` and can be overridden with `--component`.

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
| `--category_id <id>` | string | Import only entries for the given category ID. |
| `--locale <store_code>` | string | Import only entries for one supported locale/store code, for example `en-us`. |

## Examples

```sh
# Import all items
node import-pop.js

# Import first 25 items
node import-pop.js --limit 25

# Import first 25, only create missing stories
node import-pop.js --limit 25 --skip-existing

# Import all items using a custom component
node import-pop.js --component ProductOverviewPage

# Import one category for one locale
node import-pop.js --category_id 876 --locale en-us
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

If an old incorrectly imported story already occupies a slug where a folder now needs to exist, the importer will stop on that path until that conflicting story is removed manually.
