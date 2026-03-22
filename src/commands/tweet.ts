import chalk from 'chalk';
import { spawn } from 'node:child_process';

interface TweetOptions {
  media?: string;
  draft?: boolean;
}

/**
 * Post a tweet by delegating to bnbot-cli.
 */
export async function tweetCommand(
  text: string,
  options: TweetOptions
): Promise<void> {
  const args = ['bnbot', 'tweet', text];
  if (options.draft) args.push('--draft');
  if (options.media) args.push('--media', options.media);

  try {
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn('npx', args, {
        stdio: 'inherit',
        shell: true,
      });
      child.on('close', (code) => resolve(code || 0));
      child.on('error', reject);
    });
    if (code !== 0) process.exit(code);
  } catch (err) {
    console.error(chalk.red((err as Error).message));
    console.log(chalk.dim('  Make sure bnbot-cli is installed: npm install -g bnbot-cli'));
    process.exit(1);
  }
}
