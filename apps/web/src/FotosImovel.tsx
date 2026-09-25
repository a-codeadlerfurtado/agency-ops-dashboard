import { useRef, useState } from "react";
import { supabase, mensagemDeErro } from "./lib/supabase";
import { escolherImagemDaCamera, ehNativo, impactoLeve } from "./lib/native";
import { Ico, Skeleton, useAsync, useToast } from "./ui";

const BUCKET = "imobi-board-imoveis";

export interface Foto {
  id: string;
  storage_path: string;
  sort_order: number;
  url?: string;
}

/**
 * Fotos do imóvel.
 *
 * O bucket é privado: a URL vem de `createSignedUrl`, com validade curta. Foto
 * de imóvel de cliente não fica em URL pública adivinhável.
 *
 * O caminho é `{tenant_id}/{property_id}/{arquivo}` — o primeiro segmento é o
 * que a policy do Storage usa para decidir de quem é o arquivo.
 *
 * Todo botão daqui leva `type="button"` explícito: este componente é montado
 * dentro do `<form>` do cadastro de imóvel, e sem isso o default do HTML é
 * `submit` — clicar em "Adicionar fotos" salvava e fechava o cadastro.
 */
async function listar(tenantId: string, propertyId: string): Promise<Foto[]> {
  const { data, error } = await supabase
    .from("property_media")
    .select("id, storage_path, sort_order")
    .eq("property_id", propertyId)
    .order("sort_order");
  if (error) throw error;

  const fotos = (data ?? []) as Foto[];
  if (fotos.length === 0) return [];

  const { data: urls } = await supabase.storage
    .from(BUCKET)
    .createSignedUrls(fotos.map((f) => f.storage_path), 3600);

  // createSignedUrls devolve null quando um arquivo sumiu do bucket; a foto
  // continua na lista, so nao renderiza a imagem
  return fotos.map((f, i) => ({ ...f, url: urls?.[i]?.signedUrl ?? undefined }));
}

export default function FotosImovel({
  tenantId, propertyId, podeEditar,
}: { tenantId: string; propertyId: string; podeEditar: boolean }) {
  const avisar = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [enviando, setEnviando] = useState(false);
  const lista = useAsync(() => listar(tenantId, propertyId), [tenantId, propertyId]);

  async function enviar(arquivos: FileList | File[] | null) {
    if (!arquivos?.length) return;
    setEnviando(true);
    try {
      for (const arq of Array.from(arquivos)) {
        // nome previsível não serve: dois uploads do mesmo celular colidiriam
        const ext = arq.name.split(".").pop()?.toLowerCase() ?? "jpg";
        const caminho = `${tenantId}/${propertyId}/${crypto.randomUUID()}.${ext}`;

        const { error: eUp } = await supabase.storage
          .from(BUCKET)
          .upload(caminho, arq, { contentType: arq.type, upsert: false });
        if (eUp) throw eUp;

        const { error: eReg } = await supabase.rpc("registrar_foto", {
          p_property_id: propertyId,
          p_storage_path: caminho,
        });
        // se o registro falhar, o binário órfão fica no bucket: limpa
        if (eReg) {
          await supabase.storage.from(BUCKET).remove([caminho]);
          throw eReg;
        }
      }
      await impactoLeve();
      avisar("ok", arquivos.length > 1 ? "Fotos enviadas." : "Foto enviada.");
      lista.recarregar();
    } catch (e) {
      avisar("err", mensagemDeErro(e));
    } finally {
      setEnviando(false);
      if (input.current) input.current.value = "";
    }
  }

  async function fotografar() {
    try {
      const uri = await escolherImagemDaCamera();
      if (!uri) return;
      const resposta = await fetch(uri);
      const blob = await resposta.blob();
      const ext = blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : "jpg";
      const arquivo = new File([blob], `camera-${Date.now()}.${ext}`, {
        type: blob.type || "image/jpeg",
      });
      await enviar([arquivo]);
    } catch (e) {
      avisar("err", e instanceof Error ? e.message : "Nao foi possivel abrir a camera.");
    }
  }

  async function remover(f: Foto) {
    try {
      const { data: caminho, error } = await supabase.rpc("remover_foto", { p_media_id: f.id });
      if (error) throw error;
      if (caminho) await supabase.storage.from(BUCKET).remove([caminho as string]);
      avisar("ok", "Foto removida.");
      lista.recarregar();
    } catch (e) {
      avisar("err", mensagemDeErro(e));
    }
  }

  if (lista.carregando && !lista.dado) return <Skeleton h={72} />;

  const fotos = lista.dado ?? [];

  return (
    <div>
      {fotos.length > 0 && (
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
          gap: 8, marginBottom: podeEditar ? 10 : 0,
        }}>
          {fotos.map((f) => (
            <div key={f.id} style={{
              position: "relative", aspectRatio: "4/3",
              borderRadius: "var(--r-sm)", overflow: "hidden",
              border: "1px solid var(--line)", background: "var(--panel-2)",
            }}>
              {f.url && (
                <img src={f.url} alt=""
                     style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
              )}
              {podeEditar && (
                <button
                  type="button"
                  className="ctrl"
                  onClick={() => remover(f)}
                  aria-label="Remover foto"
                  style={{
                    position: "absolute", top: 4, right: 4,
                    height: 24, minWidth: 24, padding: 0,
                    background: "#010509cc", borderColor: "#ffffff2e",
                  }}
                >
                  {Ico.close({ size: 13 })}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {podeEditar ? (
        <>
          <input
            ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/avif"
            multiple hidden onChange={(e) => enviar(e.target.files)}
          />
          <button type="button" className="btn sm" disabled={enviando}
                  onClick={() => input.current?.click()}>
            {Ico.plus({ size: 14 })} {enviando ? "Enviando..." : "Adicionar fotos"}
          </button>
          {ehNativo() && (
            <button type="button" className="btn sm" disabled={enviando}
                    style={{ marginLeft: 8 }} onClick={() => void fotografar()}>
              {Ico.plus({ size: 14 })} Tirar foto
            </button>
          )}
          <span className="hint" style={{ marginLeft: 10 }}>
            JPG, PNG, WebP ou AVIF ate 8 MB.
          </span>
        </>
      ) : (
        fotos.length === 0 && <span className="hint">Sem fotos.</span>
      )}
    </div>
  );
}
