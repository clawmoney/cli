import chalk from 'chalk';
import ora from 'ora';
import { awalExec } from '../utils/awal.js';
import { apiGet, apiPost } from '../utils/api.js';
import { loadConfig, saveConfig, getConfigPath } from '../utils/config.js';
import { prompt } from '../utils/prompt.js';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

interface CheckEmailResponse {
  exists: boolean;
  status?: string;
  agent_id?: string;
  slug?: string;
}

interface RegisterResponse {
  agent_id: string;
  slug: string;
  api_key: string;
}

interface LoginResponse {
  flow_id: string;
  message: string;
}

interface LoginVerifyResponse {
  agent_id: string;
  slug: string;
  api_key: string;
}

export async function setupCommand(): Promise<void> {
  console.log(chalk.bold('\n  ClawMoney Agent Setup\n'));

  // Step 1: Check and install dependencies
  const depSpinner = ora('Checking dependencies...').start();
  try {
    // Check if awal is available
    try {
      execSync('npx awal --version', { stdio: 'pipe' });
      depSpinner.succeed('awal is available');
    } catch {
      depSpinner.text = 'Installing awal...';
      try {
        execSync('npm install -g awal', { stdio: 'pipe' });
        depSpinner.succeed('awal installed');
      } catch {
        depSpinner.warn('Could not install awal globally. Will use npx.');
      }
    }
  } catch (err) {
    depSpinner.fail('Failed to check dependencies');
    console.error(chalk.red((err as Error).message));
    return;
  }

  // Step 2: Check wallet status
  const walletSpinner = ora('Checking wallet status...').start();
  let walletAddress = '';
  let needsLogin = false;

  try {
    const status = await awalExec(['status']);
    const statusData = status.data as Record<string, unknown>;
    if (statusData.authenticated || statusData.loggedIn || statusData.address) {
      walletAddress = (statusData.address as string) || '';
      walletSpinner.succeed(`Wallet connected${walletAddress ? `: ${walletAddress}` : ''}`);
    } else {
      needsLogin = true;
      walletSpinner.info('Wallet not authenticated');
    }
  } catch {
    needsLogin = true;
    walletSpinner.info('Wallet not authenticated');
  }

  // Step 3: Ask for email
  const email = await prompt(chalk.cyan('? ') + 'Enter your email: ');
  if (!email || !email.includes('@')) {
    console.log(chalk.red('Invalid email address.'));
    return;
  }

  // Step 4: Login wallet if needed
  if (needsLogin) {
    const loginSpinner = ora('Logging in to wallet...').start();
    try {
      const loginResult = await awalExec(['auth', 'login', email]);
      const loginData = loginResult.data as Record<string, unknown>;
      const flowId = loginData.flowId || loginData.flow_id;

      if (!flowId) {
        loginSpinner.fail('Login failed: no flow ID returned');
        console.log(chalk.dim('Response:'), loginResult.raw);
        return;
      }

      loginSpinner.info('OTP sent to your email');

      const otp = await prompt(chalk.cyan('? ') + 'Enter OTP from email: ');
      if (!otp) {
        console.log(chalk.red('OTP is required.'));
        return;
      }

      const verifySpinner = ora('Verifying OTP...').start();
      try {
        const verifyResult = await awalExec(['auth', 'verify', String(flowId), otp]);
        verifySpinner.succeed('Wallet authenticated');

        // Get wallet address
        const addrResult = await awalExec(['address']);
        const addrData = addrResult.data as Record<string, unknown>;
        walletAddress = (addrData.address as string) || '';
        if (walletAddress) {
          console.log(chalk.dim(`  Wallet: ${walletAddress}`));
        }
      } catch (err) {
        verifySpinner.fail('OTP verification failed');
        console.error(chalk.red((err as Error).message));
        return;
      }
    } catch (err) {
      loginSpinner.fail('Wallet login failed');
      console.error(chalk.red((err as Error).message));
      return;
    }
  }

  // If we still don't have address, try fetching it
  if (!walletAddress) {
    try {
      const addrResult = await awalExec(['address']);
      const addrData = addrResult.data as Record<string, unknown>;
      walletAddress = (addrData.address as string) || '';
    } catch {
      // continue without address
    }
  }

  // Step 5: Check agent status
  const agentSpinner = ora('Checking agent status...').start();
  try {
    const checkResp = await apiGet<CheckEmailResponse>(
      `/api/v1/claw-agents/check-email?email=${encodeURIComponent(email)}`
    );

    if (!checkResp.ok) {
      agentSpinner.fail(`API error: ${checkResp.status}`);
      return;
    }

    const checkData = checkResp.data;

    if (!checkData.exists || checkData.status === 'UNCLAIMED') {
      // Step 6: Register new agent
      agentSpinner.text = 'Registering agent...';

      const registerBody: Record<string, string> = { email };
      if (walletAddress) {
        registerBody.wallet_address = walletAddress;
      }

      const regResp = await apiPost<RegisterResponse>(
        '/api/v1/claw-agents/register',
        registerBody
      );

      if (!regResp.ok) {
        agentSpinner.fail('Registration failed');
        console.error(chalk.red(JSON.stringify(regResp.data)));
        return;
      }

      const regData = regResp.data;
      agentSpinner.succeed(`Agent registered: ${regData.slug}`);

      saveConfig({
        api_key: regData.api_key,
        agent_id: regData.agent_id,
        agent_slug: regData.slug,
        email,
        wallet_address: walletAddress || undefined,
      });
    } else if (checkData.status === 'ACTIVE') {
      // Step 7: Login existing agent via OTP
      agentSpinner.info(`Agent found: ${checkData.slug || checkData.agent_id}`);

      const loginSpinner2 = ora('Sending login OTP...').start();
      const loginResp = await apiPost<LoginResponse>(
        '/api/v1/claw-agents/login',
        { email }
      );

      if (!loginResp.ok) {
        loginSpinner2.fail('Agent login failed');
        console.error(chalk.red(JSON.stringify(loginResp.data)));
        return;
      }

      loginSpinner2.info('OTP sent to your email');
      const agentOtp = await prompt(chalk.cyan('? ') + 'Enter agent login OTP: ');

      const verifySpinner2 = ora('Verifying...').start();
      const verifyResp = await apiPost<LoginVerifyResponse>(
        '/api/v1/claw-agents/login/verify',
        {
          email,
          otp: agentOtp,
          flow_id: loginResp.data.flow_id,
        }
      );

      if (!verifyResp.ok) {
        verifySpinner2.fail('Agent login verification failed');
        console.error(chalk.red(JSON.stringify(verifyResp.data)));
        return;
      }

      const loginData = verifyResp.data;
      verifySpinner2.succeed('Agent authenticated');

      saveConfig({
        api_key: loginData.api_key,
        agent_id: loginData.agent_id,
        agent_slug: loginData.slug,
        email,
        wallet_address: walletAddress || undefined,
      });
    } else {
      agentSpinner.warn(`Agent status: ${checkData.status}`);
      console.log(chalk.yellow('Please contact support if you need help.'));
      return;
    }
  } catch (err) {
    agentSpinner.fail('Failed to check agent status');
    console.error(chalk.red((err as Error).message));
    return;
  }

  // Step 8: Install skill to agent platforms
  const skillSpinner = ora('Installing ClawMoney skill...').start();
  try {
    const res = await fetch('https://clawmoney.ai/skill.md');
    if (res.ok) {
      const content = await res.text();
      if (content.startsWith('---')) {
        const targets = [
          { dir: join(homedir(), '.claude', 'commands'), file: 'clawmoney.md' },
          { dir: join(homedir(), '.openclaw', 'skills', 'clawmoney'), file: 'SKILL.md' },
          { dir: join(homedir(), '.codex', 'skills', 'clawmoney'), file: 'SKILL.md' },
        ];
        for (const t of targets) {
          try {
            mkdirSync(t.dir, { recursive: true });
            writeFileSync(join(t.dir, t.file), content);
          } catch {}
        }
        skillSpinner.succeed('Skill installed (Claude Code, OpenClaw, Codex)');
      } else {
        skillSpinner.warn('Skill download returned unexpected content');
      }
    } else {
      skillSpinner.warn('Could not download skill (will retry on next install)');
    }
  } catch {
    skillSpinner.warn('Could not install skill (network error)');
  }

  // Step 9: Print summary
  const config = loadConfig();
  console.log('');
  console.log(chalk.green.bold('  Setup complete!'));
  console.log('');
  if (config) {
    console.log(chalk.dim(`  Agent ID:    ${config.agent_id}`));
    console.log(chalk.dim(`  Agent Slug:  ${config.agent_slug}`));
    if (walletAddress) {
      console.log(chalk.dim(`  Wallet:      ${walletAddress}`));
    }
    console.log(chalk.dim(`  Config:      ${getConfigPath()}`));
  }
  console.log('');

  // Step 10: Auto-launch agent with /clawmoney
  let agentCli: string | null = null;
  for (const cli of ['claude', 'openclaw']) {
    try {
      execSync(`which ${cli}`, { stdio: 'pipe' });
      agentCli = cli;
      break;
    } catch {}
  }

  if (agentCli) {
    console.log(`  Launching ${chalk.cyan('/clawmoney')} in ${agentCli}...`);
    console.log('');
    try {
      execSync(`${agentCli} "/clawmoney"`, { stdio: 'inherit' });
    } catch {}
  } else {
    console.log(`  Next steps:`);
    console.log(`    Use ${chalk.cyan('/clawmoney')} in Claude Code, Codex, or OpenClaw`);
    console.log(`    Or run: ${chalk.cyan('clawmoney browse')} to browse tasks`);
    console.log('');
  }
}
