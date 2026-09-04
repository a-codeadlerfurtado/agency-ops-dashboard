/**
 * Modo apresentação do Briefing Hub.
 *
 * Esta rota já tentou montar a apresentação aqui dentro: buscava o Hub e
 * injetava os dados fictícios por cima. Nunca funcionou em produção, e
 * ninguém percebeu por dois motivos que se somaram.
 *
 * O primeiro: `public/briefing-hub-demo.html` ocupava este mesmo caminho. O
 * Workers Assets resolve o arquivo estático antes de chegar no route handler,
 * então quem abria o link via um demo antigo e a rota nunca era executada.
 *
 * O segundo apareceu quando o estático saiu: o fetch daqui para o Hub falha.
 * Os dois Workers vivem na mesma zona `lakassessoriadigital.workers.dev`, e a
 * Cloudflare não despacha a sub-requisição para o segundo Worker nesse caso --
 * a rota respondia 502 com "presentation source unavailable".
 *
 * Quem consegue buscar o Hub é a Edge Function do Supabase, que está fora
 * dessa zona: `briefing-hub-presentation` faz o mesmo trabalho e funciona.
 * Então este endereço passa a ser só o atalho bonito para ela.
 *
 * Redirecionar em vez de servir por aqui é deliberado: com o proxy voltariam a
 * existir duas cópias dos dados de demonstração -- uma aqui, outra na Edge
 * Function -- e elas divergiriam em silêncio. Uma implementação só.
 */

const APRESENTACAO =
  "https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/briefing-hub-presentation";

export async function GET(request: Request): Promise<Response> {
  const destino = new URL(APRESENTACAO);
  destino.search = new URL(request.url).search;
  return new Response(null, {
    status: 307,
    headers: {
      location: destino.toString(),
      "cache-control": "no-store, max-age=0",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}
