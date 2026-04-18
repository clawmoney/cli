import chalk from 'chalk';
import ora from 'ora';
import { apiGet, apiPost } from '../utils/api.js';
import { requireConfig } from '../utils/config.js';
import { CdpProvider } from '../wallet/cdp-provider.js';
import { x402PayJson } from '../wallet/x402-client.js';

interface SubmitOptions {
  url: string;
  platform?: string;
  text?: string;
}

interface VerifyOptions {
  witness?: boolean;
  relevance: string;
  quality: string;
  vote?: string;
}

export async function promoteSubmitCommand(
  taskId: string,
  options: SubmitOptions
): Promise<void> {
  const config = requireConfig();

  // 自动检测平台（从 task 获取）
  let platform = options.platform;
  if (!platform) {
    try {
      const taskResp = await apiGet<{ platform?: string }>(`/api/v1/promote/${taskId}`, config.api_key);
      if (taskResp.ok && taskResp.data.platform) {
        platform = taskResp.data.platform;
      }
    } catch { /* ignore */ }
  }
  if (!platform) platform = 'twitter';

  console.log('');
  const spinner = ora(`Submitting proof for task ${taskId.slice(0, 8)}...`).start();

  try {
    const body: Record<string, string> = {
      platform,
      proof_url: options.url,
    };
    if (options.text) {
      body.content_text = options.text;
    }

    const resp = await apiPost<{ id?: string; detail?: string }>(
      `/api/v1/promote/${taskId}/submit`,
      body,
      config.api_key
    );

    if (!resp.ok) {
      spinner.fail('Submission failed');
      const detail = typeof resp.data === 'object' ? (resp.data.detail || JSON.stringify(resp.data)) : String(resp.data);
      console.error(chalk.red(`  ${detail}`));
      return;
    }

    spinner.succeed('Proof submitted');
    if (resp.data.id) {
      console.log(chalk.dim(`  Submission ID: ${resp.data.id}`));
    }
  } catch (err) {
    spinner.fail('Submission failed');
    console.error(chalk.red((err as Error).message));
  }
  console.log('');
}

export async function promoteVerifyCommand(
  submissionId: string,
  options: VerifyOptions
): Promise<void> {
  const config = requireConfig();

  console.log('');

  if (options.witness) {
    // Get submission to extract proof_url
    const subSpinner = ora('Fetching submission...').start();
    let proofUrl = '';
    try {
      // Try to get submission details - submissionId might be used directly
      const resp = await apiGet<{ proof_url?: string }>(`/api/v1/promote/submissions/${submissionId}`, config.api_key);
      if (resp.ok && resp.data.proof_url) {
        proofUrl = resp.data.proof_url;
        subSpinner.succeed(`Proof URL: ${proofUrl}`);
      } else {
        subSpinner.warn('Could not fetch submission, will need tweet ID');
      }
    } catch {
      subSpinner.warn('Could not fetch submission');
    }

    // Extract tweet ID
    let tweetId = '';
    if (proofUrl) {
      const match = proofUrl.match(/status\/(\d+)/);
      if (match) tweetId = match[1];
    }
    if (!tweetId) {
      console.error(chalk.red('  Could not extract tweet ID from proof URL'));
      return;
    }

    // Fetch witness proof via x402
    const witnessSpinner = ora('Fetching witness proof via x402 ($0.01)...').start();
    let witnessData: Record<string, unknown>;
    try {
      const wallet = new CdpProvider(config.api_key);
      witnessData = await x402PayJson<Record<string, unknown>>(
        wallet,
        `https://witness.bnbot.ai/x/${tweetId}`
      );
      witnessSpinner.succeed('Witness proof obtained');
    } catch (err) {
      witnessSpinner.fail('Witness fetch failed');
      console.error(chalk.red((err as Error).message));
      return;
    }

    // Parse witness response — x402PayJson returns the response body directly.
    const wdInner = witnessData?.data as Record<string, unknown> | undefined;
    const proof = (wdInner?.proof ?? witnessData?.proof) as {
      payload?: string;
      signature?: string;
      signer?: string;
      timestamp?: number;
    } | undefined;
    if (!proof) {
      console.error(chalk.red('  No proof in witness response'));
      console.log(chalk.dim(`  Raw: ${JSON.stringify(witnessData).slice(0, 200)}`));
      return;
    }

    // Submit witness verification
    const vote = options.vote || 'approve';
    const relevanceScore = parseInt(options.relevance, 10);
    const qualityScore = parseInt(options.quality, 10);
    const verifySpinner = ora(`Submitting witness verification (${vote}, R:${relevanceScore} Q:${qualityScore})...`).start();
    try {
      const resp = await apiPost<{ id?: string; detail?: string }>(
        `/api/v1/promote/submissions/${submissionId}/verify`,
        {
          vote,
          relevance_score: relevanceScore,
          quality_score: qualityScore,
          tweet_proof: {
            payload: proof.payload,
            signature: proof.signature,
            signer: proof.signer,
            timestamp: proof.timestamp,
          },
        },
        config.api_key
      );

      if (!resp.ok) {
        verifySpinner.fail('Verification failed');
        const detail = typeof resp.data === 'object' ? (resp.data.detail || JSON.stringify(resp.data)) : String(resp.data);
        console.error(chalk.red(`  ${detail}`));
      } else {
        verifySpinner.succeed('Witness verification submitted');
        if (resp.data.id) {
          console.log(chalk.dim(`  Verification ID: ${resp.data.id}`));
        }
      }
    } catch (err) {
      verifySpinner.fail('Verification failed');
      console.error(chalk.red((err as Error).message));
    }
  } else {
    // Manual verification
    const vote = options.vote || 'approve';
    const relevanceScore = parseInt(options.relevance, 10);
    const qualityScore = parseInt(options.quality, 10);
    const spinner = ora(`Submitting manual verification (${vote}, R:${relevanceScore} Q:${qualityScore})...`).start();
    try {
      const resp = await apiPost<{ id?: string; detail?: string }>(
        `/api/v1/promote/submissions/${submissionId}/verify`,
        {
          vote,
          relevance_score: relevanceScore,
          quality_score: qualityScore,
          views: 0,
          likes: 0,
          comments: 0,
        },
        config.api_key
      );

      if (!resp.ok) {
        spinner.fail('Verification failed');
        const detail = typeof resp.data === 'object' ? (resp.data.detail || JSON.stringify(resp.data)) : String(resp.data);
        console.error(chalk.red(`  ${detail}`));
      } else {
        spinner.succeed('Manual verification submitted');
        if (resp.data.id) {
          console.log(chalk.dim(`  Verification ID: ${resp.data.id}`));
        }
      }
    } catch (err) {
      spinner.fail('Verification failed');
      console.error(chalk.red((err as Error).message));
    }
  }
  console.log('');
}
