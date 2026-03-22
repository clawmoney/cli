export interface ApiResponse<T = unknown> {
    ok: boolean;
    status: number;
    data: T;
}
export declare function apiGet<T = unknown>(path: string, apiKey?: string): Promise<ApiResponse<T>>;
export declare function apiPost<T = unknown>(path: string, body: unknown, apiKey?: string): Promise<ApiResponse<T>>;
export declare function getApiBase(): string;
