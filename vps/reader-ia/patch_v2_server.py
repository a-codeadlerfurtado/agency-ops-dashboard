from pathlib import Path
p=Path('server.py')
s=p.read_text(encoding='utf-8')
anchor='def synthesize(text: str, voice: str, speed: float):\n'
if anchor not in s: raise SystemExit('synthesize anchor missing')
helpers=r'''def sentence_units(text: str):
    text = re.sub(r'\s+', ' ', (text or '').strip())
    if not text:
        return []
    return [x.strip() for x in re.findall(r'[^.!?…]+(?:[.!?…]+(?:[\"”’\)\]]+)?(?=\s|$)|$)', text) if x.strip()]


def align_translation(source_text: str, target_text: str):
    src = sentence_units(source_text)
    dst = sentence_units(target_text)
    if not src or not dst:
        return []
    if len(src) == len(dst):
        return [{"id": i, "source": a, "target": b} for i, (a, b) in enumerate(zip(src, dst))]
    segments, si, di = [], 0, 0
    src_total = max(1, sum(len(x) for x in src))
    dst_total = max(1, sum(len(x) for x in dst))
'''
s=s.replace(anchor,helpers+'\n'+anchor,1)
p.write_text(s,encoding='utf-8')
print('server v2 helpers part1')

p=Path('server.py')
s=p.read_text(encoding='utf-8')
needle='    dst_total = max(1, sum(len(x) for x in dst))\n\n'
rest=r'''    while si < len(src) and di < len(dst):
        src_group, dst_group = [src[si]], [dst[di]]
        sp = sum(len(x) for x in src[:si+1]) / src_total
        dp = sum(len(x) for x in dst[:di+1]) / dst_total
        while sp + 0.10 < dp and si + 1 < len(src):
            si += 1; src_group.append(src[si])
            sp = sum(len(x) for x in src[:si+1]) / src_total
        while dp + 0.10 < sp and di + 1 < len(dst):
            di += 1; dst_group.append(dst[di])
            dp = sum(len(x) for x in dst[:di+1]) / dst_total
        segments.append({"id": len(segments), "source": " ".join(src_group), "target": " ".join(dst_group)})
        si += 1; di += 1
    if si < len(src) and segments:
        segments[-1]["source"] += " " + " ".join(src[si:])
    if di < len(dst) and segments:
        segments[-1]["target"] += " " + " ".join(dst[di:])
    return segments


def structured_translation(text: str, context: str = ""):
    translated = contextual_translate(text, context)
    return translated, align_translation(text, translated)

'''
if needle not in s: raise SystemExit('dst_total needle missing')
s=s.replace(needle,needle+rest,1)
p.write_text(s,encoding='utf-8')
print('server v2 helpers part2')

p=Path('server.py')
s=p.read_text(encoding='utf-8')
old='''                if mode == "editorial":\n                    try:\n                        translated = contextual_translate(text, context)\n                        return self.send_json(200, {"translatedText": translated, "engine": "local-contextual"})\n                    except Exception as llm_exc:\n                        print(f"contextual_translate_failed: {llm_exc}")\n                translated = [translate_chunk(chunk, source, target) for chunk in split_text(text)]\n                return self.send_json(200, {"translatedText": "\\n".join(translated), "engine": "literal-fallback"})\n'''
new='''                if mode in ("editorial", "structured"):\n                    try:\n                        translated, segments = structured_translation(text, context)\n                        return self.send_json(200, {"translatedText": translated, "segments": segments, "engine": "local-contextual-v2"})\n                    except Exception as llm_exc:\n                        print(f"contextual_translate_failed: {llm_exc}")\n                translated = "\\n".join(translate_chunk(chunk, source, target) for chunk in split_text(text))\n                return self.send_json(200, {"translatedText": translated, "segments": align_translation(text, translated), "engine": "literal-fallback"})\n'''
if old not in s: raise SystemExit('translate response block missing')
s=s.replace(old,new,1)
s=s.replace('server_version = "ReaderIA/1.2"','server_version = "ReaderPro/2.0"')
p.write_text(s,encoding='utf-8')
print('server v2 endpoint patched')
