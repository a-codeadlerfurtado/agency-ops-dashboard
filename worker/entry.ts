import baseWorker from "./index";

const SUPABASE = "https://bfzdetibfcwihfkltbkp.supabase.co";
const OLD_IMG_SRC = "img-src 'self' data:";
const NEW_IMG_SRC = `img-src 'self' data: ${SUPABASE}`;

function widenImageCsp(response: Response): Response {
  const headers = new Headers(response.headers);
  const csp = headers.get("content-security-policy");
  if (csp && csp.includes(OLD_IMG_SRC) && !csp.includes(NEW_IMG_SRC)) {
    headers.set("content-security-policy", csp.replace(OLD_IMG_SRC, NEW_IMG_SRC));
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: any, context: any): Promise<Response> {
    const response = await baseWorker.fetch(request, env, context);
    return widenImageCsp(response);
  },
};
