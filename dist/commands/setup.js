import chalk from 'chalk';
import ora from 'ora';
import { apiGet, apiPost } from '../utils/api.js';
import { loadConfig, saveConfig, getConfigPath } from '../utils/config.js';
import { prompt } from '../utils/prompt.js';
const CLAIM_POLL_INTERVAL_MS = 4_000;
const CLAIM_POLL_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
async function pollForClaim(apiKey, onTick) {
    const start = Date.now();
    while (Date.now() - start < CLAIM_POLL_TIMEOUT_MS) {
        try {
            const resp = await apiGet('/api/v1/claw-agents/me', apiKey);
            // Claim completion is detected via wallet_address being populated.
            // Agent.status stays "unclaimed" by design until X account verification
            // (see crud.claim_claw_agent), so we can't gate on status here — the
            // wallet address is only set by complete_claim_with_key, so its
            // presence is a reliable claim-completed signal.
            if (resp.ok && resp.data && resp.data.wallet_address) {
                return resp.data;
            }
        }
        catch {
            // Network blip — keep polling.
        }
        onTick?.();
        await new Promise((r) => setTimeout(r, CLAIM_POLL_INTERVAL_MS));
    }
    return null;
}
export async function setupCommand() {
    console.log(chalk.bold('\n  ClawMoney Setup\n'));
    // Non-interactive mode: skill-install path.
    if (!process.stdin.isTTY) {
        console.log('ClawMoney skill installed successfully.');
        console.log('');
        console.log('NEXT STEP: Run /clawmoney now to complete onboarding.');
        console.log('The skill will walk you through agent registration and earning.');
        console.log('');
        return;
    }
    // Step 1: Ask for email.
    const email = await prompt(chalk.cyan('? ') + 'Enter your email: ');
    if (!email || !email.includes('@')) {
        console.log(chalk.red('Invalid email address.'));
        return;
    }
    // Step 2: Check if this email already has an agent.
    const agentSpinner = ora('Checking agent status...').start();
    let existingStatus = '';
    try {
        const checkResp = await apiGet(`/api/v1/claw-agents/check-email?email=${encodeURIComponent(email)}`);
        if (checkResp.ok) {
            const info = checkResp.data.agent ?? {};
            existingStatus = (info.status ?? checkResp.data.status ?? '').toUpperCase();
        }
    }
    catch {
        // Fall through — if the check fails, we still try registering.
    }
    // Existing ACTIVE agent → login path: send OTP, verify, rotate key.
    // This is the "I already registered on another machine / lost my api_key"
    // flow — no new claim link needed.
    if (existingStatus === 'ACTIVE') {
        agentSpinner.info('Existing agent found. Sending login code to your email...');
        try {
            const loginResp = await apiPost('/api/v1/claw-agents/login', { email });
            if (!loginResp.ok) {
                console.error(chalk.red(JSON.stringify(loginResp.data)));
                return;
            }
        }
        catch (err) {
            console.error(chalk.red(err.message));
            return;
        }
        const otp = await prompt(chalk.cyan('? ') + 'Enter the 6-digit code from your email: ');
        if (!otp || !/^\d{4,8}$/.test(otp.trim())) {
            console.log(chalk.red('Invalid code.'));
            return;
        }
        const verifySpinner = ora('Verifying code...').start();
        let loginData;
        try {
            const verifyResp = await apiPost('/api/v1/claw-agents/login/verify', { email, otp: otp.trim() });
            if (!verifyResp.ok) {
                verifySpinner.fail('Verification failed');
                console.error(chalk.red(JSON.stringify(verifyResp.data)));
                return;
            }
            loginData = verifyResp.data;
        }
        catch (err) {
            verifySpinner.fail('Verification failed');
            console.error(chalk.red(err.message));
            return;
        }
        verifySpinner.succeed('Logged in');
        // Persist api_key immediately so nothing is lost if wallet provision hiccups.
        saveConfig({
            api_key: loginData.api_key,
            agent_id: loginData.agent_id,
            agent_slug: loginData.agent_slug,
            email,
            wallet_address: loginData.agent?.wallet_address ?? undefined,
        });
        // Ensure a CDP wallet exists for this agent. Older ACTIVE agents
        // predating the CDP flow have wallet_address=null; hitting the
        // balance endpoint triggers _ensure_agent_wallet on the backend.
        let walletAddress = loginData.agent?.wallet_address ?? '';
        if (!walletAddress) {
            const walletSpinner = ora('Provisioning CDP wallet...').start();
            try {
                const balResp = await apiGet('/api/v1/claw-agents/me/wallet/balance?asset=usdc', loginData.api_key);
                if (balResp.ok && balResp.data?.address) {
                    walletAddress = balResp.data.address;
                    saveConfig({ wallet_address: walletAddress });
                    walletSpinner.succeed(`Wallet ready: ${walletAddress}`);
                }
                else {
                    walletSpinner.warn('Wallet not yet available — will be created on first use.');
                }
            }
            catch (err) {
                walletSpinner.warn(`Wallet provisioning deferred: ${err.message}`);
            }
        }
        // Summary.
        console.log('');
        console.log(chalk.green.bold('  Setup complete!'));
        console.log('');
        console.log(chalk.dim(`  Agent ID:    ${loginData.agent_id}`));
        console.log(chalk.dim(`  Agent Slug:  ${loginData.agent_slug}`));
        if (walletAddress) {
            console.log(chalk.dim(`  Wallet:      ${walletAddress}`));
            console.log(chalk.dim(`  Custody:     Coinbase CDP Server Wallet`));
        }
        console.log(chalk.dim(`  Config:      ${getConfigPath()}`));
        console.log('');
        console.log(`  Next steps:`);
        console.log(`    ${chalk.cyan('clawmoney wallet balance')}  Check your wallet balance`);
        console.log(`    ${chalk.cyan('clawmoney browse')}          Browse available tasks`);
        console.log('');
        return;
    }
    // Step 3: Register agent (or re-send claim link for an UNCLAIMED agent).
    // The backend generates the anonymous slug from email hash; we never send a name.
    agentSpinner.text = 'Registering agent...';
    let regData;
    try {
        const regResp = await apiPost('/api/v1/claw-agents/register', { email });
        if (!regResp.ok) {
            agentSpinner.fail('Registration failed');
            console.error(chalk.red(JSON.stringify(regResp.data)));
            return;
        }
        regData = regResp.data;
    }
    catch (err) {
        agentSpinner.fail('Registration failed');
        console.error(chalk.red(err.message));
        return;
    }
    agentSpinner.succeed(`Agent registered: ${regData.agent.slug}`);
    // Persist the api_key and agent_id immediately — the key only activates
    // after the claim link is clicked, but we save it now so nothing is lost
    // if the user ctrl-C's during the claim step.
    saveConfig({
        api_key: regData.api_key,
        agent_id: regData.agent.id,
        agent_slug: regData.agent.slug,
        email,
    });
    // Step 4: Instruct the user to click the claim link in their email.
    console.log('');
    console.log(chalk.bold('  Check your email'));
    console.log('');
    console.log(chalk.dim('  We sent a claim link to'), chalk.cyan(email));
    console.log(chalk.dim('  Click the link to complete setup. Your CDP wallet will be'));
    console.log(chalk.dim('  provisioned automatically and this CLI will unlock.'));
    console.log('');
    // Step 5: Poll for claim completion.
    const pollSpinner = ora('Waiting for claim link to be clicked...').start();
    let tickCount = 0;
    const completed = await pollForClaim(regData.api_key, () => {
        tickCount++;
        if (tickCount % 5 === 0) {
            pollSpinner.text = `Waiting for claim link... (${Math.floor((tickCount * CLAIM_POLL_INTERVAL_MS) / 1000)}s)`;
        }
    });
    if (!completed) {
        pollSpinner.warn('Claim not completed within 15 minutes.');
        console.log('');
        console.log(chalk.yellow('  You can re-run'), chalk.cyan('clawmoney setup'), chalk.yellow('later to resume.'));
        console.log(chalk.dim('  Your API key is already saved and will activate once you click the claim link.'));
        console.log('');
        return;
    }
    const walletAddress = completed.wallet_address ?? '';
    pollSpinner.succeed('Agent claimed');
    // Step 6: Update config with the now-known wallet address.
    saveConfig({
        api_key: regData.api_key,
        agent_id: completed.id,
        agent_slug: completed.slug,
        email,
        wallet_address: walletAddress || undefined,
    });
    // Step 7: Summary.
    const config = loadConfig();
    console.log('');
    console.log(chalk.green.bold('  Setup complete!'));
    console.log('');
    if (config) {
        console.log(chalk.dim(`  Agent ID:    ${config.agent_id}`));
        console.log(chalk.dim(`  Agent Slug:  ${config.agent_slug}`));
        if (walletAddress) {
            console.log(chalk.dim(`  Wallet:      ${walletAddress}`));
            console.log(chalk.dim(`  Custody:     Coinbase CDP Server Wallet`));
        }
        console.log(chalk.dim(`  Config:      ${getConfigPath()}`));
    }
    console.log('');
    console.log(`  Next steps:`);
    console.log(`    ${chalk.cyan('clawmoney browse')}          Browse available tasks`);
    console.log(`    ${chalk.cyan('clawmoney wallet balance')}  Check your wallet balance`);
    console.log(`    ${chalk.cyan('clawmoney promote submit')}  Submit a task proof`);
    console.log('');
}
