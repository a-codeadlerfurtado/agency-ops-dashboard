from pathlib import Path
p=Path('index.html')
s=p.read_text(encoding='utf-8')
needle="""async function getDecodedAudio(text){
  const voice=$('voice').value;"""
insert="""function trimAudioBuffer(buffer){
  const threshold=0.0035,rate=buffer.sampleRate,total=buffer.length;
  let first=0,last=total-1,found=false;
  for(let i=0;i<total&&!found;i++)for(let c=0;c<buffer.numberOfChannels;c++)if(Math.abs(buffer.getChannelData(c)[i])>threshold){first=i;found=true;break;}
  found=false;for(let i=total-1;i>=0&&!found;i--)for(let c=0;c<buffer.numberOfChannels;c++)if(Math.abs(buffer.getChannelData(c)[i])>threshold){last=i;found=true;break;}
  first=Math.max(0,first-Math.floor(rate*0.018));last=Math.min(total-1,last+Math.floor(rate*0.045));
  if(last<=first||last-first>total*0.98)return buffer;
  const out=audioContext.createBuffer(buffer.numberOfChannels,last-first+1,rate);
  for(let c=0;c<buffer.numberOfChannels;c++)out.copyToChannel(buffer.getChannelData(c).subarray(first,last+1),c);
  return out;
}
function narrationGap(text){return /[!?]$/.test(text)?0.13:/[.…]$/.test(text)?0.085:0.035;}
async function getDecodedAudio(text){
  const voice=$('voice').value;"""
if needle not in s: raise SystemExit('decoded function not found')
s=s.replace(needle,insert,1)
s=s.replace("const buffer=await audioContext.decodeAudioData(bytes.slice(0));", "const buffer=trimAudioBuffer(await audioContext.decodeAudioData(bytes.slice(0)));",1)
s=s.replace("let startAt=last?last.end:audioContext.currentTime+0.06;", "let startAt=last?(last.end+narrationGap(currentSentences[last.idx])):audioContext.currentTime+0.06;",1)
p.write_text(s,encoding='utf-8')
print('silence trim and punctuation pacing patched')