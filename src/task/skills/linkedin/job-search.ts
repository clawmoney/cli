import { bnbotLIJobSearch } from "./_bnbot.js";
import { makeLinkedInSkill, num, reqStr, str } from "./_skill.js";

export const liJobSearchSkill = makeLinkedInSkill("linkedin job search", (i) =>
  bnbotLIJobSearch({
    query: reqStr(i, ["query", "keywords", "keyword", "q"], "query"),
    limit: num(i, ["limit", "count"]),
    location: str(i, ["location"]),
    experienceLevel: str(i, ["experienceLevel", "experience_level"]),
    jobType: str(i, ["jobType", "job_type"]),
    datePosted: str(i, ["datePosted", "date_posted"]),
    remote: str(i, ["remote"]),
  }),
);
