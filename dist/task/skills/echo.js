/**
 * Trivial echo skill. Returns the input verbatim with a single
 * mid-flight progress frame. Useful for protocol smoke tests.
 */
export const echoSkill = {
    price_usd: 0,
    async run(input, ctx) {
        ctx.report({ stage: "processing", percent: 50, note: "echoing" });
        await new Promise((r) => setTimeout(r, 100));
        return { echoed: input, at: new Date().toISOString() };
    },
};
