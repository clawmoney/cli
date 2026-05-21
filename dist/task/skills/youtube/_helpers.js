/** Fire fake progress every 1.5s while a slow bnbot call runs.
 *  Returns a cleanup function — call it in a finally block. */
export function startProgressTicker(ctx, label) {
    let pct = 15;
    const timer = setInterval(() => {
        pct = Math.min(85, pct + 10);
        ctx.report({ stage: "scraping", percent: pct, note: label });
    }, 1500);
    return () => clearInterval(timer);
}
