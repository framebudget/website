// Worker entry. workerd only accepts handlers as module exports, so the logic lives in handler.ts.
import { handleFetchSafely, runRetention, type Env } from "./handler";

export default {
  fetch: (request, env, ctx) => handleFetchSafely(request, env, ctx, Date.now()),
  scheduled: (controller, env) => runRetention(env, controller.scheduledTime),
} satisfies ExportedHandler<Env>;
