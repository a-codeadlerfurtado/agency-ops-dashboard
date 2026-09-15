from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\server.py')
s=p.read_text(encoding='utf-8-sig')
old='return [{"id": i, "source": a, "target": b} for i, (a, b) in enumerate(zip(src, dst))]'
new='return [{"id": i, "source": a, "target": preserve_terminal_punctuation(a,b)} for i, (a, b) in enumerate(zip(src, dst))]'
assert old in s
s=s.replace(old,new,1)
old='segments.append({"id": len(segments), "source": " ".join(src_group), "target": " ".join(dst_group)})'
new='src_join=" ".join(src_group); dst_join=" ".join(dst_group); segments.append({"id": len(segments), "source": src_join, "target": preserve_terminal_punctuation(src_join,dst_join)})'
assert old in s
s=s.replace(old,new,1)
s=s.replace('chunks.append(" ".join(current));current=[];size=0','chunks.append("\\n".join(current));current=[];size=0',1)
s=s.replace('if current:chunks.append(" ".join(current))','if current:chunks.append("\\n".join(current))',1)
p.write_text(s,encoding='utf-8')
print('ALIGN_PUNCT_OK')