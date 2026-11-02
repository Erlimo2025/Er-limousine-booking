(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.TripDateFormat=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const zone='America/New_York';
  const pad=value=>String(value).padStart(2,'0');
  function dateParts(value){
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return null;
    const [year,month,day]=value.split('-').map(Number),leap=year%4===0&&(year%100!==0||year%400===0);
    const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
    return year>=1&&month>=1&&month<=12&&day>=1&&day<=days[month-1]?{year,month,day}:null;
  }
  function date(value){const p=dateParts(value);return p?`${pad(p.month)}/${pad(p.day)}/${String(p.year).padStart(4,'0')}`:'—';}
  function time(value){
    if(typeof value!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))return '—';
    const [hour,minute]=value.split(':').map(Number);return `${hour%12||12}:${pad(minute)} ${hour>=12?'PM':'AM'}`;
  }
  // Trip fields are already New York wall-clock values. Format their components;
  // never parse them in the browser's timezone or change the underlying ISO data.
  function trip(day,clock){return `${date(day)} · ${time(clock)} (New York time)`;}
  function fromDateInput(value){
    if(typeof value!=='string')return null;let text=value.trim();
    if(/^\d{8}$/.test(text))text=text.slice(0,2)+'/'+text.slice(2,4)+'/'+text.slice(4);
    const match=/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);if(!match)return null;
    const iso=match[3]+'-'+pad(Number(match[1]))+'-'+pad(Number(match[2]));return dateParts(iso)?iso:null;
  }
  function fromTimeInput(value){
    if(typeof value!=='string')return null;
    const match=/^(0?[1-9]|1[0-2]):([0-5]\d)\s*([AP]M)$/i.exec(value.trim());if(!match)return null;
    return pad(Number(match[1])%12+(match[3].toUpperCase()==='PM'?12:0))+':'+match[2];
  }
  function instant(value,withTime=true){
    if(value===null||value===undefined||value==='')return '—';const at=new Date(value);if(!Number.isFinite(at.getTime()))return '—';
    const options={timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',...(withTime?{hour:'numeric',minute:'2-digit',hour12:true}:{})};
    const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',options).formatToParts(at).map(part=>[part.type,part.value]));
    const day=`${p.month}/${p.day}/${p.year}`;return withTime?`${day} · ${p.hour}:${p.minute} ${p.dayPeriod} (New York time)`:day;
  }
  return Object.freeze({zone,date,time,trip,fromDateInput,fromTimeInput,instant});
});
