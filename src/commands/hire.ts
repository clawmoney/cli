import chalk from 'chalk';
import ora from 'ora';
import { apiPost } from '../utils/api.js';
import { awalExec } from '../utils/awal.js';
import { requireConfig } from '../utils/config.js';
import { prompt, confirm } from '../utils/prompt.js';

interface SubmitOptions {
  url: string;
  text?: string;
}

interface VerifyOptions {
  witness?: boolean;
}

export async function hireSubmitCommand(
  taskId: string,
  options: SubmitOptions
): Promise<void> {
  const config = requireConfig();

  console.log('');
  const spinner = ora(`Submitting proof for task ${taskId}...`).start();

  try {
    const body: Record<string, string> = {
      proof_url: options.url,
    };
    if (options.text) {
      body.content = options.text;
    }

    const resp = await apiPost<{ id?: string; message?: string }>(
      `/api/v1/hire/${taskId}/submit`,
      body,
      config.api_key
    );

    if (!resp.ok) {
      spinner.fail('Submission failed');
      console.error(chalk.red(JSON.stringify(resp.data)));
      return;
    }

    spinner.succeed('Proof submitted successfully');
    if (resp.data.id) {
      console.log(chalk.dim(`  Submission ID: ${resp.data.id}`));
    }
    if (resp.data.message) {
      console.log(chalk.dim(`  ${resp.data.message}`));
    }
  } catch (err) {
    spinner.fail('Submission failed');
    console.error(chalk.red((err as Error).message));
  }
  console.log('');
}

export async function hireVerifyCommand(
  taskId: string,
  options: VerifyOptions
): Promise<void> {
  const config = requireConfig();

  console.log('');

  if (options.witness) {
    // Witness verification via x402
    const tweetUrl = await prompt(
      chalk.cyan('? ') + 'Enter the tweet URL to verify: '
    );

    if (!tweetUrl) {
      console.log(chalk.red('Tweet URL is required for witness verification.'));
      return;
    }

    // Extract tweet ID from URL
    const tweetIdMatch = tweetUrl.match(/status\/(\d+)/);
    if (!tweetIdMatch) {
      console.log(chalk.red('Could not extract tweet ID from URL.'));
      return;
    }
    const tweetId = tweetIdMatch[1];

    const witnessSpinner = ora('Paying for witness verification via x402...').start();
    try {
      const witnessResult = await awalExec([
        'x402',
        'pay',
        `https://witness.bnbot.ai/x/${tweetId}`,
      ]);

      witnessSpinner.succeed('Witness verification paid');
      console.log(chalk.dim(`  Response: ${JSON.stringify(witnessResult.data)}`));

      // Submit the witness proof
      const submitSpinner = ora('Submitting witness proof...').start();
      const resp = await apiPost(
        `/api/v1/hire/${taskId}/verify`,
        {
          type: 'witness',
          tweet_id: tweetId,
          witness_data: witnessResult.data,
        },
        config.api_key
      );

      if (!resp.ok) {
        submitSpinner.fail('Witness verification submission failed');
        console.error(chalk.red(JSON.stringify(resp.data)));
      } else {
        submitSpinner.succeed('Witness verification submitted');
      }
    } catch (err) {
      witnessSpinner.fail('Witness verification failed');
      console.error(chalk.red((err as Error).message));
    }
  } else {
    // Manual verification
    console.log(chalk.bold(`  Manual verification for task ${taskId}`));
    console.log('');

    const approved = await confirm('Approve this submission?', false);

    const spinner = ora('Submitting verification...').start();
    try {
      const resp = await apiPost(
        `/api/v1/hire/${taskId}/verify`,
        {
          type: 'manual',
          approved,
        },
        config.api_key
      );

      if (!resp.ok) {
        spinner.fail('Verification submission failed');
        console.error(chalk.red(JSON.stringify(resp.data)));
      } else {
        spinner.succeed(`Verification submitted: ${approved ? 'APPROVED' : 'REJECTED'}`);
      }
    } catch (err) {
      spinner.fail('Verification failed');
      console.error(chalk.red((err as Error).message));
    }
  }
  console.log('');
}
