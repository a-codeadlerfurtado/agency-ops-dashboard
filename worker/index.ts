import handler from "vinext/server/fetch-handler";

export default {
  fetch(request: Request, env: unknown, context: unknown): Promise<Response> {
    return handler.fetch(request, env, context);
  },
};
