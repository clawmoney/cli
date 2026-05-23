import { bnbotRDPopularPostsByCountry } from "./_bnbot.js";
import { makeRedditSkill, num, reqStr, str } from "./_skill.js";

export const rdPopularPostsByCountrySkill = makeRedditSkill("reddit popular posts by country", (i) =>
  bnbotRDPopularPostsByCountry({
    country: reqStr(i, ["country"], "country"),
    sort: str(i, ["sort"]),
    time: str(i, ["time", "t"]),
    limit: num(i, ["limit", "count"]),
  }));
