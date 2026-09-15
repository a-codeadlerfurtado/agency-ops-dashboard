from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\cdp_voice_test.mjs')
s=p.read_text(encoding='utf-8')
needle="await cmd('Runtime.enable');await cmd('DOM.enable');\n"
s=s.replace(needle,needle+"await cmd('Runtime.evaluate',{expression:`localStorage.clear()`});\n",1)
s=s.replace('await sleep(3500);','await sleep(2200);')
Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\cdp_voice_test_fresh.mjs').write_text(s,encoding='utf-8')
print('fresh voice test created')