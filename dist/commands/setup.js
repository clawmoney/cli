import chalk from 'chalk';
import ora from 'ora';
import { awalExec } from '../utils/awal.js';
import { apiGet, apiPost } from '../utils/api.js';
import { loadConfig, saveConfig, getConfigPath } from '../utils/config.js';
import { prompt } from '../utils/prompt.js';
import { execSync } from 'node:child_process';
export async function setupCommand() {
    console.log(chalk.bold('\n  ClawMoney Agent Setup\n'));
    // Non-interactive mode: if no TTY (e.g. AI agent running the command),
    // install the skill and instruct the AI to proceed with onboarding.
    if (!process.stdin.isTTY) {
        console.log('ClawMoney skill installed successfully.');
        console.log('');
        console.log('NEXT STEP: Run /clawmoney now to complete onboarding.');
        console.log('The skill will walk you through wallet setup, agent registration, and earning.');
        console.log('');
        return;
    }
    // Step 1: Check and install dependencies
    const depSpinner = ora('Checking dependencies...').start();
    try {
        // Check if awal is available
        try {
            execSync('npx awal --version', { stdio: 'pipe' });
            depSpinner.succeed('awal is available');
        }
        catch {
            depSpinner.text = 'Installing awal...';
            try {
                execSync('npm install -g awal', { stdio: 'pipe' });
                depSpinner.succeed('awal installed');
            }
            catch {
                depSpinner.warn('Could not install awal globally. Will use npx.');
            }
        }
    }
    catch (err) {
        depSpinner.fail('Failed to check dependencies');
        console.error(chalk.red(err.message));
        return;
    }
    // Step 2: Check wallet status
    //
    // We try to get the wallet address directly — if awal returns one, the
    // wallet is signed in, end of story. This avoids the awal `status` command
    // returning an unrecognized shape (observed field-name drift: some versions
    // return `authenticated`, others `signedIn`/`account`/nested objects)
    // which would otherwise force us into the login flow even when the user
    // is already signed in, and awal would then refuse with "already signed in".
    const walletSpinner = ora('Checking wallet status...').start();
    let walletAddress = '';
    let needsLogin = false;
    try {
        const addrResult = await awalExec(['address']);
        const addrData = addrResult.data;
        const addr = addrData.address || '';
        if (addr) {
            walletAddress = addr;
            walletSpinner.succeed(`Wallet connected: ${walletAddress}`);
        }
        else {
            // Fall back to legacy `status` shape in case some awal version only
            // exposes authentication through that command.
            const status = await awalExec(['status']);
            const statusData = status.data;
            if (statusData.authenticated || statusData.loggedIn || statusData.address) {
                walletAddress = statusData.address || '';
                walletSpinner.succeed(`Wallet connected${walletAddress ? `: ${walletAddress}` : ''}`);
            }
            else {
                needsLogin = true;
                walletSpinner.info('Wallet not authenticated');
            }
        }
    }
    catch {
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
            const loginData = loginResult.data;
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
                const addrData = addrResult.data;
                walletAddress = addrData.address || '';
                if (walletAddress) {
                    console.log(chalk.dim(`  Wallet: ${walletAddress}`));
                }
            }
            catch (err) {
                verifySpinner.fail('OTP verification failed');
                console.error(chalk.red(err.message));
                return;
            }
        }
        catch (err) {
            // If awal reports "already signed in" we're actually in the happy path
            // — the wallet is authenticated, the address check at the top just
            // failed to detect it. Try once more to fetch the address directly.
            const msg = err.message || '';
            if (/already\s*signed\s*in/i.test(msg)) {
                loginSpinner.info('Wallet already signed in');
                try {
                    const addrResult = await awalExec(['address']);
                    const addrData = addrResult.data;
                    walletAddress = addrData.address || '';
                    if (walletAddress) {
                        console.log(chalk.dim(`  Wallet: ${walletAddress}`));
                    }
                }
                catch {
                    // Address fetch still failed — continue anyway; the agent
                    // register/login flow below doesn't strictly require a wallet.
                }
            }
            else {
                loginSpinner.fail('Wallet login failed');
                console.error(chalk.red(msg));
                return;
            }
        }
    }
    // If we still don't have address, try fetching it
    if (!walletAddress) {
        try {
            const addrResult = await awalExec(['address']);
            const addrData = addrResult.data;
            walletAddress = addrData.address || '';
        }
        catch {
            // continue without address
        }
    }
    // Step 5: Check agent status
    const agentSpinner = ora('Checking agent status...').start();
    try {
        const checkResp = await apiGet(`/api/v1/claw-agents/check-email?email=${encodeURIComponent(email)}`);
        if (!checkResp.ok) {
            agentSpinner.fail(`API error: ${checkResp.status}`);
            return;
        }
        const checkData = checkResp.data;
        // Backend returns agent details nested under `agent` now; fall back
        // to legacy top-level fields so an older backend still works.
        // Status is normalized to uppercase so case differences between
        // backend builds (active vs ACTIVE) don't trip the branch select.
        const agentInfo = checkData.agent ?? {};
        const agentStatus = (agentInfo.status ?? checkData.status ?? '').toUpperCase();
        const agentSlug = agentInfo.slug ?? checkData.slug;
        const agentIdFromCheck = agentInfo.id ?? checkData.agent_id;
        if (!checkData.exists || agentStatus === 'UNCLAIMED') {
            // Step 6: Register new agent
            agentSpinner.text = 'Registering agent...';
            const registerBody = { email };
            if (walletAddress) {
                registerBody.wallet_address = walletAddress;
            }
            const regResp = await apiPost('/api/v1/claw-agents/register', registerBody);
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
        }
        else if (agentStatus === 'ACTIVE') {
            // Step 7: Login existing agent via OTP
            agentSpinner.info(`Agent found: ${agentSlug || agentIdFromCheck}`);
            const loginSpinner2 = ora('Sending login OTP...').start();
            const loginResp = await apiPost('/api/v1/claw-agents/login', { email });
            if (!loginResp.ok) {
                loginSpinner2.fail('Agent login failed');
                console.error(chalk.red(JSON.stringify(loginResp.data)));
                return;
            }
            loginSpinner2.info('OTP sent to your email');
            const agentOtp = await prompt(chalk.cyan('? ') + 'Enter agent login OTP: ');
            const verifySpinner2 = ora('Verifying...').start();
            const verifyResp = await apiPost('/api/v1/claw-agents/login/verify', {
                email,
                otp: agentOtp,
                flow_id: loginResp.data.flow_id,
            });
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
        }
        else {
            agentSpinner.warn(`Agent status: ${agentStatus || '(unknown)'}`);
            console.log(chalk.yellow('Please contact support if you need help.'));
            return;
        }
    }
    catch (err) {
        agentSpinner.fail('Failed to check agent status');
        console.error(chalk.red(err.message));
        return;
    }
    // Step 8: Print summary
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
    console.log(`  Next steps:`);
    console.log(`    ${chalk.cyan('clawmoney browse')}          Browse available tasks`);
    console.log(`    ${chalk.cyan('clawmoney wallet balance')}  Check your wallet balance`);
    console.log(`    ${chalk.cyan('clawmoney promote submit')}  Submit a task proof`);
    console.log('');
}
