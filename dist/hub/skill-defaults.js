/**
 * Default marketplace listing metadata for each built-in skill.
 *
 * `syncSkillRegistry` reads this table to figure out which skills to
 * auto-publish to the marketplace on `spareai market start`. Anything
 * not in this map is intentionally not auto-registered — typically
 * because it requires manual configuration (e.g. chatgpt.ask) or is a
 * back-compat alias.
 *
 * `requiresPlatform` is a forward-looking field for the eventual
 * platform-login check. v1 of syncSkillRegistry ignores it and
 * registers everything.
 */
function batch(prefix, category, price, requiresPlatform, items) {
    const out = {};
    for (const [suffix, description] of Object.entries(items)) {
        out[`${prefix}.${suffix}`] = {
            category,
            description,
            price,
            skill_type: "instant",
            ...(requiresPlatform ? { requiresPlatform } : {}),
        };
    }
    return out;
}
export const SKILL_DEFAULTS = {
    // ── Tier 5: utility ──
    echo: {
        category: "chat",
        description: "Echo input back (test skill)",
        price: 0,
        skill_type: "instant",
    },
    // ── Tier 1: public content ──
    // Wikipedia
    ...batch("wiki", "reference/wikipedia", 0.004, undefined, {
        search: "Wikipedia article search",
        summary: "Wikipedia article summary",
        random: "Random Wikipedia article",
        trending: "Trending Wikipedia articles",
        page: "Wikipedia full page",
    }),
    // Yahoo Finance
    "yf.quote": {
        category: "finance/yahoo",
        description: "Yahoo Finance stock quote",
        price: 0.001,
        skill_type: "instant",
    },
    // Hacker News
    ...batch("hn", "community/hackernews", 0.001, undefined, {
        top: "Hacker News top stories",
        new: "Hacker News newest stories",
        best: "Hacker News best stories",
        ask: "Hacker News Ask HN",
        show: "Hacker News Show HN",
        jobs: "Hacker News jobs",
        search: "Hacker News keyword search",
        user: "Hacker News user profile",
        read: "Hacker News story detail + comments",
    }),
    // Reddit
    ...batch("rd", "community/reddit", 0.002, undefined, {
        popular_posts: "Reddit popular posts",
        top_popular_posts: "Reddit top popular posts",
        rising_popular_posts: "Reddit rising posts",
        best_popular_posts: "Reddit best posts",
        popular_posts_by_country: "Reddit popular posts by country",
        posts_by_subreddit: "Posts in a subreddit",
        top_posts_by_subreddit: "Top posts in a subreddit",
        controversial_posts_by_subreddit: "Controversial posts in a subreddit",
        comments_by_subreddit: "Comments in a subreddit",
        subreddit_info: "Subreddit metadata",
        subreddit_rules: "Subreddit rules",
        similar_subreddits: "Similar subreddits",
        new_subreddits: "Newly created subreddits",
        popular_subreddits: "Popular subreddits",
        posts_by_username: "User's posts",
        top_posts_by_username: "User's top posts",
        comments_by_username: "User's comments",
        top_comments_by_username: "User's top comments",
        user_overview: "Reddit user overview",
        user_post_rank_in_subreddit: "User rank in a subreddit",
        profile: "Reddit user profile",
        user_stats: "Reddit user statistics",
        search_users: "Search Reddit users",
        search_posts: "Search Reddit posts",
        search_subreddits: "Search subreddits",
        post_details: "Reddit post detail",
        post_comments: "Reddit post comments",
        post_comments_with_sort: "Reddit post comments (sorted)",
        post_duplicates: "Reddit post duplicates",
    }),
    // Bilibili (B 站)
    ...batch("bili", "media/bilibili", 0.002, undefined, {
        search: "Bilibili search",
        hot: "Bilibili trending",
        ranking: "Bilibili rankings",
        video: "Bilibili video detail",
        subtitle: "Bilibili video subtitle",
        comments: "Bilibili video comments",
        following: "Bilibili user following",
        user_videos: "Bilibili user videos",
        feed: "Bilibili dynamic feed",
        feed_detail: "Bilibili dynamic detail",
        download: "Bilibili video download",
    }),
    // Douban (豆瓣)
    ...batch("db", "media/douban", 0.002, undefined, {
        search: "Douban search",
        movie_hot: "Douban hot movies",
        book_hot: "Douban hot books",
        top250: "Douban top 250",
        photos: "Douban photos",
    }),
    // Sina Finance (新浪财经)
    ...batch("sf", "finance/sina", 0.002, undefined, {
        news: "Sina Finance news",
        rolling_news: "Sina Finance rolling news",
        stock: "Sina Finance stock quote",
    }),
    // Xueqiu (雪球)
    ...batch("xq", "finance/xueqiu", 0.002, undefined, {
        search: "Xueqiu search",
        hot: "Xueqiu hot topics",
        hot_stock: "Xueqiu hot stocks",
        stock: "Xueqiu stock detail",
        comments: "Xueqiu stock comments",
        kline: "Xueqiu K-line",
        earnings_date: "Xueqiu earnings calendar",
    }),
    // Xiaoyuzhou (小宇宙)
    ...batch("xyz", "media/xiaoyuzhou", 0.002, undefined, {
        podcast: "Xiaoyuzhou podcast info",
        podcast_episodes: "Xiaoyuzhou podcast episodes",
        episode: "Xiaoyuzhou episode detail",
    }),
    // WeRead (微信读书)
    ...batch("wr", "read/weread", 0.002, undefined, {
        search: "WeRead book search",
        ranking: "WeRead rankings",
        book: "WeRead book detail",
    }),
    // Ctrip (携程)
    ...batch("ct", "travel/ctrip", 0.002, undefined, {
        search: "Ctrip search",
        hotel_suggest: "Ctrip hotel suggestions",
        hotel_search: "Ctrip hotel search",
        flight: "Ctrip flight search",
    }),
    // Jike (即刻)
    ...batch("jk", "community/jike", 0.002, undefined, {
        feed: "Jike feed",
        search: "Jike search",
    }),
    // Bloomberg
    ...batch("bbg", "news/bloomberg", 0.002, undefined, {
        main: "Bloomberg homepage",
        markets: "Bloomberg markets",
        economics: "Bloomberg economics",
        industries: "Bloomberg industries",
        tech: "Bloomberg technology",
        politics: "Bloomberg politics",
        businessweek: "Bloomberg Businessweek",
        opinions: "Bloomberg opinions",
        feeds: "Bloomberg feeds",
        article: "Bloomberg article detail",
    }),
    // BBC
    ...batch("bbc", "news/bbc", 0.002, undefined, {
        news: "BBC news",
        topic: "BBC topic",
    }),
    // Medium
    ...batch("med", "news/medium", 0.002, undefined, {
        search: "Medium search",
        tag: "Medium articles by tag",
        feed: "Medium feed",
        user: "Medium user articles",
    }),
    // Substack
    ...batch("sub", "news/substack", 0.002, undefined, {
        search: "Substack search",
        publication: "Substack publication",
        feed: "Substack feed",
    }),
    // 36Kr
    ...batch("36kr", "news/36kr", 0.002, undefined, {
        news: "36Kr news",
        hot: "36Kr trending",
        search: "36Kr search",
        article: "36Kr article detail",
    }),
    // WXMP (微信公众号)
    ...batch("wxmp", "news/wxmp", 0.002, undefined, {
        article_search: "WeChat article search",
        article: "WeChat article detail",
    }),
    // ── Tier 2: Google search ──
    ...batch("gg", "search/google", 0.005, undefined, {
        search: "Google web search",
        suggest: "Google search suggestions",
        news: "Google news",
        trends: "Google Trends",
    }),
    // ── Tier 3: social platforms (login required) ──
    // X / Twitter — 0.0004
    ...batch("x", "social/x", 0.0004, "x", {
        search: "Search tweets on X",
        user_by_screen_name: "X user by screen name",
        user_tweets: "X user tweets",
        tweet: "X tweet detail",
        trends: "X trending topics",
        user_followers: "X user followers",
        user_following: "X user following",
        tweet_favoriters: "X tweet likers",
        tweet_retweeters: "X tweet retweeters",
        tweet_article: "X long-form article",
    }),
    // NB: x.search.legacy is a back-compat alias — not auto-registered.
    // YouTube — 0.002
    ...batch("yt", "social/youtube", 0.002, "youtube", {
        video_details: "YouTube video details",
        channel_details: "YouTube channel details",
        channel_videos: "YouTube channel videos",
        trending: "YouTube trending",
        channel_search: "YouTube channel search",
        video_streaming: "YouTube video streaming info",
        video_related: "YouTube related videos",
        video_comments: "YouTube comments",
        video_transcript: "YouTube video transcript",
    }),
    // TikTok — 0.002
    ...batch("tk", "social/tiktok", 0.002, "tiktok", {
        search_video: "TikTok video search",
        search_account: "TikTok account search",
        user_info: "TikTok user info",
        user_posts: "TikTok user posts",
        user_followers: "TikTok user followers",
        post_detail: "TikTok post detail",
        post_comments: "TikTok post comments",
        trending: "TikTok trending",
        video_download: "TikTok video download",
        challenge_info: "TikTok challenge info",
        challenge_posts: "TikTok challenge posts",
        music_info: "TikTok music info",
        music_posts: "TikTok music posts",
        music_unlimited_sounds: "TikTok unlimited sounds",
        user_info_region: "TikTok user info by region",
        user_info_by_id: "TikTok user info by ID",
        user_followings: "TikTok user followings",
        user_liked_posts: "TikTok user liked posts",
        user_playlist: "TikTok user playlist",
        user_repost: "TikTok user reposts",
        user_story: "TikTok user story",
        search_general: "TikTok general search",
        search_live: "TikTok live search",
        search_suggestions: "TikTok search suggestions",
        post_related: "TikTok related posts",
        post_explore: "TikTok explore feed",
        post_discover: "TikTok discover feed",
        ads_detail: "TikTok ad detail",
        ads_top: "TikTok top ads",
        trending_creator: "TikTok trending creators",
        trending_video: "TikTok trending videos",
        trending_hashtag: "TikTok trending hashtags",
        trending_song: "TikTok trending songs",
        trending_keyword: "TikTok trending keywords",
        trending_keyword_posts: "TikTok keyword posts",
        trending_keyword_sentence: "TikTok keyword sentences",
        commercial_music_library: "TikTok commercial music library",
        commercial_music_playlists: "TikTok commercial music playlists",
        commercial_music_playlist_detail: "TikTok commercial playlist detail",
        top_products: "TikTok top products",
        top_product_detail: "TikTok product detail",
        top_product_metrics: "TikTok product metrics",
        place_info: "TikTok place info",
        place_posts: "TikTok place posts",
        effect_info: "TikTok effect info",
        effect_posts: "TikTok effect posts",
        collection_info: "TikTok collection info",
        collection_posts: "TikTok collection posts",
        post_comment_replies: "TikTok comment replies",
        music_download: "TikTok music download",
        user_video_download_batch: "TikTok user video batch download",
    }),
    // Douyin (抖音) — 0.002
    ...batch("dy", "social/douyin", 0.002, "douyin", {
        user_info: "Douyin user info",
        user_posts: "Douyin user posts",
        user_liked_posts: "Douyin user liked posts",
        user_followers: "Douyin user followers",
        user_following: "Douyin user following",
        post_comments: "Douyin post comments",
        search_general: "Douyin general search",
        search_video: "Douyin video search",
        search_account: "Douyin account search",
        search_live: "Douyin live search",
        challenge_posts: "Douyin challenge posts",
        music_posts: "Douyin music posts",
    }),
    // Weibo (微博) — 0.002
    ...batch("wb", "social/weibo", 0.002, "weibo", {
        hot: "Weibo trending",
        search: "Weibo search",
        feed: "Weibo feed",
        user: "Weibo user",
        post: "Weibo post detail",
        comments: "Weibo comments",
    }),
    // Xiaohongshu (小红书) — 0.02
    ...batch("xhs", "social/xiaohongshu", 0.02, "xiaohongshu", {
        creator_hot_inspiration_feed: "XHS creator hot inspiration feed",
        product_recommendations: "XHS product recommendations",
        note_comments: "XHS note comments",
        search_groups: "XHS search groups",
        mixed_note_detail: "XHS mixed note detail",
        search_notes: "XHS search notes",
        product_detail: "XHS product detail",
        creator_inspiration_feed: "XHS creator inspiration feed",
        image_note_detail: "XHS image note detail",
    }),
    // Zhihu (知乎) — 0.01
    ...batch("zh", "social/zhihu", 0.01, "zhihu", {
        search: "Zhihu search",
        hot: "Zhihu trending",
        recommend: "Zhihu recommendations",
        question: "Zhihu question detail",
        answer_detail: "Zhihu answer detail",
        answer_comments: "Zhihu answer comments",
    }),
    // LinkedIn — 0.012
    "li.job_search": {
        category: "social/linkedin",
        description: "LinkedIn job search",
        price: 0.012,
        skill_type: "instant",
        requiresPlatform: "linkedin",
    },
    // Facebook — 0.01
    ...batch("fb", "social/facebook", 0.01, "facebook", {
        search: "Facebook search",
        profile: "Facebook profile",
        events: "Facebook events",
    }),
    // ── Tier 4: AI generation (chatgpt.ask intentionally skipped) ──
    "codex.image_generate": {
        category: "generation/image",
        description: "Codex Desktop image generation",
        price: 0.02,
        skill_type: "instant",
        requiresPlatform: "codex",
    },
    "chatgpt.image_generate": {
        category: "generation/image",
        description: "ChatGPT Desktop image generation",
        price: 0.02,
        skill_type: "instant",
        requiresPlatform: "chatgpt",
    },
    "chatgpt_web.image_generate": {
        category: "generation/image",
        description: "ChatGPT Web image generation",
        price: 0.02,
        skill_type: "instant",
        requiresPlatform: "chatgpt",
    },
    "gemini.image_generate": {
        category: "generation/image",
        description: "Gemini image generation",
        price: 0.03,
        skill_type: "instant",
    },
    "flow.image_generate": {
        category: "generation/image",
        description: "Google Labs Flow image generation",
        price: 0.01,
        skill_type: "instant",
        requiresPlatform: "google",
    },
    "flow.video_generate": {
        category: "generation/video",
        description: "Google Labs Flow video generation",
        price: 0.6,
        skill_type: "instant",
        requiresPlatform: "google",
    },
};
export function listDefaultSkillNames() {
    return Object.keys(SKILL_DEFAULTS);
}
