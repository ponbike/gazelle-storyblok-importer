// storyblok-js-client@>=7, node@>=20.12
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import StoryblokClient from "storyblok-js-client";
import { htmlToRichtext } from "./html-to-richtext.js";

const ENV_FILE = fileURLToPath(new URL("./.env", import.meta.url));

if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const SPACE_ID = process.env.STORYBLOK_SPACE_ID ?? "228883";
const EXPORT_FILE = new URL("./faq_export.json", import.meta.url);
const PER_PAGE = 100;
const ROOT_PARENT_ID = 0;

const oauthToken = process.env.STORYBLOK_OAUTH_TOKEN;

if (!oauthToken) {
  console.error(
    "Missing STORYBLOK_OAUTH_TOKEN. Add it to a .env file or set it in the environment."
  );
  process.exit(1);
}

const { values: args } = parseArgs({
  options: {
    "faq-id": { type: "string" },
    "store-code": { type: "string" },
    "skip-existing": { type: "boolean" },
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
    // Guard against with_parent=0 being ignored at root level.
    for (const story of data.stories) {
      if ((story.parent_id ?? 0) === parentId) children.set(story.slug, story);
    }
    if (data.stories.length < PER_PAGE) break;
  }

  childrenCache.set(parentId, children);
  return children;
};

const stats = {
  folders: { created: 0, skipped: 0 },
  categories: { created: 0, updated: 0, skipped: 0, failed: 0 },
  subcategories: { created: 0, updated: 0, skipped: 0, failed: 0 },
  questions: { created: 0, updated: 0, skipped: 0, failed: 0 },
};

const unmappedTags = new Set();
const droppedEmbeds = [];
const tableFallbacks = [];

const ensureFolder = async (name, parentId) => {
  const slug = slugify(name);
  const children = await getChildren(parentId);
  const existing = children.get(slug);

  if (existing) {
    stats.folders.skipped++;
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
  stats.folders.created++;
  console.log(`  + folder ${data.story.full_slug}`);
  return data.story.id;
};

const ensureStory = async ({ name, slug, parentId, content, update = false }) => {
  const children = await getChildren(parentId);
  const existing = children.get(slug);

  if (existing && !update) {
    return { uuid: existing.uuid, created: false, updated: false };
  }

  if (existing) {
    await request(
      () =>
        storyblok.put(`spaces/${SPACE_ID}/stories/${existing.id}`, {
          story: { name, slug, parent_id: parentId, content },
        }),
      `updating story "${name}"`
    );
    return { uuid: existing.uuid, created: false, updated: true };
  }

  const { data } = await request(
    () =>
      storyblok.post(`spaces/${SPACE_ID}/stories`, {
        story: { name, slug, parent_id: parentId, content },
      }),
    `creating story "${name}"`
  );

  children.set(slug, data.story);
  return { uuid: data.story.uuid, created: true, updated: false };
};

// Names collide across parents (e.g. "Techniek"), so colliding slugs all get their source id.
const assignSlugs = (items) => {
  const counts = new Map();
  for (const item of items) {
    const key = `${item.store}|${slugify(item.slugBase)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const item of items) {
    const base = slugify(item.slugBase);
    item.slug =
      counts.get(`${item.store}|${base}`) > 1 ? `${base}-${item.sourceId}` : base;
  }
  return items;
};

const entries = JSON.parse(await readFile(EXPORT_FILE, "utf8"));

const usable = entries.filter((entry) => entry.category_parent?.name);
const orphans = entries.length - usable.length;

if (orphans > 0) console.warn(`Skipping ${orphans} entries without category_parent`);

const categories = new Map();
const subcategories = new Map();

for (const entry of usable) {
  const categoryKey = `${entry.store_code}|${entry.category_parent.category_id}`;
  if (!categories.has(categoryKey)) {
    categories.set(categoryKey, {
      store: entry.store_code,
      name: entry.category_parent.name,
      slugBase: entry.category_parent.name,
      sourceId: entry.category_parent.category_id,
    });
  }

  const subcategoryKey = `${entry.store_code}|${entry.category_id}`;
  if (!subcategories.has(subcategoryKey)) {
    subcategories.set(subcategoryKey, {
      store: entry.store_code,
      name: entry.category_name,
      slugBase: entry.category_name,
      sourceId: entry.category_id,
      categoryKey,
    });
  }
}

const questions = usable.map((entry) => ({
  store: entry.store_code,
  name: entry.title,
  slugBase: entry.url_key || entry.title,
  sourceId: entry.faq_id,
  title: entry.title,
  description: entry.description,
  subcategoryKey: `${entry.store_code}|${entry.category_id}`,
}));

// Slugs are derived from the whole export so filtered runs produce identical slugs to a full run.
assignSlugs([...categories.values()]);
assignSlugs([...subcategories.values()]);
assignSlugs(questions);

const selectedQuestions = questions.filter(
  (question) =>
    (!args["faq-id"] || String(question.sourceId) === args["faq-id"]) &&
    (!args["store-code"] || question.store === args["store-code"])
);

if (selectedQuestions.length === 0) {
  const filters = [
    args["faq-id"] && `faq-id "${args["faq-id"]}"`,
    args["store-code"] && `store-code "${args["store-code"]}"`,
  ].filter(Boolean);

  console.error(`No entries match ${filters.join(" and ")}`);
  console.error(
    `Available store codes: ${[...new Set(questions.map((q) => q.store))].join(", ")}`
  );
  process.exit(1);
}

const neededSubcategories = new Set(
  selectedQuestions.map((question) => question.subcategoryKey)
);
const selectedSubcategories = [...subcategories].filter(([key]) =>
  neededSubcategories.has(key)
);

const neededCategories = new Set(
  selectedSubcategories.map(([, subcategory]) => subcategory.categoryKey)
);
const selectedCategories = [...categories].filter(([key]) =>
  neededCategories.has(key)
);

const stores = [...new Set(selectedQuestions.map((question) => question.store))];

console.log(
  `Importing ${selectedQuestions.length} questions, ${selectedSubcategories.length} subcategories, ` +
    `${selectedCategories.length} categories across ${stores.join(", ")}`
);
console.log(
  updateExisting
    ? "Existing questions will be overwritten (pass --skip-existing to keep them)."
    : "Existing questions will be left untouched (--skip-existing)."
);

console.log("\nResolving folders...");
const faqRootId = await ensureFolder("faq", ROOT_PARENT_ID);
const folders = new Map();

for (const store of stores) {
  const storeId = await ensureFolder(store, faqRootId);
  folders.set(store, {
    categories: await ensureFolder("categories", storeId),
    subcategories: await ensureFolder("subcategories", storeId),
    questions: await ensureFolder("questions", storeId),
  });
}

console.log("\nCreating categories...");
const categoryUuids = new Map();

for (const [key, category] of selectedCategories) {
  try {
    const { uuid, created } = await ensureStory({
      name: category.name,
      slug: category.slug,
      parentId: folders.get(category.store).categories,
      content: { component: "FaqCategory" },
    });
    categoryUuids.set(key, uuid);
    stats.categories[created ? "created" : "skipped"]++;
  } catch (error) {
    stats.categories.failed++;
    console.error(`  ! ${category.store}/${category.name}: ${error.message}`);
  }
}

console.log("\nCreating subcategories...");
const subcategoryUuids = new Map();

for (const [key, subcategory] of selectedSubcategories) {
  const parentUuid = categoryUuids.get(subcategory.categoryKey);

  if (!parentUuid) {
    stats.subcategories.failed++;
    console.error(`  ! ${subcategory.store}/${subcategory.name}: parent category missing`);
    continue;
  }

  try {
    const { uuid, created } = await ensureStory({
      name: subcategory.name,
      slug: subcategory.slug,
      parentId: folders.get(subcategory.store).subcategories,
      content: { component: "FaqSubcategory", parent: parentUuid },
    });
    subcategoryUuids.set(key, uuid);
    stats.subcategories[created ? "created" : "skipped"]++;
  } catch (error) {
    stats.subcategories.failed++;
    console.error(`  ! ${subcategory.store}/${subcategory.name}: ${error.message}`);
  }
}

console.log("\nCreating questions...");

const writeQuestion = (question, categoryUuid, tableMode) => {
  const { doc, warnings } = htmlToRichtext(question.description, { tableMode });

  return {
    warnings,
    write: () =>
      ensureStory({
        name: question.name,
        slug: question.slug,
        parentId: folders.get(question.store).questions,
        update: updateExisting,
        content: {
          component: "FaqQuestion",
          question_title: question.title,
          question_answer: doc,
          category: categoryUuid,
        },
      }),
  };
};

for (const question of selectedQuestions) {
  const categoryUuid = subcategoryUuids.get(question.subcategoryKey);

  if (!categoryUuid) {
    stats.questions.failed++;
    console.error(`  ! ${question.store}/${question.name}: subcategory missing`);
    continue;
  }

  try {
    let attempt = writeQuestion(question, categoryUuid, "native");
    let result;

    try {
      result = await attempt.write();
    } catch (error) {
      if (error.status !== 422) throw error;
      tableFallbacks.push(question.sourceId);
      attempt = writeQuestion(question, categoryUuid, "flat");
      result = await attempt.write();
    }

    for (const tag of attempt.warnings.unmapped) unmappedTags.add(tag);
    for (const dropped of attempt.warnings.dropped) {
      droppedEmbeds.push(`faq_id ${question.sourceId} — ${dropped}`);
    }

    if (result.created) stats.questions.created++;
    else if (result.updated) stats.questions.updated++;
    else stats.questions.skipped++;
  } catch (error) {
    stats.questions.failed++;
    console.error(`  ! ${question.store}/${question.name}: ${error.message}`);
  }
}

console.log("\nDone.");
console.table(stats);

if (unmappedTags.size > 0) {
  console.warn(`Unmapped HTML tags: ${[...unmappedTags].join(", ")}`);
}

if (tableFallbacks.length > 0) {
  console.warn(`Tables flattened after rejection: ${tableFallbacks.join(", ")}`);
}

if (droppedEmbeds.length > 0) {
  console.warn(`\nDropped ${droppedEmbeds.length} embeds (not supported in richtext):`);
  for (const dropped of droppedEmbeds) console.warn(`  ${dropped}`);
}

const failed =
  stats.categories.failed + stats.subcategories.failed + stats.questions.failed;

if (failed > 0) process.exitCode = 1;