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
export declare function getConfigPath(): string;
export declare function loadConfig(): ClawConfig | null;
export declare function saveConfig(config: Partial<ClawConfig>): void;
export declare function requireConfig(): ClawConfig;
