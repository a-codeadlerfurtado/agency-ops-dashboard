import json, urllib.request
base='https://portainer.leonardoimobi.com.br/reader'
def post(path,payload):
    data=json.dumps(payload,ensure_ascii=False).encode('utf-8')
    req=urllib.request.Request(base+path,data=data,headers={'Content-Type':'application/json'},method='POST')
    with urllib.request.urlopen(req,timeout=60) as r:return json.loads(r.read().decode('utf-8'))

kotler="""Preface
What's New in the 15th Edition
The 15th edition of Marketing Management is a landmark entry in the long successful history of the market leader. With the 15th edition, great care was taken to provide an introductory guide to marketing management that truly reflects the modern realities of marketing."""
zikmund="""BUSINESS TRENDS IN MARKETING RESEARCH
Marketing research, like all business activity, has been strongly influenced by two major trends in business: increased globalisation, and rapid growth of the Internet and other information technologies."""
for name,text,doc in [('kotler',kotler,'kotler-keller-marketing-management-15e-global'),('zikmund',zikmund,'zikmund-marketing-research-4e-asia-pacific')]:
    out=post('/api/translate',{'text':text,'context':'','source':'en','target':'pt','mode':'editorial','docId':doc})
    print(name,json.dumps({'translatedText':out.get('translatedText'),'segments':out.get('segments'),'engine':out.get('engine')},ensure_ascii=False))