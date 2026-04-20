#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import TurndownService from "turndown";

const WP_BASE = "https://shinpapa-note.com/wp-json/wp/v2";
const BLOG_DIR = "src/data/blog";
const IMAGE_DIR = "public/assets/images/posts";
const IMAGE_URL_PREFIX = "/assets/images/posts";
const WP_HOST_REGEX = /https?:\/\/shinpapa-note\.com\/wp-content\/uploads\/[^"'\s)<>]+/g;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
const HEADERS = { "User-Agent": UA, "Accept": "*/*", "Accept-Language": "ja,en;q=0.9" };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, " ").replace(/&apos;/g, "'");
}
function stripHtml(s) { return decodeEntities(String(s).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()); }
function yamlString(s) { return JSON.stringify(String(s)); }

async function fetchWithRetry(url, opts = {}, tries = 3) {
  let lastRes;
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, { ...opts, headers: { ...HEADERS, ...(opts.headers || {}) } });
    lastRes = res;
    if (res.ok || res.status === 404) return res;
    await sleep(1500 * (i + 1));
  }
  return lastRes;
}

async function fetchAllPosts() {
  const posts = [];
  let page = 1;
  while (true) {
    const url = `${WP_BASE}/posts?per_page=100&page=${page}&_embed&orderby=date&order=asc`;
    const res = await fetchWithRetry(url);
    if (!res.ok) {
      if (res.status === 400) break;
      const body = await res.text().catch(() => "");
      throw new Error(`page ${page}: ${res.status} ${body.slice(0, 200)}`);
    }
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    posts.push(...batch);
    if (batch.length < 100) break;
    page++;
    await sleep(500);
  }
  return posts;
}

async function downloadImage(url, destPath) {
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.writeFile(destPath, buf);
}
function extFromUrl(u) {
  try { const e = path.extname(new URL(u).pathname).toLowerCase(); return e || ".jpg"; }
  catch { return ".jpg"; }
}

async function convertPost(post, turndown, cache) {
  const slug = post.slug;
  const title = decodeEntities(post.title?.rendered || "");
  let content = post.content?.rendered || "";

  const featuredUrl = post._embedded?.["wp:featuredmedia"]?.[0]?.source_url;
  let ogImage = "";
  if (featuredUrl) {
    try {
      if (!cache.has(featuredUrl)) {
        const name = `${slug}-featured${extFromUrl(featuredUrl)}`;
        await downloadImage(featuredUrl, path.join(IMAGE_DIR, name));
        cache.set(featuredUrl, name);
      }
      ogImage = `${IMAGE_URL_PREFIX}/${cache.get(featuredUrl)}`;
    } catch (e) { console.error(`  featured: ${e.message}`); }
  }

  const urls = [...new Set(content.match(WP_HOST_REGEX) || [])];
  let idx = 0;
  for (const url of urls) {
    idx++;
    if (!cache.has(url)) {
      const name = `${slug}-${idx}${extFromUrl(url)}`;
      try { await downloadImage(url, path.join(IMAGE_DIR, name)); cache.set(url, name); }
      catch (e) { console.error(`  img: ${e.message}`); continue; }
    }
    content = content.split(url).join(`${IMAGE_URL_PREFIX}/${cache.get(url)}`);
  }

  const markdown = turndown.turndown(content);
  const terms = (post._embedded?.["wp:term"] || []).flat().map(t => t?.name).filter(Boolean);
  const tags = [...new Set(terms)];
  const author = post._embedded?.author?.[0]?.name || "ヨウイチ";
  const description = stripHtml(post.excerpt?.rendered || "").slice(0, 200) || title;

  const fm = [
    "---",
    `author: ${yamlString(author)}`,
    `pubDatetime: ${post.date}+09:00`,
    `modDatetime: ${post.modified}+09:00`,
    `title: ${yamlString(title)}`,
    `slug: ${slug}`,
    "featured: false",
    "draft: false",
    "tags:",
    ...(tags.length ? tags.map(t => `  - ${yamlString(t)}`) : ["  - others"]),
    `description: ${yamlString(description)}`,
  ];
  if (ogImage) fm.push(`ogImage: ${ogImage}`);
  fm.push("---", "", markdown, "");
  await fs.writeFile(path.join(BLOG_DIR, `${slug}.md`), fm.join("\n"));
}

async function main() {
  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "*" });
  turndown.keep(["iframe"]);
  console.log("Fetching posts...");
  const posts = await fetchAllPosts();
  console.log(`Found ${posts.length} posts`);
  await fs.mkdir(BLOG_DIR, { recursive: true });
  await fs.mkdir(IMAGE_DIR, { recursive: true });
  const existing = await fs.readdir(BLOG_DIR).catch(() => []);
  for (const f of existing) if (f.endsWith(".md")) await fs.unlink(path.join(BLOG_DIR, f));
  const cache = new Map();
  let ok = 0, ng = 0;
  for (const [i, post] of posts.entries()) {
    try { await convertPost(post, turndown, cache); console.log(`  [${i+1}/${posts.length}] ${post.slug}`); ok++; }
    catch (e) { console.error(`  FAIL [${i+1}/${posts.length}] ${post.slug}: ${e.message}`); ng++; }
    await sleep(200);
  }
  console.log(`Done: ${ok} ok / ${ng} fail / ${cache.size} images`);
}

main().catch(e => { console.error(e); process.exit(1); });
