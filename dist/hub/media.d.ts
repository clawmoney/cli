import type { ProviderConfig } from "./types.js";
/**
 * Upload a local file to the Hub media endpoint (R2).
 * Returns the public CDN URL on success, or null on failure.
 */
export declare function uploadFile(filePath: string, config: ProviderConfig): Promise<string | null>;
/**
 * Walk the output object and replace any local file paths with CDN URLs.
 * Mutates the object in-place and returns it.
 */
export declare function replaceLocalPaths(output: Record<string, unknown>, config: ProviderConfig): Promise<Record<string, unknown>>;
