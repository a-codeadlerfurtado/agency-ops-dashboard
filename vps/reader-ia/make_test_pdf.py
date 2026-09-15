from pathlib import Path
out=Path('buffer-test.pdf')
objs=[]
objs.append('<< /Type /Catalog /Pages 2 0 R >>')
kids=[]
page_ids=[]
content_ids=[]
font_id=3
next_id=4
for i in range(1,13):
    page_ids.append(next_id); content_ids.append(next_id+1); kids.append(f'{next_id} 0 R'); next_id+=2
objs.append(f'<< /Type /Pages /Kids [{" ".join(kids)}] /Count 12 >>')
objs.append('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
for i,(pid,cid) in enumerate(zip(page_ids,content_ids),1):
    objs.append(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 {font_id} 0 R >> >> /Contents {cid} 0 R >>')
    text=f'Marketing Chapter {i}. This is page {i}. Strong brands create value by understanding customers and markets. Marketing strategy requires context, consistency, positioning and long-term relationships.'
    stream=f'BT /F1 14 Tf 72 700 Td ({text}) Tj ET'
    objs.append(f'<< /Length {len(stream.encode())} >>\nstream\n{stream}\nendstream')
parts=['%PDF-1.4\n']; offsets=[0]
for idx,obj in enumerate(objs,1):
    offsets.append(sum(len(x.encode()) for x in parts)); parts.append(f'{idx} 0 obj\n{obj}\nendobj\n')
xref=sum(len(x.encode()) for x in parts); parts.append(f'xref\n0 {len(objs)+1}\n0000000000 65535 f \n')
for off in offsets[1:]: parts.append(f'{off:010d} 00000 n \n')
parts.append(f'trailer << /Size {len(objs)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n')
out.write_bytes(''.join(parts).encode('latin1')); print(out.resolve(),out.stat().st_size)