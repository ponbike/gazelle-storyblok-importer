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
const DEFAULT_COMPONENT = "ProductOverviewPageCategory";

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

const normalizeName = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");

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

const ensureFolder = async (name, parentId) => {
  const slug = slugify(name);
  const children = await getChildren(parentId);
  const exact = children.get(slug);
  const byName = [...children.values()].find(
    (story) => normalizeName(story.name) === normalizeName(name)
  );
  const existing = exact ?? byName;

  if (existing) {
    if (!existing.is_folder) {
      throw new Error(
        `Expected folder "${name}" under parent ${parentId}, but found a story with the same key`
      );
    }
    return existing.id;
  }

  const { data } = await request(
    () =>
      storyblok.post(`spaces/${SPACE_ID}/stories`, {
        story: { name, slug, is_folder: true, parent_id: parentId },
      }),
    `creating folder "${name}"`
  );

  children.set(slug, data.story);
  return data.story.id;
};

const ensureStory = async ({ name, slug, parentId, content, update = false }) => {
  const children = await getChildren(parentId);
  const existing = children.get(slug);

  if (existing && !update) {
    return { created: false, updated: false, id: existing.id, uuid: existing.uuid };
  }

  if (existing) {
    await request(
      () =>
        storyblok.put(`spaces/${SPACE_ID}/stories/${existing.id}`, {
          story: { name, slug, parent_id: parentId, content },
        }),
      `updating story "${name}"`
    );
    return { created: false, updated: true, id: existing.id, uuid: existing.uuid };
  }

  const { data } = await request(
    () =>
      storyblok.post(`spaces/${SPACE_ID}/stories`, {
        story: { name, slug, parent_id: parentId, content },
      }),
    `creating story "${name}"`
  );

  children.set(slug, data.story);
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

const selectedEntries = entries;
const hasLimitArg = args.limit != null;
const requestedLimit = Number(args.limit);
if (hasLimitArg && (!Number.isFinite(requestedLimit) || requestedLimit <= 0)) {
  console.error("Invalid --limit value. Use a number greater than 0.");
  process.exit(1);
}

const itemsToImport = hasLimitArg
  ? selectedEntries.slice(0, requestedLimit)
  : selectedEntries;
console.log(`Importing ${itemsToImport.length} of ${selectedEntries.length} item(s)`);

const getCategoryKey = (item) => {
  if (item?.category_id == null) return null;
  const storeCode = String(item.store_code ?? "unknown");
  return `${storeCode}|${String(item.category_id)}`;
};

const categoryEntries = new Map();
for (const entry of entries) {
  const key = getCategoryKey(entry);
  if (key && !categoryEntries.has(key)) categoryEntries.set(key, entry);
}

const buildCategoryContent = (item, fallbackName = "") => {
  const name = item.name || item.url_key || fallbackName || `Category ${item.category_id ?? "item"}`;
  const url = item.url_path || item.url_key || item.url || "";

  return {
    component: args.component ?? DEFAULT_COMPONENT,
    name,
    description: item.description ?? "",
    additional_description: item.additional_description ?? "",
    url_key: item.url_key ?? "",
    url_path: item.url_path ?? url,
    image: item.image ?? "",
    meta_title: item.meta_title ?? item.meta_tags?.title ?? "",
    meta_description: item.meta_description ?? item.meta_tags?.description ?? "",
  };
};

const storeFolders = new Map();
const categoryFolders = new Map();
const parentFoldersByName = new Map();

for (const item of itemsToImport) {
  const storeCode = String(item.store_code ?? "unknown");
  if (!storeFolders.has(storeCode)) {
    const storeFolderId = await ensureFolder(storeCode, ROOT_PARENT_ID);
    const bicyclesFolderId = await ensureFolder("fietsen", storeFolderId);
    storeFolders.set(storeCode, bicyclesFolderId);
  }
}

const ensureCategoryFolder = async (item, parentId) => {
  const key = getCategoryKey(item);
  if (key && categoryFolders.has(key)) return categoryFolders.get(key);

  const name = item.name || item.url_key || `Category ${item.category_id ?? "item"}`;
  const folderId = await ensureFolder(name, parentId);
  if (key) categoryFolders.set(key, folderId);
  return folderId;
};

const ensureCategoryStory = async (item, parentId) => {
  const name = item.name || item.url_key || `Category ${item.category_id ?? "item"}`;
  const slug = slugify(item.url_key || item.name || `category-${item.category_id ?? name}`);
  return await ensureStory({
    name,
    slug,
    parentId,
    content: buildCategoryContent(item, name),
    update: updateExisting,
  });
};

const resolveParentFolderId = async (item, storeRootId, stack = new Set()) => {
  const storeCode = String(item.store_code ?? "unknown");
  const parentCategoryId = Number(item.parent_id);

  if (Number.isFinite(parentCategoryId) && parentCategoryId > 0) {
    const parentKey = `${storeCode}|${String(parentCategoryId)}`;
    const parentEntry = categoryEntries.get(parentKey);

    if (parentEntry) {
      if (stack.has(parentKey)) throw new Error(`Cycle detected for parent key "${parentKey}"`);

      const cachedParentFolder = categoryFolders.get(parentKey);
      if (cachedParentFolder) return cachedParentFolder;

      const nextStack = new Set(stack);
      nextStack.add(parentKey);
      const grandParentFolderId = await resolveParentFolderId(parentEntry, storeRootId, nextStack);
      return ensureCategoryFolder(parentEntry, grandParentFolderId);
    }
  }

  const parentName = item.parent?.name;
  if (parentName) {
    const parentNameKey = `${storeCode}|name|${slugify(parentName)}`;
    const cachedByName = parentFoldersByName.get(parentNameKey);
    if (cachedByName) return cachedByName;

    const folderId = await ensureFolder(parentName, storeRootId);
    parentFoldersByName.set(parentNameKey, folderId);
    return folderId;
  }

  return storeRootId;
};

for (const item of itemsToImport) {
  const storeCode = String(item.store_code ?? "unknown");
  const storeRootId = storeFolders.get(storeCode);
  const name = item.name || item.url_key || `Category ${item.category_id ?? "item"}`;
  const categoryId = item.category_id ?? "unknown";
  const itemLog = `category_id=${categoryId} store_code=${storeCode} name="${name}"`;

  if (!storeRootId) {
    console.error(`  ! ${itemLog}: missing parent folder`);
    stats.items.failed++;
    continue;
  }

  try {
    const parentFolderId = await resolveParentFolderId(item, storeRootId);
    const categoryFolderId = await ensureCategoryFolder(item, parentFolderId);
    const result = await ensureCategoryStory(item, categoryFolderId);

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
