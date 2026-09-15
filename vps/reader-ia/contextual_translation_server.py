from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\server.py')
s=p.read_text(encoding='utf-8')
s=s.replace('TTS_URL = os.getenv("TTS_URL", "http://reader-ia-tts:8880")', 'TTS_URL = os.getenv("TTS_URL", "http://reader-ia-tts:8880")\nOLLAMA_URL = os.getenv("OLLAMA_URL", "http://reader-ia-llm:11434")\nTRANSLATION_MODEL = os.getenv("TRANSLATION_MODEL", "qwen2.5:3b")')
needle='def synthesize(text: str, voice: str, speed: float):\n'
insert=r'''def contextual_translate(text: str, context: str = ""):
    prompt = f"""Você é um tradutor editorial profissional de livros para português brasileiro.
Traduza SOMENTE o CONTEÚDO ATUAL abaixo, usando o CONTEXTO ANTERIOR apenas para entender referências, pronomes, termos e continuidade.

Regras obrigatórias:
- Escreva português brasileiro natural, fluido e fiel ao sentido; não faça tradução palavra por palavra quando isso soar artificial.
- NÃO resuma, NÃO explique, NÃO acrescente comentários e NÃO invente conteúdo.
- Preserve títulos, subtítulos e quebras de parágrafo úteis.
- OMITA artefatos de PDF/impressão: número de página isolado, cabeçalho ou rodapé repetido, URL, caminho de arquivo, data/hora de impressão, contador 'x de y' e metadados do navegador.
- Não leia nem reproduza números que existam apenas como paginação. Mantenha números que façam parte do conteúdo real (preços, percentuais, anos, dados, listas etc.).
- Retorne APENAS a tradução final do CONTEÚDO ATUAL.

CONTEXTO ANTERIOR (não reproduzir):
{(context or '')[-2200:]}

CONTEÚDO ATUAL:
{text}
"""
    data = request_json(f"{OLLAMA_URL}/api/generate", {
        "model": TRANSLATION_MODEL,
        "prompt": prompt,
        "stream": False,
        "keep_alive": "30m",
        "options": {"temperature": 0.15, "num_ctx": 8192, "num_predict": 2200},
    }, timeout=240)
    result = str(data.get("response", "")).strip()
    if not result:
        raise RuntimeError("empty_llm_translation")
    return result

'''
if needle not in s: raise SystemExit('synthesize needle missing')
s=s.replace(needle,insert+needle,1)
p.write_text(s,encoding='utf-8')
print('contextual translator function added')