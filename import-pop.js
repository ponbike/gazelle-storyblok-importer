import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import StoryblokClient from 'storyblok-js-client'

const ENV_FILE = fileURLToPath(new URL("./.env", import.meta.url));

if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const SPACE_ID = process.env.STORYBLOK_SPACE_ID ?? "228883";
const EXPORT_FILE = new URL("./category_export.json", import.meta.url);
const PER_PAGE = 100;
const ROOT_PARENT_ID = 0;
const DEFAULT_COMPONENT = "ProductOverviewPage";
const ALLOWED_LOCALES = new Set(["nl-nl", "nl-be", "de-de", "en-us", "da-dk", "sv-se"]);

const oauthToken = process.env.STORYBLOK_OAUTH_TOKEN;
if (!oauthToken) {
  console.error(
    "Missing STORYBLOK_OAUTH_TOKEN. Add it to a .env file or set it in the environment."
  );
  process.exit(1);
}

const { values: args } = parseArgs({
  options: {
    limit: { type: "string" },
    "skip-existing": { type: "boolean" },
    component: { type: "string" },
    category_id: { type: "string" },
    "category-id": { type: "string" },
    locale: { type: "string" },
  },
});

const updateExisting = !args["skip-existing"];
const storyblok = new StoryblokClient({ oauthToken, rateLimit: 3 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const slugify = (value) =>
  String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200) || "item";

const request = async (fn, label) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const status = error?.status ?? error?.response?.status;
      if (status === 429 && attempt <= 5) {
        await sleep(attempt * 1000);
        continue;
      }

      const detail = error?.message ?? JSON.stringify(error?.response ?? error);
      throw Object.assign(new Error(`${label}: ${detail}`, { cause: error }), {
        status,
      });
    }
  }
};

const childrenCache = new Map();

const getChildren = async (parentId) => {
  if (childrenCache.has(parentId)) return childrenCache.get(parentId);

  const children = new Map();
  for (let page = 1; ; page++) {
    const { data } = await request(
      () =>
        storyblok.get(`spaces/${SPACE_ID}/stories`, {
          with_parent: parentId,
          per_page: PER_PAGE,
          page,
        }),
      `listing children of folder ${parentId}`
    );

    for (const story of data.stories) {
      if ((story.parent_id ?? 0) === parentId) children.set(story.slug, story);
    }

    if (data.stories.length < PER_PAGE) break;
  }

  childrenCache.set(parentId, children);
  return children;
};

const ensureFolder = async ({ name, slug, parentId }) => {
  const normalizedSlug = slugify(slug || name);
  const children = await getChildren(parentId);
  const existing = children.get(normalizedSlug);

  if (existing) {
    if (!existing.is_folder) {
      throw new Error(
        `Expected folder "${name}" (slug "${normalizedSlug}") under parent ${parentId}, but found a story with the same slug. Remove the conflicting story before importing this nested path.`
      );
    }
    return existing.id;
  }

  const { data } = await request(
    () =>
      storyblok.post(`spaces/${SPACE_ID}/stories`, {
        story: { name, slug: normalizedSlug, is_folder: true, parent_id: parentId },
      }),
    `creating folder "${name}"`
  );

  children.set(normalizedSlug, data.story);
  return data.story.id;
};

const ensureStory = async ({ name, slug, parentId, content, update = false, isStartpage = false }) => {
  const normalizedSlug = slugify(slug || name);
  const children = await getChildren(parentId);
  const existing = children.get(normalizedSlug);

  if (existing && !update) {
    return { created: false, updated: false, id: existing.id, uuid: existing.uuid };
  }

  if (existing) {
    await request(
      () =>
        storyblok.put(`spaces/${SPACE_ID}/stories/${existing.id}`, {
          story: { name, slug: normalizedSlug, parent_id: parentId, content, is_startpage: isStartpage },
        }),
      `updating story "${name}"`
    );
    children.set(normalizedSlug, {
      ...existing,
      name,
      slug: normalizedSlug,
      parent_id: parentId,
      content,
      is_startpage: isStartpage,
    });
    return { created: false, updated: true, id: existing.id, uuid: existing.uuid };
  }

  const { data } = await request(
    () =>
      storyblok.post(`spaces/${SPACE_ID}/stories`, {
        story: { name, slug: normalizedSlug, parent_id: parentId, content, is_startpage: isStartpage },
      }),
    `creating story "${name}"`
  );

  children.set(normalizedSlug, data.story);
  return { created: true, updated: false, id: data.story.id, uuid: data.story.uuid };
};

const stats = {
  folders: { created: 0, skipped: 0 },
  items: { created: 0, updated: 0, skipped: 0, failed: 0 },
};

const rawEntries = JSON.parse(await readFile(EXPORT_FILE, "utf8"));
const entries = Array.isArray(rawEntries) ? rawEntries : [];

if (entries.length === 0) {
  console.error(`No entries found in ${EXPORT_FILE.pathname}`);
  process.exit(1);
}

const requestedCategoryId = (args.category_id ?? args["category-id"])?.trim();
const requestedLocale = args.locale?.trim();

if ((args.category_id != null || args["category-id"] != null) && !requestedCategoryId) {
  console.error("Invalid --category_id value. Use a non-empty category ID.");
  process.exit(1);
}

if (args.locale != null && !requestedLocale) {
  console.error("Invalid --locale value. Use a non-empty locale.");
  process.exit(1);
}

if (requestedLocale && !ALLOWED_LOCALES.has(requestedLocale)) {
  console.error(
    `Unsupported --locale value "${requestedLocale}". Allowed locales: ${[...ALLOWED_LOCALES].join(", ")}.`
  );
  process.exit(1);
}

const selectedEntries = entries.filter((item) => {
  const storeCode = String(item?.store_code ?? "");
  if (!ALLOWED_LOCALES.has(storeCode)) return false;
  if (requestedCategoryId && String(item?.category_id ?? "") !== requestedCategoryId) return false;
  if (requestedLocale && storeCode !== requestedLocale) return false;
  return true;
});

if ((requestedCategoryId || requestedLocale) && selectedEntries.length === 0) {
  const filters = [
    requestedCategoryId ? `category_id=${requestedCategoryId}` : null,
    requestedLocale ? `locale=${requestedLocale}` : null,
  ].filter(Boolean);
  console.error(`No entries found for ${filters.join(" ")}.`);
  process.exit(1);
}

const hasLimitArg = args.limit != null;
const requestedLimit = Number(args.limit);
if (hasLimitArg && (!Number.isFinite(requestedLimit) || requestedLimit <= 0)) {
  console.error("Invalid --limit value. Use a number greater than 0.");
  process.exit(1);
}

const itemsToImport = hasLimitArg
  ? selectedEntries.slice(0, requestedLimit)
  : selectedEntries;
const scopeParts = [
  requestedCategoryId ? `category_id=${requestedCategoryId}` : null,
  requestedLocale ? `locale=${requestedLocale}` : null,
].filter(Boolean);
const importScopeLabel = scopeParts.length > 0
  ? `matching item(s) for ${scopeParts.join(" ")}`
  : "item(s)";
console.log(`Importing ${itemsToImport.length} of ${selectedEntries.length} ${importScopeLabel}`);

const getPathSegments = (item) =>
  String(item?.url_path ?? "")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

const getPathKey = (storeCode, segments) =>
  `${storeCode}|path|${segments.map((segment) => slugify(segment)).join("/")}`;

const buildDefaultProductListingBlock = () => ({
  _uid: randomUUID(),
  component: "ProductListing",
  ebike: [],
  frame: [],
  segment: [],
  price_max: "",
  price_min: "0",
  cta_blocks: [],
  weight_max: "",
  weight_min: "",
  show_filters: true,
  show_sorting: true,
  seating_position: [],
  preselected_filters: [],
});

const parseSeoLinks = (raw) => {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const buildSeoLinkBlocks = (item) =>
  parseSeoLinks(item.seo_links)
    .filter((link) => link?.label && link?.url)
    .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))
    .map((link) => ({
      _uid: randomUUID(),
      component: "SeoLinkItem",
      label: String(link.label),
      url: {
        id: "",
        url: String(link.url),
        linktype: "url",
        fieldtype: "multilink",
        cached_url: String(link.url),
      },
    }));

const buildCategoryContent = (item, fallbackName = "") => {
  const name = item.name || item.url_key || fallbackName || `Category ${item.category_id ?? "item"}`;

  return {
    component: args.component ?? DEFAULT_COMPONENT,
    page_title: name,
    description: item.description ?? "",
    additional_description: item.additional_description ?? "",
    meta_tags: {
      plugin: 'seo_metatags',
      title: item.meta_title ?? item.meta_tags?.title ?? "",
      description: item.meta_description ?? item.meta_tags?.description ?? "",
    },
    blocks: [buildDefaultProductListingBlock()],
    seo_links: buildSeoLinkBlocks(item),
  };
};

const storeDefaultRootFolderNames = new Map();
for (const entry of entries) {
  const storeCode = String(entry.store_code ?? "unknown");
  if (storeDefaultRootFolderNames.has(storeCode)) continue;

  const segment = getPathSegments(entry)[0] ?? null;
  if (segment) storeDefaultRootFolderNames.set(storeCode, segment);
}

const resolveRootFolderName = (item) => {
  const storeCode = String(item.store_code ?? "unknown");
  return getPathSegments(item)[0] ?? storeDefaultRootFolderNames.get(storeCode) ?? "fietsen";
};

const getCategoryName = (item, fallbackName = "") =>
  item.name || item.url_key || fallbackName || `Category ${item.category_id ?? "item"}`;

const getCategoryFolderSegments = (item) => {
  const pathSegments = getPathSegments(item);
  if (pathSegments.length > 0) return pathSegments;

  const rootFolderName = resolveRootFolderName(item);
  const leafSegment = item.url_key || item.name || `category-${item.category_id ?? "item"}`;
  return [rootFolderName, leafSegment];
};

const categoryEntriesByPath = new Map();
for (const entry of entries) {
  const storeCode = String(entry.store_code ?? "unknown");
  const pathSegments = getCategoryFolderSegments(entry);
  if (pathSegments.length > 0) categoryEntriesByPath.set(getPathKey(storeCode, pathSegments), entry);
}

const resolveFolderName = (storeCode, pathSegments, index, currentItem) => {
  if (index === pathSegments.length - 1) {
    return getCategoryName(currentItem, pathSegments[index]);
  }

  const ancestorEntry = categoryEntriesByPath.get(
    getPathKey(storeCode, pathSegments.slice(0, index + 1))
  );
  return getCategoryName(ancestorEntry ?? {}, pathSegments[index]);
};

const storeFolders = new Map();
const categoryFolderIds = new Map();

const ensureCategoryFolderChain = async (item) => {
  const storeCode = String(item.store_code ?? "unknown");
  let storeFolderId = storeFolders.get(storeCode);
  if (!storeFolderId) {
    storeFolderId = await ensureFolder({
      name: storeCode,
      slug: storeCode,
      parentId: ROOT_PARENT_ID,
    });
    storeFolders.set(storeCode, storeFolderId);
  }

  const pathSegments = getCategoryFolderSegments(item);
  let parentId = storeFolderId;

  for (let index = 0; index < pathSegments.length; index++) {
    const segment = pathSegments[index];
    const pathKey = getPathKey(storeCode, pathSegments.slice(0, index + 1));
    const cachedFolderId = categoryFolderIds.get(pathKey);
    if (cachedFolderId) {
      parentId = cachedFolderId;
      continue;
    }

    const folderName = resolveFolderName(storeCode, pathSegments, index, item);
    parentId = await ensureFolder({
      name: folderName,
      slug: segment,
      parentId,
    });
    categoryFolderIds.set(pathKey, parentId);
  }

  return {
    leafFolderId: parentId,
    pathSegments,
  };
};

const ensureCategoryStory = async (item, parentId, slug) => {
  const name = getCategoryName(item);
  return await ensureStory({
    name,
    slug,
    parentId,
    content: buildCategoryContent(item, name),
    update: updateExisting,
    isStartpage: true,
  });
};

for (const item of itemsToImport) {
  const name = getCategoryName(item);
  const categoryId = item.category_id ?? "unknown";
  const itemLog = `category_id=${categoryId} store_code=${String(item.store_code ?? "unknown")} name="${name}"`;

  try {
    const { leafFolderId, pathSegments } = await ensureCategoryFolderChain(item);
    const storySlug =
      pathSegments.at(-1) ?? item.url_key ?? item.name ?? `category-${item.category_id ?? "item"}`;
    const result = await ensureCategoryStory(item, leafFolderId, storySlug);

    if (result.created) stats.items.created++;
    else if (result.updated) stats.items.updated++;
    else stats.items.skipped++;
  } catch (error) {
    stats.items.failed++;
    console.error(`  ! ${itemLog}: ${error.message}`);
  }
}

console.log("\nDone.");
console.table(stats);

if (stats.items.failed > 0) process.exitCode = 1;
