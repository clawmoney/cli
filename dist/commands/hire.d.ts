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
export declare function hireSubmitCommand(taskId: string, options: SubmitOptions): Promise<void>;
export declare function hireVerifyCommand(submissionId: string, options: VerifyOptions): Promise<void>;
export {};
