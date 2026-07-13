/**
 * Provider setup wizard. Assumes the agent is already registered
 * (api_key in ~/.spareai/config.yaml). Callable on its own — used both
 * as the post-register step of `spareai setup` and as a re-entry point
 * for users who want to add roles after their first setup.
 */
export declare function providerSetupWizard(): Promise<void>;
