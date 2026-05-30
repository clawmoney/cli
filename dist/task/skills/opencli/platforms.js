import { bnbotCommand, opencliCommand } from "./_bnbot.js";
import { makeOpenCliSkill, num, reqStr, str } from "./_skill.js";
const limit = (i, fallback) => num(i, ["limit", "count"]) ?? fallback;
const query = (i) => reqStr(i, ["query", "keyword", "q"], "query");
const id = (i) => reqStr(i, ["id"], "id");
const symbol = (i) => reqStr(i, ["symbol", "ticker"], "symbol");
function openSkill(label, base, positional = () => [], flags = () => ({})) {
    return makeOpenCliSkill(label, (i) => opencliCommand(base, positional(i), flags(i)));
}
export const ggSearchSkill = makeOpenCliSkill("google search", (i) => bnbotCommand(["google", "search"], [query(i)], { limit: limit(i), lang: str(i, ["lang", "language"]) }));
export const ggSuggestSkill = makeOpenCliSkill("google suggest", (i) => bnbotCommand(["google", "suggest"], [query(i)], { limit: limit(i), lang: str(i, ["lang", "language"]) }));
export const ggNewsSkill = makeOpenCliSkill("google news", (i) => bnbotCommand(["google", "news"], str(i, ["query", "keyword", "q"]) ? [str(i, ["query", "keyword", "q"])] : [], {
    limit: limit(i),
    lang: str(i, ["lang", "language"]),
    region: str(i, ["region", "country"]),
}));
export const ggTrendsSkill = makeOpenCliSkill("google trends", (i) => bnbotCommand(["google", "trends"], [], { limit: limit(i), region: str(i, ["region", "geo", "country"]) }));
export const wxmpArticleSearchSkill = makeOpenCliSkill("weixin article search", (i) => bnbotCommand(["weixin", "search"], [query(i)], { limit: limit(i), page: num(i, ["page"]) }));
export const wxmpArticleSkill = makeOpenCliSkill("weixin article", (i) => bnbotCommand(["weixin", "article"], [reqStr(i, ["url", "article_url", "articleUrl"], "url")]));
function hnList(command) {
    return makeOpenCliSkill(`hackernews ${command}`, (i) => bnbotCommand(["hackernews", command], [], { limit: limit(i) }));
}
export const hnTopSkill = hnList("top");
export const hnNewSkill = hnList("new");
export const hnBestSkill = hnList("best");
export const hnAskSkill = hnList("ask");
export const hnShowSkill = hnList("show");
export const hnJobsSkill = hnList("jobs");
export const hnSearchSkill = makeOpenCliSkill("hackernews search", (i) => bnbotCommand(["hackernews", "search"], [query(i)], { limit: limit(i), sort: str(i, ["sort"]) }));
export const hnUserSkill = makeOpenCliSkill("hackernews user", (i) => bnbotCommand(["hackernews", "user"], [reqStr(i, ["username", "user"], "username")]));
export const hnReadSkill = makeOpenCliSkill("hackernews read", (i) => bnbotCommand(["hackernews", "read"], [reqStr(i, ["id", "item_id", "itemId"], "id")], {
    limit: limit(i),
    depth: num(i, ["depth"]),
    replies: num(i, ["replies"]),
    "max-length": num(i, ["maxLength", "max_length"]),
}));
export const wikiSearchSkill = makeOpenCliSkill("wikipedia search", (i) => bnbotCommand(["wikipedia", "search"], [query(i)], { limit: limit(i), lang: str(i, ["lang", "language"]) }));
export const wikiSummarySkill = makeOpenCliSkill("wikipedia summary", (i) => bnbotCommand(["wikipedia", "summary"], [reqStr(i, ["title", "page"], "title")], { lang: str(i, ["lang", "language"]) }));
export const wikiRandomSkill = makeOpenCliSkill("wikipedia random", (i) => bnbotCommand(["wikipedia", "random"], [], { lang: str(i, ["lang", "language"]) }));
export const wikiTrendingSkill = makeOpenCliSkill("wikipedia trending", (i) => bnbotCommand(["wikipedia", "trending"], [], { limit: limit(i), lang: str(i, ["lang", "language"]) }));
export const wikiPageSkill = makeOpenCliSkill("wikipedia page", (i) => bnbotCommand(["wikipedia", "page"], [reqStr(i, ["title", "page"], "title")], {
    lang: str(i, ["lang", "language"]),
    paragraphs: num(i, ["paragraphs"]),
}));
export const yfQuoteSkill = makeOpenCliSkill("yahoo finance quote", (i) => bnbotCommand(["yahoo-finance", "quote"], [reqStr(i, ["symbol", "ticker"], "symbol")]));
export const zhSearchSkill = makeOpenCliSkill("zhihu search", (i) => bnbotCommand(["zhihu", "search"], [query(i)], { limit: limit(i) }));
export const zhHotSkill = makeOpenCliSkill("zhihu hot", (i) => bnbotCommand(["zhihu", "hot"], [], { limit: limit(i) }));
export const zhRecommendSkill = makeOpenCliSkill("zhihu recommend", (i) => bnbotCommand(["zhihu", "recommend"], [], { limit: limit(i) }));
export const zhQuestionSkill = makeOpenCliSkill("zhihu question", (i) => bnbotCommand(["zhihu", "question"], [reqStr(i, ["question_id", "questionId", "id"], "question_id")], { limit: limit(i) }));
export const zhAnswerDetailSkill = makeOpenCliSkill("zhihu answer detail", (i) => bnbotCommand(["zhihu", "answer-detail"], [reqStr(i, ["id", "answer_id", "answerId", "url"], "id")], {
    "max-content": num(i, ["maxContent", "max_content"]),
}));
export const zhAnswerCommentsSkill = makeOpenCliSkill("zhihu answer comments", (i) => bnbotCommand(["zhihu", "answer-comments"], [reqStr(i, ["id", "answer_id", "answerId", "url"], "id")], {
    limit: limit(i),
    "replies-limit": num(i, ["repliesLimit", "replies_limit"]),
}));
export const bbcNewsSkill = makeOpenCliSkill("bbc news", (i) => bnbotCommand(["bbc", "news"], [], { limit: limit(i) }));
export const bbcTopicSkill = makeOpenCliSkill("bbc topic", (i) => bnbotCommand(["bbc", "topic"], [reqStr(i, ["topic"], "topic")], { limit: limit(i) }));
function bbgFeed(command) {
    return makeOpenCliSkill(`bloomberg ${command}`, (i) => bnbotCommand(["bloomberg", command], [], { limit: limit(i) }));
}
export const bbgMainSkill = bbgFeed("main");
export const bbgMarketsSkill = bbgFeed("markets");
export const bbgEconomicsSkill = bbgFeed("economics");
export const bbgIndustriesSkill = bbgFeed("industries");
export const bbgTechSkill = bbgFeed("tech");
export const bbgPoliticsSkill = bbgFeed("politics");
export const bbgBusinessweekSkill = bbgFeed("businessweek");
export const bbgOpinionsSkill = bbgFeed("opinions");
export const bbgFeedsSkill = makeOpenCliSkill("bloomberg feeds", () => bnbotCommand(["bloomberg", "feeds"]));
export const medSearchSkill = makeOpenCliSkill("medium search", (i) => bnbotCommand(["medium", "search"], [query(i)], { limit: limit(i) }));
export const medTagSkill = makeOpenCliSkill("medium tag", (i) => bnbotCommand(["medium", "tag"], [reqStr(i, ["tag", "topic"], "tag")], { limit: limit(i) }));
export const medFeedSkill = openSkill("medium feed", ["medium", "feed"], () => [], (i) => ({
    limit: limit(i),
    topic: str(i, ["topic", "tag"]),
}));
export const medUserSkill = openSkill("medium user", ["medium", "user"], (i) => [
    reqStr(i, ["username", "user"], "username"),
], (i) => ({ limit: limit(i) }));
export const subSearchSkill = makeOpenCliSkill("substack search", (i) => bnbotCommand(["substack", "search"], [query(i)], {
    limit: limit(i),
    type: str(i, ["type", "kind"]),
}));
export const subPublicationSkill = makeOpenCliSkill("substack publication", (i) => bnbotCommand(["substack", "publication"], [reqStr(i, ["url", "publication"], "url")], { limit: limit(i) }));
export const subFeedSkill = openSkill("substack feed", ["substack", "feed"], () => [], (i) => ({
    limit: limit(i),
    category: str(i, ["category"]),
}));
export const bbgArticleSkill = openSkill("bloomberg article", ["bloomberg", "news"], (i) => [
    reqStr(i, ["url", "link", "path"], "url"),
]);
export const wbHotSkill = openSkill("weibo hot", ["weibo", "hot"], () => [], (i) => ({ limit: limit(i) }));
export const wbSearchSkill = openSkill("weibo search", ["weibo", "search"], (i) => [query(i)], (i) => ({
    limit: limit(i),
}));
export const wbFeedSkill = openSkill("weibo feed", ["weibo", "feed"], () => [], (i) => ({
    type: str(i, ["type"]),
    limit: limit(i),
}));
export const wbUserSkill = openSkill("weibo user", ["weibo", "user"], (i) => [id(i)]);
export const wbPostSkill = openSkill("weibo post", ["weibo", "post"], (i) => [id(i)]);
export const wbCommentsSkill = openSkill("weibo comments", ["weibo", "comments"], (i) => [id(i)], (i) => ({
    limit: limit(i),
}));
export const kr36NewsSkill = openSkill("36kr news", ["36kr", "news"], () => [], (i) => ({ limit: limit(i) }));
export const kr36HotSkill = openSkill("36kr hot", ["36kr", "hot"], () => [], (i) => ({
    limit: limit(i),
    type: str(i, ["type", "list_type", "listType"]),
}));
export const kr36SearchSkill = openSkill("36kr search", ["36kr", "search"], (i) => [query(i)], (i) => ({
    limit: limit(i),
}));
export const kr36ArticleSkill = openSkill("36kr article", ["36kr", "article"], (i) => [
    reqStr(i, ["id", "url"], "id"),
]);
export const dbSearchSkill = openSkill("douban search", ["douban", "search"], (i) => [query(i)], (i) => ({
    limit: limit(i),
    type: str(i, ["type"]),
}));
export const dbMovieHotSkill = openSkill("douban movie hot", ["douban", "movie-hot"], () => [], (i) => ({
    limit: limit(i),
}));
export const dbBookHotSkill = openSkill("douban book hot", ["douban", "book-hot"], () => [], (i) => ({
    limit: limit(i),
}));
export const dbTop250Skill = makeOpenCliSkill("douban top250", (i) => bnbotCommand(["douban", "top250"], [], { limit: limit(i) }));
export const dbPhotosSkill = openSkill("douban photos", ["douban", "photos"], (i) => [id(i)], (i) => ({
    limit: limit(i),
    type: str(i, ["type"]),
}));
export const sfNewsSkill = openSkill("sinafinance news", ["sinafinance", "news"], () => [], (i) => ({
    limit: limit(i),
    type: str(i, ["type"]),
}));
export const sfRollingNewsSkill = openSkill("sinafinance rolling news", ["sinafinance", "rolling-news"]);
export const sfStockSkill = openSkill("sinafinance stock", ["sinafinance", "stock"], (i) => [
    reqStr(i, ["key", "query", "symbol", "ticker"], "key"),
], (i) => ({ market: str(i, ["market"]) }));
export const jkFeedSkill = openSkill("jike feed", ["jike", "feed"], () => [], (i) => ({ limit: limit(i) }));
export const jkSearchSkill = openSkill("jike search", ["jike", "search"], (i) => [query(i)], (i) => ({
    limit: limit(i),
}));
export const xqSearchSkill = openSkill("xueqiu search", ["xueqiu", "search"], (i) => [query(i)], (i) => ({
    limit: limit(i),
}));
export const xqHotSkill = openSkill("xueqiu hot", ["xueqiu", "hot"], () => [], (i) => ({ limit: limit(i) }));
export const xqHotStockSkill = openSkill("xueqiu hot stock", ["xueqiu", "hot-stock"], () => [], (i) => ({
    limit: limit(i),
    type: str(i, ["type"]),
}));
export const xqStockSkill = openSkill("xueqiu stock", ["xueqiu", "stock"], (i) => [symbol(i)]);
export const xqCommentsSkill = openSkill("xueqiu comments", ["xueqiu", "comments"], (i) => [symbol(i)], (i) => ({
    limit: limit(i),
}));
export const xqKlineSkill = openSkill("xueqiu kline", ["xueqiu", "kline"], (i) => [symbol(i)], (i) => ({
    days: num(i, ["days"]),
}));
export const xqEarningsDateSkill = openSkill("xueqiu earnings date", ["xueqiu", "earnings-date"], (i) => [
    symbol(i),
], (i) => ({
    limit: limit(i),
    next: str(i, ["next"]),
}));
export const xyzPodcastSkill = openSkill("xiaoyuzhou podcast", ["xiaoyuzhou", "podcast"], (i) => [id(i)]);
export const xyzPodcastEpisodesSkill = openSkill("xiaoyuzhou podcast episodes", ["xiaoyuzhou", "podcast-episodes"], (i) => [
    reqStr(i, ["podcast_id", "podcastId", "id"], "podcast_id"),
], (i) => ({ limit: limit(i) }));
export const xyzEpisodeSkill = openSkill("xiaoyuzhou episode", ["xiaoyuzhou", "episode"], (i) => [id(i)]);
export const fbSearchSkill = openSkill("facebook search", ["facebook", "search"], (i) => [query(i)], (i) => ({
    limit: limit(i),
}));
export const fbProfileSkill = openSkill("facebook profile", ["facebook", "profile"], (i) => [
    reqStr(i, ["username", "user"], "username"),
]);
export const fbEventsSkill = openSkill("facebook events", ["facebook", "events"], () => [], (i) => ({ limit: limit(i) }));
export const wrSearchSkill = openSkill("weread search", ["weread", "search"], (i) => [query(i)], (i) => ({
    limit: limit(i),
}));
export const wrRankingSkill = openSkill("weread ranking", ["weread", "ranking"], (i) => {
    const category = str(i, ["category"]);
    return category ? [category] : [];
}, (i) => ({ limit: limit(i) }));
export const wrBookSkill = openSkill("weread book", ["weread", "book"], (i) => [
    reqStr(i, ["book_id", "bookId", "id"], "book_id"),
]);
export const ctSearchSkill = makeOpenCliSkill("ctrip search", (i) => bnbotCommand(["ctrip", "search"], [query(i)], { limit: limit(i) }));
export const ctHotelSuggestSkill = makeOpenCliSkill("ctrip hotel suggest", (i) => bnbotCommand(["ctrip", "hotel-suggest"], [query(i)], { limit: limit(i) }));
export const ctHotelSearchSkill = openSkill("ctrip hotel search", ["ctrip", "hotel-search"], (i) => [
    reqStr(i, ["city", "city_id", "cityId"], "city"),
], (i) => ({
    checkin: reqStr(i, ["checkin", "check_in", "checkIn"], "checkin"),
    checkout: reqStr(i, ["checkout", "check_out", "checkOut"], "checkout"),
    limit: limit(i),
}));
export const ctFlightSkill = openSkill("ctrip flight", ["ctrip", "flight"], (i) => [
    reqStr(i, ["from", "from_iata", "fromIata"], "from"),
    reqStr(i, ["to", "to_iata", "toIata"], "to"),
], (i) => ({
    date: reqStr(i, ["date", "departure_date", "departureDate"], "date"),
    limit: limit(i),
}));
