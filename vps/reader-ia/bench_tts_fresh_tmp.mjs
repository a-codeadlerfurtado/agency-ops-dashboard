const url='https://readerpro.lakassessoriadigital.workers.dev/reader/api/tts';
const stamp=Date.now();
const texts=[
`A análise de mercado número ${stamp%10000} exige precisão.`,
`O consumidor compara alternativas antes de decidir ${stamp%997}.`,
`Uma marca forte reduz a incerteza na escolha ${stamp%991}.`,
`A estratégia conecta objetivos e execução ${stamp%983}.`
];
async function one(text){const t=performance.now();const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text,voice:'pm_jarvis',speed:1})});const h=performance.now();const b=await r.arrayBuffer();return {status:r.status,headers:Math.round(h-t),total:Math.round(performance.now()-t),bytes:b.byteLength};}
const t=performance.now();console.log(await Promise.all(texts.map(one)),'wall',Math.round(performance.now()-t));