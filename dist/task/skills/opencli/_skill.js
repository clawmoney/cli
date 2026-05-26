import { startProgressTicker } from "../bilibili/_helpers.js";
export function makeOpenCliSkill(label, runner, price = 0.001) {
    return {
        price_usd: price,
        async run(input, ctx) {
            const i = (input ?? {});
            ctx.report({ stage: "launching", percent: 5, note: label });
            const stop = startProgressTicker(ctx, "bnbot read scraper working...");
            try {
                const raw = await runner(i);
                ctx.report({ stage: "parsing", percent: 95 });
                return raw;
            }
            finally {
                stop();
            }
        },
    };
}
export function str(input, names) {
    for (const name of names) {
        const value = input[name];
        if (typeof value === "string" && value.trim())
            return value;
        if (typeof value === "number")
            return String(value);
    }
    return undefined;
}
export function reqStr(input, names, label = names[0] ?? "value") {
    const value = str(input, names);
    if (!value)
        throw new Error(`missing '${label}'`);
    return value;
}
export function num(input, names) {
    for (const name of names) {
        const value = input[name];
        if (typeof value === "number" && Number.isFinite(value))
            return value;
        if (typeof value === "string" && value.trim()) {
            const parsed = Number.parseInt(value, 10);
            if (Number.isFinite(parsed))
                return parsed;
        }
    }
    return undefined;
}
