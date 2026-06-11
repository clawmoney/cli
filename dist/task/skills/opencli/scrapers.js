/**
 * Apify-equivalent scraper skills — Amazon, Google Maps, generic Web Scraper,
 * and Website Content Crawler. These bridge the operator's **bnbot** commands
 * (which run in the operator's real logged-in Chrome via the extension, so they
 * see residential IP + login state) to the SpareAPI skill surface, letting
 * buyers call them like any RapidAPI actor.
 *
 * Migrated from opencli → bnbot (2026-06-07). Note bnbot takes url/input as a
 * positional arg, not a --url flag like opencli did.
 *
 * Skill ids match the hub's routing:
 *   /amazon/product → amazon.product, /amazon/search → amazon.search,
 *   /web/scrape → web.scrape, /web/read → web.read, /google/maps → gg.maps.
 */
import { bnbotCommand, opencliCommand } from "./_bnbot.js";
import { makeOpenCliSkill, num, reqStr, str } from "./_skill.js";
const limit = (i, fallback) => num(i, ["limit", "count"]) ?? fallback;
// --- Amazon (Apify Amazon Scraper equivalent) ---
export const amazonProductSkill = makeOpenCliSkill("amazon product", (i) => bnbotCommand(["amazon", "product"], [reqStr(i, ["input", "asin", "url", "query"], "input")]));
// bnbot has no `amazon offer` yet — keep this one on opencli until migrated.
export const amazonOfferSkill = makeOpenCliSkill("amazon offer", (i) => opencliCommand(["amazon", "offer"], [reqStr(i, ["input", "asin", "url"], "input")]));
export const amazonSearchSkill = makeOpenCliSkill("amazon search", (i) => bnbotCommand(["amazon", "search"], [reqStr(i, ["query", "keyword", "q"], "query")], { limit: limit(i) }));
// --- Google Maps (Apify Google Maps Scraper equivalent — their largest, 361K) ---
export const ggMapsSkill = makeOpenCliSkill("google maps", (i) => bnbotCommand(["google", "maps"], [reqStr(i, ["query", "keyword", "q"], "query")], { limit: limit(i) }));
// --- Web Scraper (Apify Web Scraper equivalent — URL + CSS selectors → JSON) ---
// bnbot: `web scrape <url> --selectors <json> --container <sel>`.
export const webScrapeSkill = makeOpenCliSkill("web scrape", (i) => {
    const selectors = i.selectors;
    return bnbotCommand(["web", "scrape"], [reqStr(i, ["url"], "url")], {
        selectors: typeof selectors === "string" ? selectors : JSON.stringify(selectors ?? {}),
        container: str(i, ["container"]),
        wait: num(i, ["wait"]),
    });
});
// --- Website Content Crawler (Apify equivalent — any page → main content) ---
// bnbot: `web read <url>` returns { url, title, text } JSON directly.
export const webReadSkill = makeOpenCliSkill("web read", (i) => bnbotCommand(["web", "read"], [reqStr(i, ["url"], "url")]));
