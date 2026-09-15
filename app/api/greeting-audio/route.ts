export const dynamic = "force-dynamic";

const STATIC_AUDIO_PATH = "/audio/opsquestion-greeting-full-v6.mp3";

export async function GET(request: Request) {
  const target = new URL(STATIC_AUDIO_PATH, request.url);
  return Response.redirect(target, 307);
}
