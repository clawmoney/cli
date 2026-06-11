/**
 * LinkedIn lead-gen / Sales Navigator skills — the highest-value, hardest-to-
 * scrape surface (Apify charges $3-10/1K and data-center IPs get blocked fast).
 * These run in the operator's real logged-in Chrome via **bnbot** (extension),
 * so they carry a genuine session and residential IP.
 *
 * Migrated from opencli → bnbot (2026-06-07). bnbot takes url/keywords as a
 * positional arg (not a --profile-url flag), and the profile command is
 * `linkedin profile` (opencli called it `profile-read`).
 *
 * SAFETY: only commands that query OTHER people / public data are exposed.
 * The operator's OWN private surface and all write ops are NOT registered.
 *
 * Skill ids are `li.{action}`; the hub's catalog router maps
 * /linkedin/{action} → li.{action} automatically (no hub change needed).
 */
import { bnbotCommand } from "./_bnbot.js";
import { makeOpenCliSkill, num, reqStr } from "./_skill.js";
const limit = (i, fb) => num(i, ["limit", "count"]) ?? fb;
const profileUrl = (i) => reqStr(i, ["profile_url", "profileUrl", "url"], "profile_url");
const keywords = (i) => reqStr(i, ["query", "keywords", "keyword", "q"], "query");
// People search — B2B lead-gen core (standard LinkedIn search).
export const liPeopleSearchSkill = makeOpenCliSkill("linkedin people-search", (i) => bnbotCommand(["linkedin", "people-search"], [keywords(i)], { limit: limit(i) }));
// Sales Navigator search — premium lead-gen. Requires the provider account to
// have a Sales Navigator subscription.
export const liSalesnavSearchSkill = makeOpenCliSkill("linkedin salesnav-search", (i) => bnbotCommand(["linkedin", "salesnav-search"], [keywords(i)], { limit: limit(i) }));
// Profile read — full profile of a target person (bnbot: `linkedin profile <url>`).
export const liProfileSkill = makeOpenCliSkill("linkedin profile", (i) => bnbotCommand(["linkedin", "profile"], [profileUrl(i)]));
// A target's work experience.
export const liProfileExperienceSkill = makeOpenCliSkill("linkedin profile-experience", (i) => bnbotCommand(["linkedin", "profile-experience"], [profileUrl(i)]));
// A target's projects.
export const liProfileProjectsSkill = makeOpenCliSkill("linkedin profile-projects", (i) => bnbotCommand(["linkedin", "profile-projects"], [profileUrl(i)]));
// A target's recent posts.
export const liPostsSkill = makeOpenCliSkill("linkedin posts", (i) => bnbotCommand(["linkedin", "posts"], [profileUrl(i)], { limit: limit(i) }));
// Job posting detail.
export const liJobDetailSkill = makeOpenCliSkill("linkedin job-detail", (i) => bnbotCommand(["linkedin", "job-detail"], [reqStr(i, ["job_url", "jobUrl", "url"], "job_url")]));
