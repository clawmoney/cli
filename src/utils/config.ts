import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';

export interface ClawConfig {
  api_key: string;
  agent_id: string;
  agent_slug: string;
  email?: string;
  wallet_address?: string;
  provider?: {
    cli_command?: string;
    max_concurrent?: number;
    [key: string]: unknown;
  };
}

const CONFIG_DIR = path.join(os.homedir(), '.clawmoney');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.yaml');

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function loadConfig(): ClawConfig | null {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      return null;
    }
    const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
    const config = YAML.parse(content);
    if (!config || !config.api_key) {
      return null;
    }
    return config as ClawConfig;
  } catch {
    return null;
  }
}

export function saveConfig(config: Partial<ClawConfig>): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }

  let existing: Record<string, unknown> = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
      existing = YAML.parse(content) || {};
    }
  } catch {
    // ignore parse errors, overwrite
  }

  const merged = { ...existing, ...config };
  fs.writeFileSync(CONFIG_FILE, YAML.stringify(merged), 'utf-8');
}

export function requireConfig(): ClawConfig {
  const config = loadConfig();
  if (!config) {
    throw new Error(
      `No config found. Run "clawmoney setup" first.\nExpected config at: ${CONFIG_FILE}`
    );
  }
  return config;
}
