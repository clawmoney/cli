import type { SkillHandler } from "../../types.js";
/**
 * `x.tweet_article` — backs /TweetArticle. Returns the long-form
 * Article attached to a tweet (title, content, author, cover image).
 * Throws upstream if the tweet has no Article attached.
 */
export declare const xTweetArticleSkill: SkillHandler;
