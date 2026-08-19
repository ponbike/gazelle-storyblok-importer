# Storyblok FAQ importer

Imports a Magento FAQ export (`faq_export.json`) into Storyblok, converting the HTML answers to Storyblok richtext.

## What it does

For every store code found in the export it creates the folder tree:

```
faq/
  <store-code>/
    categories/      -> FaqCategory stories
    subcategories/   -> FaqSubcategory stories (linked to a category)
    questions/       -> FaqQuestion stories (linked to a subcategory)
```

Folders and stories are matched by slug, so re-running is safe. Slugs are always derived from the *full* export, so a filtered run produces the same slugs as a full run. Colliding names get their source id appended.

The HTML in `description` is converted by [html-to-richtext.js](html-to-richtext.js). Embeds (`img`, `iframe`, `video`, ...) cannot be represented in richtext and are dropped — they are listed in the summary. If Storyblok rejects a native table (422), the question is retried with a flattened table.

## Setup

Requires Node.js >= 20.12.

```sh
npm install
```

Create a `.env` file next to `index.js`:

```sh
STORYBLOK_OAUTH_TOKEN=your-personal-access-token
STORYBLOK_SPACE_ID=228883
```

`STORYBLOK_OAUTH_TOKEN` is required. `STORYBLOK_SPACE_ID` is optional and defaults to `228883`. Both can also be set as regular environment variables.

## Usage

```sh
node index.js [flags]
```

| Flag | Type | Description |
| --- | --- | --- |
| `--faq-id <id>` | string | Import only the question with this `faq_id`. |
| `--store-code <code>` | string | Import only questions for this store code. |
| `--skip-existing` | boolean | Leave existing questions untouched. By default existing questions are overwritten. |

Flags can be combined. If no entry matches the filters the script exits with the list of available store codes.

### Examples

```sh
# Full import (overwrites existing questions)
node index.js

# Full import, only create what is missing
node index.js --skip-existing

# One store only (e.g. nl-nl, nl-be)
node index.js --store-code nl-nl

# One question, for debugging a conversion
node index.js --faq-id 1234
```

## Output

The run ends with a table of created / updated / skipped / failed counts per level, followed by warnings for unmapped HTML tags, flattened tables and dropped embeds.
