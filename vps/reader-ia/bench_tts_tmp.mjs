const url='https://readerpro.lakassessoriadigital.workers.dev/reader/api/tts';
const texts=[
'Esta é uma frase curta para medir a voz do Jarvis.',
'O marketing exige atenção constante às mudanças do mercado.',
'Empresas criam valor quando entendem profundamente seus clientes.',
'A estratégia deve transformar informação em uma vantagem competitiva.'
];
async function one(text){const t=performance.now();const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text,voice:'pm_jarvis',speed:1})});const h=performance.now();const b=await r.arrayBuffer();return {status:r.status,headers:Math.round(h-t),total:Math.round(performance.now()-t),bytes:b.byteLength};}
console.log('warm',await one('Jarvis pronto.'));
for(const x of texts) console.log('seq',await one(x));
const p=performance.now();console.log('parallel',await Promise.all(texts.map(one)),'wall',Math.round(performance.now()-p));