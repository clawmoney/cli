import chalk from 'chalk';
import { sendAction, BridgeServer } from '../utils/bridge.js';
export async function tweetCommand(text, options) {
    const isDraft = options.draft || false;
    const preview = text.slice(0, 80) + (text.length > 80 ? '...' : '');
    console.log(chalk.dim(`${isDraft ? 'Drafting' : 'Posting'}: "${preview}"`));
    try {
        const params = { text, draftOnly: isDraft };
        if (options.media)
            params.media = [{ type: 'image', url: options.media }];
        const result = await sendAction('post_tweet', params);
        if (!result.success) {
            console.error(chalk.red(result.error || 'Failed'));
            process.exit(1);
        }
        if (isDraft) {
            console.log(chalk.green('Draft ready — review and post manually'));
        }
        else {
            const data = result.data;
            const url = data?.tweetUrl || data?.url || data?.tweet_url;
            if (url) {
                console.log(chalk.green('Tweet posted'));
                console.log(url);
            }
            else {
                console.log(chalk.green('Tweet posted'));
            }
        }
    }
    catch (err) {
        console.error(chalk.red(err.message));
        process.exit(1);
    }
}
export async function likeCommand(url) {
    console.log(chalk.dim(`Liking: ${url}`));
    try {
        const result = await sendAction('like_tweet', { tweetUrl: url });
        if (!result.success) {
            console.error(chalk.red(result.error || 'Failed'));
            process.exit(1);
        }
        console.log(chalk.green('Liked'));
    }
    catch (err) {
        console.error(chalk.red(err.message));
        process.exit(1);
    }
}
export async function retweetCommand(url) {
    console.log(chalk.dim(`Retweeting: ${url}`));
    try {
        const result = await sendAction('retweet', { tweetUrl: url });
        if (!result.success) {
            console.error(chalk.red(result.error || 'Failed'));
            process.exit(1);
        }
        console.log(chalk.green('Retweeted'));
    }
    catch (err) {
        console.error(chalk.red(err.message));
        process.exit(1);
    }
}
export async function replyCommand(url, text, options) {
    console.log(chalk.dim(`Replying to: ${url}`));
    try {
        const params = { tweetUrl: url, text };
        if (options.media)
            params.image = options.media;
        const result = await sendAction('submit_reply', params);
        if (!result.success) {
            console.error(chalk.red(result.error || 'Failed'));
            process.exit(1);
        }
        console.log(chalk.green('Replied'));
    }
    catch (err) {
        console.error(chalk.red(err.message));
        process.exit(1);
    }
}
export async function followCommand(username) {
    console.log(chalk.dim(`Following: @${username}`));
    try {
        const result = await sendAction('follow_user', { username });
        if (!result.success) {
            console.error(chalk.red(result.error || 'Failed'));
            process.exit(1);
        }
        console.log(chalk.green('Followed'));
    }
    catch (err) {
        console.error(chalk.red(err.message));
        process.exit(1);
    }
}
export async function closeCommand(options) {
    const isSave = options.save || false;
    console.log(chalk.dim(isSave ? 'Saving draft and closing...' : 'Discarding and closing...'));
    try {
        const result = await sendAction('close_composer', { save: isSave });
        if (!result.success) {
            console.error(chalk.red(result.error || 'Failed'));
            process.exit(1);
        }
        const data = result.data;
        if (data?.action === 'saved_as_draft') {
            console.log(chalk.green('Saved as draft'));
        }
        else if (data?.action === 'discarded') {
            console.log(chalk.green('Discarded'));
        }
        else {
            console.log(chalk.green('Closed'));
        }
    }
    catch (err) {
        console.error(chalk.red(err.message));
        process.exit(1);
    }
}
export async function statusCommand() {
    try {
        const result = await sendAction('get_extension_status', {});
        if (result.success) {
            console.log(chalk.green('Extension connected'));
            if (result.data)
                console.log(chalk.dim(JSON.stringify(result.data, null, 2)));
        }
        else {
            console.log(chalk.yellow(result.error || 'Extension not connected'));
        }
    }
    catch (err) {
        console.log(chalk.red('Bridge not running or extension not connected'));
        console.log(chalk.dim(err.message));
    }
}
export async function serveCommand(options) {
    const port = parseInt(options.port || '18900', 10);
    const server = new BridgeServer(port);
    try {
        await server.start();
    }
    catch (err) {
        console.error(chalk.red(err.message));
        process.exit(1);
    }
    console.log(chalk.green(`Bridge server running on ws://127.0.0.1:${port}`));
    console.log(chalk.dim('Waiting for Chrome Extension...'));
    const check = setInterval(() => {
        if (server.isExtensionConnected()) {
            console.log(chalk.green(`Extension connected (v${server.getExtensionVersion() || '?'})`));
            clearInterval(check);
        }
    }, 2000);
    const shutdown = () => { clearInterval(check); server.stop(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
