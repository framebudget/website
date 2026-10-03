// Measures how the page answers clicks, under CPU throttling, through the
// Chrome DevTools Protocol of an already open browser (for example an
// agent-browser session: `agent-browser --session x get cdp-url`).
//
// For each selector it clicks the element's center with real input events and
// reports: the interaction's event duration (what INP is made of), long tasks,
// layout shift, and whether the click started a view transition and what it
// animated on the root.
//
// Usage: node scripts/interaction-check.mjs <cdp-ws-url> <url-substring> <throttle> <selector>...
const [wsUrl, match, throttleArg, ...selectors] = process.argv.slice(2);
if (!wsUrl || !match || !selectors.length) {
  console.error("Usage: node scripts/interaction-check.mjs <cdp-ws-url> <url-substring> <throttle> <selector>...");
  process.exit(1);
}
const throttle = Number(throttleArg) || 1;

const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let id = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(String(event.data));
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
};
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params, sessionId }));
  });

const { targetInfos } = await send("Target.getTargets");
const target = targetInfos.find((t) => t.type === "page" && t.url.includes(match));
if (!target) throw new Error(`No page matching ${match}`);
const { sessionId } = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
const page = (method, params) => send(method, params, sessionId);
const evaluate = async (expression) => {
  const r = await page("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await evaluate(`(() => {
  if (window.__probe) return;
  const p = (window.__probe = { events: [], longtasks: [], shifts: 0, transitions: 0, rootMoves: [] });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.interactionId) p.events.push({ name: e.name, d: e.duration, id: e.interactionId, proc: e.processingEnd - e.processingStart, input: e.processingStart - e.startTime }); })
    .observe({ type: "event", durationThreshold: 16, buffered: false });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) p.longtasks.push(Math.round(e.duration)); }).observe({ type: "longtask" });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) p.shifts += e.value; }).observe({ type: "layout-shift" });
  const start = document.startViewTransition;
  if (start) document.startViewTransition = function (...a) {
    p.transitions += 1;
    const t = start.apply(this, a);
    t.ready.then(() => {
      for (const anim of document.getAnimations()) {
        const pe = anim.effect && anim.effect.pseudoElement;
        if (!pe || !pe.includes("(root)")) continue;
        const frames = anim.effect.getKeyframes().map((k) => k.transform).filter((v) => v && v !== "none");
        if (frames.length) p.rootMoves.push(pe + " " + frames.join(" -> "));
      }
    }).catch(() => {});
    return t;
  };
})()`);

await page("Emulation.setCPUThrottlingRate", { rate: throttle });
const results = [];
for (const selector of selectors) {
  await evaluate(`(() => { const p = window.__probe; p.events = []; p.longtasks = []; p.shifts = 0; p.transitions = 0; p.rootMoves = []; })()`);
  const box = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!box) {
    results.push({ selector, error: "not found" });
    continue;
  }
  await sleep(600);
  await page("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await page("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await page("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await sleep(1800);
  const probe = await evaluate(`JSON.parse(JSON.stringify(window.__probe))`);
  const byInteraction = new Map();
  for (const e of probe.events) byInteraction.set(e.id, Math.max(byInteraction.get(e.id) ?? 0, e.d));
  results.push({
    selector,
    interactionMs: byInteraction.size ? Math.max(...byInteraction.values()) : "<16",
    longTasksMs: probe.longtasks,
    layoutShift: Number(probe.shifts.toFixed(4)),
    viewTransitions: probe.transitions,
    rootMoves: probe.rootMoves,
  });
}
await page("Emulation.setCPUThrottlingRate", { rate: 1 });
console.log(JSON.stringify({ throttle, results }, null, 2));
ws.close();
