import json,time,urllib.request
BASE='https://readerpro.lakassessoriadigital.workers.dev/reader'
def post(path,payload,timeout=45):
    req=urllib.request.Request(BASE+path,data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'},method='POST')
    t=time.perf_counter()
    with urllib.request.urlopen(req,timeout=timeout) as r:
        body=r.read(); ct=r.headers.get('content-type','')
    return time.perf_counter()-t,body,ct
with urllib.request.urlopen(BASE+'/health',timeout=10) as r: print('HEALTH',r.status,r.read().decode())
profile=json.load(open('kotler15_profile.json',encoding='utf-8'))
dt,b,_=post('/api/document-profile',{'sha256':profile['sha256'],'size':profile['size'],'pageCount':profile['pageCount']},10)
print('PROFILE',round(dt,2),json.loads(b)['known'],json.loads(b).get('profile',{}).get('id'))
text='Marketing creates value by understanding customer needs. Strong brands build trust over time.'
payload={'text':text,'context':'','source':'en','target':'pt','mode':'structured','docId':profile['id']}
for i in range(2):
    dt,b,_=post('/api/translate',payload,45); d=json.loads(b); print('TRANSLATE',i+1,round(dt,2),d.get('engine'),len(d.get('segments',[])),d.get('translatedText','')[:180])
dt,b,ct=post('/api/tts',{'text':'O marketing cria valor ao compreender as necessidades dos clientes.','voice':'pm_jarvis','speed':1,'docId':profile['id']},30)
print('TTS',round(dt,2),ct,len(b))