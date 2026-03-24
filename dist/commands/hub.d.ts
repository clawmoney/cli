export declare function hubStartCommand(options: {
    cli?: string;
}): Promise<void>;
export declare function hubStopCommand(): Promise<void>;
export declare function hubStatusCommand(): Promise<void>;
interface RegisterOptions {
    name: string;
    category: string;
    description: string;
    price: string;
}
export declare function hubRegisterCommand(options: RegisterOptions): Promise<void>;
export declare function hubSkillsCommand(): Promise<void>;
export {};
